import { createPhysicsGame, disposePhysics, enqueuePhysicsImpulse, setInput, snapshot, step } from '/shared/simulation.ts';
import { contentById } from '/shared/simulation/content.ts';
import { physicsRuntime } from '/shared/simulation/physics-runtime.ts';
import { HZ } from '/shared/simulation/rules.ts';
import { firstContact, solidBlockers } from '/shared/simulation/swept.ts';
import { SQUISH, squishShell, stepSquish } from './squish-shell.js';

export const LAB_FORMAT = 'last-exit-physics-lab-1';
export const TICK_HZ = HZ;
export const TICK_MS = 1000 / HZ;
export const MAX_TICKS = 2400;
const MAX_ACTIONS = 4800;
// Slits of 140 down to 28 units, so the squish shell flattens a little more at each. A contestant core is 22.6 wide.
const SLITS = [140, 90, 60, 44, 34, 28].flatMap((gap, i) => {
  const x = 180 + i * 80, top = 400 - gap / 2, bottom = 400 + gap / 2;
  return [{ id: `slit-${i}-top`, x, y: 0, w: 40, h: top }, { id: `slit-${i}-bottom`, x, y: bottom, w: 40, h: 800 - bottom }];
});
export const SCENES = Object.freeze({
  A: { name: 'A · character collision and crowd', spawns: [{ x: 240, y: 400 }, { x: 350, y: 400 }, { x: 460, y: 400 }, { x: 350, y: 500 }],
    obstacles: [{ id: 'doorway-top', x: 540, y: 0, w: 20, h: 370 }, { id: 'doorway-bottom', x: 540, y: 430, w: 20, h: 370 }], props: [], hook: false },
  B: { name: 'B · physical prop', spawns: [{ x: 220, y: 400 }], props: [{ id: 'crate', profile: 'crate', x: 370, y: 400, angle: Math.PI / 8 }], hook: false },
  C: { name: 'C · hook', spawns: [{ x: 320, y: 400 }], props: [], hook: true },
  D: { name: 'D · squeeze gauntlet', spawns: [{ x: 100, y: 400 }, { x: 100, y: 450 }], obstacles: SLITS, props: [], hook: false },
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
  if (Object.hasOwn(tuning, 'hookCooldown')) {
    // hookSkill reads hook.cooldownTicks; the kit table repeats the number, so keep the exported content consistent.
    content.hook.cooldownTicks = content.kits.hook.cooldown = Number(tuning.hookCooldown);
  }
  for (const role of ['contestant', 'gladiator']) {
    if (Object.hasOwn(tuning, `${role}BodyRadius`)) content.actorPhysics.geometry[role].bodyRadius = Number(tuning[`${role}BodyRadius`]);
  }
  return { scene, seed, map, content };
}

export class PhysicsLab {
  constructor() {
    this.game = null; this.config = null; this.trace = []; this.frames = []; this.contacts = []; this.forces = []; this.selected = null; this.lastImpulse = null; this.lastCast = null;
    // Squish is a read-only view of the latest frame: outside the recording, rederived on every tick and on import.
    this.squishTuning = { thickness: SQUISH.thickness, holdTicks: SQUISH.holdTicks };
    this.shells = new Map(); this.squishState = new Map(); this.squishEvents = [];
  }
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
    this.squishState = new Map(); this.squishEvents = [];
    this.updateShells(false);
    return this.frame();
  }
  frame() { return this.frames.at(-1); }
  /** Rebuild every active actor's shell from the current world; `advance` also steps the crush rule one tick. */
  updateShells(advance) {
    const blockers = solidBlockers(this.game), geometry = this.game.content.actorPhysics.geometry;
    const actors = this.frame().bodies.filter(body => body.kind === 'actor').flatMap(body => {
      const player = this.game.players.find(p => p.id === body.actorId);
      return player?.status === 'active' ? [{ id: body.actorId, x: body.x, y: body.y, radius: geometry[player.role].bodyRadius }] : [];
    });
    this.shells = new Map();
    for (const actor of actors) {
      const shell = squishShell(actor, actor.radius, this.squishTuning.thickness, blockers, actors.filter(other => other !== actor));
      let state = this.squishState.get(actor.id) ?? { held: 0, crushed: false };
      if (advance) {
        const next = stepSquish(state, shell.squeeze, { ...SQUISH, holdTicks: this.squishTuning.holdTicks });
        if (next.crushed !== state.crushed)
          this.squishEvents.push({ tick: this.game.tick, actorId: actor.id, type: next.crushed ? 'crushed' : 'recovered' });
        state = next; this.squishState.set(actor.id, state);
      }
      this.shells.set(actor.id, { ...shell, ...state, x: actor.x, y: actor.y, radius: actor.radius });
    }
  }
  setSquishTuning(tuning) {
    for (const key of ['thickness', 'holdTicks']) if (Number.isFinite(tuning[key]) && tuning[key] > 0) this.squishTuning[key] = tuning[key];
    if (this.game) this.updateShells(false);
  }
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
    this.updateShells(true);
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
    const fractionValue = firstContact(from, to, solidBlockers(this.game), radius);
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
