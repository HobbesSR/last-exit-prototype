import { createPhysicsGame, disposePhysics, enqueuePhysicsImpulse, setInput, snapshot, step } from '/shared/simulation.ts';
import { contentById } from '/shared/simulation/content.ts';
import { physicsRuntime } from '/shared/simulation/physics-runtime.ts';
import { closedGateShapes, firstContact, staticShapes } from '/shared/simulation/swept.ts';
import { circle, polygon } from '/shared/shape.ts';

export const LAB_FORMAT = 'last-exit-physics-lab-1';
export const MAX_TICKS = 2400;
const MAX_ACTIONS = 4800;
export const SCENES = Object.freeze({
  A: { name: 'A · character collision and crowd', spawns: [{ x: 240, y: 400 }, { x: 350, y: 400 }, { x: 460, y: 400 }, { x: 350, y: 500 }],
    obstacles: [{ id: 'doorway-top', x: 540, y: 0, w: 20, h: 370 }, { id: 'doorway-bottom', x: 540, y: 430, w: 20, h: 370 }], props: [], hook: false },
  B: { name: 'B · physical prop', spawns: [{ x: 220, y: 400 }], props: [{ id: 'crate', profile: 'crate', x: 370, y: 400, angle: Math.PI / 8 }], hook: false },
  C: { name: 'C · hook', spawns: [{ x: 320, y: 400 }], props: [], hook: true },
});

export function sceneConfig(scene = 'A', seed = 449, tuning = {}) {
  if (!Object.hasOwn(SCENES, scene) || !Number.isSafeInteger(seed) || seed < 0) throw new RangeError('invalid lab scene or seed');
  const spec = SCENES[scene];
  const map = { seed, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: structuredClone(spec.obstacles ?? []), gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    physicsProps: structuredClone(spec.props), entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: structuredClone(spec.spawns), hunterSpawns: spec.hook ? [{ x: 120, y: 400 }] : [],
  };
  const content = structuredClone(contentById('content-physics-8'));
  content.roster = { contestants: spec.spawns.map((_, i) => `C${i + 1}`),
    gladiators: spec.hook ? [{ name: 'Hook', kit: 'hook' }] : [] };
  content.discovery = false;
  for (const field of ['acceleration', 'braking', 'maxImpulse', 'maxSpeed']) {
    if (Object.hasOwn(tuning, field)) content.actorPhysics[field] = Number(tuning[field]);
  }
  for (const role of ['contestant', 'gladiator']) {
    if (Object.hasOwn(tuning, `${role}BodyRadius`)) content.actorPhysics.geometry[role].bodyRadius = Number(tuning[`${role}BodyRadius`]);
  }
  return { scene, seed, map, content };
}

export class PhysicsLab {
  constructor() { this.game = null; this.config = null; this.trace = []; this.frames = []; this.contacts = []; this.forces = []; this.selected = null; this.lastImpulse = null; this.lastCast = null; }
  async start(config) {
    const copy = structuredClone(config);
    if (copy.content?.id !== 'content-physics-8') throw new RangeError('lab requires content-physics-8');
    const next = await createPhysicsGame(copy.seed, copy.map, copy.content);
    this.dispose();
    next.players.forEach(player => { player.bot = false; });
    this.game = next;
    this.config = copy;
    this.selected = next.players.find(player => player.role === 'contestant')?.id ?? next.players[0]?.id;
    this.trace = [];
    this.lastImpulse = null;
    this.lastCast = null;
    this.frames = [structuredClone(snapshot(next))];
    this.contacts = [[]];
    this.forces = [[]];
    return this.frame();
  }
  frame() { return this.frames.at(-1); }
  tick(input = {}) {
    if (!this.game) throw new Error('start the lab first');
    if (this.game.tick >= MAX_TICKS) throw new RangeError(`recording limit reached (${MAX_TICKS} ticks)`);
    if (this.trace.length >= MAX_ACTIONS) throw new RangeError('recording action limit reached');
    const player = this.game.players.find(p => p.id === this.selected);
    if (!player) throw new Error('selected actor is unavailable');
    const command = { seq: this.game.tick + 1, x: Number(input.x) || 0, y: Number(input.y) || 0,
      aim: Number(input.aim) || 0, skill: !!input.skill, attack: !!input.attack,
      interact: !!input.interact };
    setInput(this.game, player.id, command);
    step(this.game);
    this.trace.push({ tick: this.game.tick, actorId: player.id, input: command });
    this.frames.push(structuredClone(snapshot(this.game)));
    const world = physicsRuntime(this.game).world;
    this.contacts.push(structuredClone(world.debugContacts()));
    this.forces.push(structuredClone(world.debugForces()));
    return this.frame();
  }
  impulse(value) {
    if (!this.game) throw new Error('start the lab first');
    if (this.trace.length >= MAX_ACTIONS) throw new RangeError('recording action limit reached');
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new RangeError('finite impulse required');
    const actorId = this.selected;
    if (!this.game.players.some(p => p.id === actorId)) throw new RangeError('selected actor is unavailable');
    enqueuePhysicsImpulse(this.game, `actor:${actorId}`, value);
    this.trace.push({ kind: 'impulse', tick: this.game.tick, actorId, value: { ...value } });
    this.lastImpulse = { actorId, value: { ...value } };
  }
  /** Read-only solid-geometry query. This neither advances gameplay nor queues a solver command. */
  cast(aim) {
    if (!this.game) throw new Error('start the lab first');
    if (this.trace.length >= MAX_ACTIONS) throw new RangeError('recording action limit reached');
    if (!Number.isFinite(aim)) throw new RangeError('finite cast aim required');
    const actorId = this.selected, player = this.game.players.find(p => p.id === actorId);
    const body = this.frame().bodies.find(entry => entry.id === `actor:${actorId}`);
    if (!player || !body) throw new RangeError('selected actor is unavailable');
    const from = { x: body.x, y: body.y };
    const to = { x: from.x + 200 * Math.cos(aim), y: from.y + 200 * Math.sin(aim) };
    const radius = this.game.content.actorPhysics.geometry[player.role].bodyRadius;
    const world = physicsRuntime(this.game).world;
    const props = world.snapshot({ includeStatic: false }).bodies
      .filter(entry => entry.spec.kind === 'prop' && entry.spec.collisionProfile !== 'loot');
    const propShapes = props.map(({ spec, transform }) => {
      if (spec.shape.kind === 'circle') return circle(transform.x, transform.y, spec.shape.radius);
      const vertices = spec.shape.kind === 'box'
        ? [{ x: -spec.shape.hx, y: -spec.shape.hy }, { x: spec.shape.hx, y: -spec.shape.hy },
          { x: spec.shape.hx, y: spec.shape.hy }, { x: -spec.shape.hx, y: spec.shape.hy }]
        : spec.shape.vertices;
      const c = Math.cos(transform.angle), s = Math.sin(transform.angle);
      return polygon(transform.x, transform.y, vertices.map(point =>
        ({ x: point.x * c - point.y * s, y: point.x * s + point.y * c })));
    });
    const fractionValue = firstContact(from, to,
      [...staticShapes(this.game.map, false), ...closedGateShapes(this.game.map.gates), ...propShapes], radius);
    const fraction = Number.isFinite(fractionValue) ? fractionValue : null;
    const point = fraction === null ? { ...to } :
      { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction };
    const result = { tick: this.game.tick, actorId, from, to, radius, fraction, point };
    this.trace.push({ kind: 'cast', aim, result });
    this.lastCast = result;
    return structuredClone(result);
  }
  export() {
    if (!this.game) throw new Error('start the lab first');
    return structuredClone({ format: LAB_FORMAT, scene: this.config.scene, seed: this.config.seed,
      map: this.config.map, content: this.config.content, selected: this.selected,
      trace: this.trace, frames: this.frames, contacts: this.contacts, forces: this.forces });
  }
  async import(record) {
    if (record?.format !== LAB_FORMAT || !Array.isArray(record.trace) || !Array.isArray(record.frames)
      || record.trace.length > MAX_ACTIONS || record.frames.length > MAX_TICKS + 1) throw new RangeError('invalid lab recording');
    await this.start({ scene: record.scene, seed: record.seed, map: record.map, content: record.content });
    for (const action of record.trace) {
      if (action.kind === 'cast') {
        if (action.result?.tick !== this.game.tick || !this.game.players.some(p => p.id === action.result.actorId)) throw new RangeError('invalid ordered cast');
        this.selected = action.result.actorId;
        if (JSON.stringify(this.cast(action.aim)) !== JSON.stringify(action.result)) throw new Error('rerun differs from diagnostic cast');
        continue;
      }
      if (action.kind === 'impulse') {
        if (action.tick !== this.game.tick || !this.game.players.some(p => p.id === action.actorId)) throw new RangeError('invalid ordered impulse');
        this.selected = action.actorId;
        this.impulse(action.value);
        continue;
      }
      if (action.tick !== this.game.tick + 1 || !this.game.players.some(p => p.id === action.actorId)) throw new RangeError('invalid ordered trace');
      this.selected = action.actorId;
      this.tick(action.input);
    }
    if (JSON.stringify(this.frames) !== JSON.stringify(record.frames)) throw new Error('rerun differs from retained frames');
    if (!this.game.players.some(p => p.id === record.selected)) throw new RangeError('invalid selected actor');
    this.selected = record.selected;
    return this.frame();
  }
  dispose() { if (this.game) disposePhysics(this.game); this.game = null; }
}
