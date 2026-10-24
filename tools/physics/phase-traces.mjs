import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, createPhysicsGame, disposePhysics, enqueuePhysicsAttachment,
  enqueuePhysicsImpulse, setInput, snapshot, step } from '../../shared/simulation.ts';
import { physicsRuntime } from '../../shared/simulation/physics-runtime.ts';
import { contentById } from '../../shared/simulation/content.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] ?? 'test-results/physics-438-phases.json');
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function fixture(contestants = 2) {
  const map = { seed: 438, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: Array.from({ length: contestants }, (_, i) => ({ x: 150 + i * 70, y: 400 })),
    hunterSpawns: [{ x: 650, y: 400 }] };
  const content = structuredClone(contentById('content-1'));
  content.roster = { contestants: Array.from({ length: contestants }, (_, i) => `C${i}`),
    gladiators: [{ name: 'G', kit: 'warden' }] };
  return { map, content };
}

function input(s, id, fields = {}) {
  if (!setInput(s, id, { seq: s.tick + 1, ...fields })) throw new Error(`input rejected for ${id}`);
}

function state(s) {
  const r = physicsRuntime(s);
  return {
    tick: s.tick, phase: s.phase, version: s.version,
    players: s.players.map(p => ({ id: p.id, x: p.x, y: p.y, hp: p.hp, shield: p.shield,
      status: p.status, stun: p.stun, attackCd: p.attackCd, selectedSlot: p.selectedSlot ?? null,
      charge: p.inventory?.find(i => i?.kind === 'cell')?.charge ?? null,
      charging: p.charging ?? null, moved: p.movedThisTick ?? 0,
      inventory: p.inventory?.map(i => i ? { kind: i.kind,
        ...(i.count !== undefined ? { count: i.count } : {}),
        ...(i.ammo !== undefined ? { ammo: i.ammo } : {}),
        ...(i.weaponType ? { weaponType: i.weaponType } : {}),
        ...(i.charge !== undefined ? { charge: i.charge } : {}) } : null) ?? null })),
    pickups: s.map.items.map(i => ({ id: i.id, kind: i.kind, x: i.x, y: i.y,
      droppedBy: i.droppedBy ?? null })),
    traps: s.map.traps.map(t => ({ id: t.id, kind: t.kind, spent: t.spent,
      cooldown: t.cooldown, targetId: t.targetId ?? null })),
    events: s.events.map(e => ({ id: e.id, tick: e.tick, text: e.text })),
    projectiles: s.projectiles.map(b => ({ id: b.id, owner: b.owner, x: b.x, y: b.y,
      dx: b.dx, dy: b.dy, life: b.life })),
    pending: r ? { spawns: r.pendingSpawns.length, impulses: r.pendingImpulses.length,
      attachments: r.pendingAttachments.length, constraints: r.world.counts().constraints } : null,
    captureSha256: digest(snapshot(s)),
  };
}

async function paired(id, label, { contestants = 2, setup = () => {}, ticks = 1,
  beforeStep = () => {}, notes = [] } = {}) {
  const { map, content } = fixture(contestants);
  const legacy = createGame(438, structuredClone(map), structuredClone(content));
  const physics = await createPhysicsGame(438, structuredClone(map), structuredClone(content));
  try {
    for (const s of [legacy, physics]) {
      for (const p of s.players) p.bot = false;
      setup(s, s === physics);
    }
    const frames = [{ boundary: 'initial', legacy: state(legacy), physics: state(physics) }];
    for (let n = 1; n <= ticks; n++) {
      beforeStep(legacy, false, n);
      beforeStep(physics, true, n);
      frames.push({ boundary: `before tick ${n}`, legacy: state(legacy), physics: state(physics) });
      step(legacy); step(physics);
      frames.push({ boundary: `after tick ${n}`, legacy: state(legacy), physics: state(physics) });
    }
    return { id, label, notes, frames };
  } finally { disposePhysics(physics); }
}

const scenarios = [];
scenarios.push(await paired('utility', 'Bot utility before movement', { contestants: 1,
  setup: s => {
    const c = s.players[0]; c.bot = true; c.hp = 40;
    c.inventory[0] = { kind: 'med', count: 1 };
    c.inventory[1] = { kind: 'weapon', weaponType: 'pistol', ammo: 2 };
  },
  notes: ['Legacy botInput applies healing while deciding. Physics phase 2 collects it; phase 3 commits it.'] }));

scenarios.push(await paired('stun', 'Early roster stun versus shared movement phase', { contestants: 1,
  setup: s => {
    const c = s.players[0], g = s.players[1]; c.x = 300; g.x = 350;
    s.players.reverse(); input(s, g.id, { skill: true }); input(s, c.id, { x: 1 });
  }, ticks: 2,
  beforeStep: (s, _physics, tick) => { if (tick === 2) input(s, 'c0', { x: 1 }); },
  notes: ['Legacy reversed roster lets g0 stun c0 before c0 moves. Physics stun affects the following motor tick.'] }));

scenarios.push(await paired('charging', 'Blocked request and next-tick push', { contestants: 1,
  setup: s => {
    const c = s.players[0]; c.x = 12; c.inventory[0] = { kind: 'cell', charge: 0 };
    c.charging = 'charger'; s.map.chargers = [{ id: 'charger', x: 40, y: 400 }];
    input(s, c.id, { x: -1 });
  }, ticks: 2,
  beforeStep: (s, physics, tick) => { if (tick === 2 && physics) enqueuePhysicsImpulse(s, 'actor:c0', { x: 100, y: 0 }); },
  notes: ['Legacy cancels charge from requested movement on tick 1.',
    'Physics preserves charge at a blocked boundary, then a queued impulse moves c0 on tick 2.',
    'Legacy has no impulse path; the tick-2 legacy frame is a no-input comparison.'] }));

scenarios.push(await paired('pickup', 'Competing final-position pickup', { contestants: 2,
  setup: s => {
    s.players[0].x = 340; s.players[1].x = 350;
    s.map.items = [{ id: 'prize', kind: 'med', x: 345, y: 400 }];
    s.players.reverse();
  },
  notes: ['Reversed legacy roster awards the item to c1. Physics stable actor ID awards it to c0.'] }));

scenarios.push(await paired('traps', 'Impulse movement triggers a mine after pickups', { contestants: 1,
  setup: s => {
    const c = s.players[0]; c.x = 300;
    s.map.items = [{ id: 'med', kind: 'med', x: 300, y: 400 }];
    s.map.traps = [{ id: 'mine', kind: 'mine', x: 300, y: 400, homeX: 300, homeY: 400,
      heading: 0, offset: 0, cooldown: 0, spent: false }];
  },
  beforeStep: (s, physics) => { if (physics) enqueuePhysicsImpulse(s, 'actor:c0', { x: 100, y: 0 }); },
  notes: ['Physics mine reads actual impulse path distance. Legacy has no impulse path and sees a stationary actor.'] }));

scenarios.push(await paired('projectiles', 'Actor bullet and delayed turret bullet', { contestants: 1,
  setup: s => {
    const c = s.players[0]; c.x = 300; c.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 2 };
    s.map.traps = [{ id: 'turret', kind: 'turret', x: 260, y: 400, homeX: 260, homeY: 400,
      heading: 0, offset: 0, cooldown: 0, spent: false }];
    input(s, c.id, { attack: true, aim: 0 });
  }, ticks: 2,
  notes: ['Actor bullet enters physics phase 4 on tick 1.',
    'Legacy turret bullet advances in its firing tick; physics turret bullet waits in pendingSpawns.'] }));

scenarios.push(await paired('simultaneous', 'Equal-time projectile deaths and item conservation', { contestants: 2,
  setup: s => {
    const [a, b] = s.players; a.x = 300; a.hp = 5; b.x = 335; b.hp = 5;
    for (const p of [a, b]) p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 1 };
    s.players.reverse(); input(s, a.id, { attack: true, aim: 0 }); input(s, b.id, { attack: true, aim: Math.PI });
  },
  notes: ['Both actor bullets are admitted before phase 4; equal-time physical impacts can trade kills.',
    'The no-trade tie in 29.2 applies to finalized-pose attacks, not already admitted physical impacts.'] }));

scenarios.push(await paired('pending', 'Next-boundary impulse and attachment', { contestants: 2,
  setup: s => { s.players[0].x = 300; s.players[0].y = 350; s.players[1].x = 360; s.players[1].y = 350; },
  beforeStep: (s, physics) => {
    if (!physics) return;
    enqueuePhysicsImpulse(s, 'actor:c0', { x: 100, y: 0 });
    enqueuePhysicsAttachment(s, { id: 'rope', a: 'actor:c0', b: 'actor:c1', maxDistance: 80 });
  },
  notes: ['Physics queue is visible in the before-tick capture, then consumed at the boundary.',
    'Legacy has no impulse or attachment path and receives no surrogate action.'] }));

scenarios.push(await paired('capture', 'Authoritative frame capture after completed phases', { contestants: 1,
  setup: s => {
    const c = s.players[0]; c.x = 730; c.inventory[0] = { kind: 'cell', charge: s.content.cellChargeTicks };
    s.slots = 1; input(s, c.id, { interact: true });
  },
  notes: ['A final extraction consumes the last slot and yields one finished match and captured tick.',
    'captureSha256 hashes each public authoritative snapshot after the complete tick.',
    'The physics backend declares exactCheckpoint unsupported; these hashes do not claim backend restore.'] }));

const sourceFiles = ['shared/simulation.ts', 'shared/simulation/phased.ts',
  'shared/simulation/physics-projectiles.ts', 'shared/simulation/physics-runtime.ts',
  'shared/simulation/bots.ts', 'shared/physics/world.ts', 'shared/physics/types.ts',
  'shared/simulation/physics-geometry.ts', 'shared/simulation/visibility.ts', 'tools/physics/phase-traces.mjs'];
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async path =>
  [path, digest(await readFile(resolve(root, path)))])));
const fixtureVariants = [1, 2].map(contestants => {
  const { map, content } = fixture(contestants);
  return { contestants, map, content, sha256: digest({ map, content }) };
});
const report = { schema: 'physics-438-phase-traces-1', provenance: {
  baseCommit: 'd668586', node: process.version, generatedBy: 'tools/physics/phase-traces.mjs',
  fixture: { seed: 438, map: '800x800 full 8x8 playable mask; no obstacles or gates',
    content: 'content-1 tuning with one or two contestants and one warden gladiator',
    fixedTickHz: 20, physicsSubsteps: 4, variants: fixtureVariants }, sources,
  exactBackendRestore: 'unsupported' }, scenarios };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${output}\n${scenarios.length} paired scenarios, ${scenarios.reduce((sum, s) => sum + s.frames.length, 0)} boundaries\n`);
