// The live engine's frozen characterization (#920): what physics matches do on stored chain arenas.
// Captured at the physics-1 checkpoint (`fixtures/behavior-physics-1.v8.gz`). Expected results are never
// updated by tests; the fixture README says when recapturing is a decision and how to do it.
import { createHash } from 'node:crypto';
import { createPhysicsGame, disposePhysics, joinGame, setInput, step, snapshot, playerView, synchronizePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';
import { attachPortalGraph, portalGraphOf } from '../shared/navigation/portal-graph.ts';
import { teleport } from '../shared/simulation/dev.ts';
import { removeItem } from '../shared/simulation/ground-items.ts';
import { atan2, cos, hypot, sin } from '../shared/math.ts';

/** The content the characterization runs: the shipped default when it was captured, named, not followed. */
export const CONTENT = 'content-7';
export const content = () => contentById(CONTENT);
export const seeds = [9, 4217];
/** The bot traces' viewers: the first contestant, the first gladiator and the directed view. */
const VIEWERS = ['c0', 'g0', 'spectator'];

/**
 * The arenas the traces run in: chain maps at the default live size, each with its portal graph,
 * which a clone drops and bots plan with (22.6). Stored in the fixture, so generation moving on
 * never moves these traces; only the simulation does.
 */
export const arenaFor = seed => {
  const map = generateLiveMap(seed, content(), DEFAULT_LIVE_ZONE_SIZE);
  return { map, graph: portalGraphOf(map) };
};
export const traceArenas = () => Object.fromEntries(seeds.map(seed => [seed, arenaFor(seed)]));

/** A fresh copy of a stored arena's map, carrying its own copy of the portal graph. */
function mapOf(arena) {
  const map = structuredClone(arena.map);
  if (arena.graph) attachPortalGraph(map, structuredClone(arena.graph));
  return map;
}

/** One whole bot match: a digest per 100 ticks over every snapshot and three projections. */
export async function botTrace(seed, arena) {
  const s = await createPhysicsGame(seed, mapOf(arena), content()), chunks = [];
  try {
    let digest = createHash('sha256');
    while (s.phase === 'live') {
      step(s);
      const frame = snapshot(s);
      // Every authoritative field, the private engine state included, on every tick.
      digest.update(JSON.stringify(frame));
      for (const id of VIEWERS) digest.update(JSON.stringify(playerView(s, frame, id)));
      if (s.tick % 100 === 0 || s.phase !== 'live') {
        chunks.push({ tick: s.tick, hash: digest.digest('hex') }); digest = createHash('sha256');
      }
    }
    return chunks;
  } finally { disposePhysics(s); }
}

/**
 * Put a player at the nearest legal spot to `target` that `fits` accepts, as a dev teleport would,
 * searching outward in rings. Throws rather than characterizing a scene that never happened.
 */
function place(s, p, target, fits = () => true) {
  for (let ring = 0; ring <= 40; ring++) {
    const steps = ring ? 16 : 1;
    for (let i = 0; i < steps; i++) {
      const x = Math.round(target.x + cos(i * Math.PI / 8) * ring * 4), y = Math.round(target.y + sin(i * Math.PI / 8) * ring * 4);
      if (fits({ x, y }) && teleport(s, p.id, x, y)) return;
    }
  }
  throw new Error(`no legal spot for ${p.id} near ${target.x},${target.y}`);
}

/**
 * One contestant and one hook gladiator driven by hand through the rules a bot match may never reach in
 * order: the input queue, carried instances, a physical drop and its pickup, charging, a door, both
 * deaths, a respawn, the hook and a hunter's ability, transit, extraction and completion. Every other
 * player stands still, and the arena's loot and traps are cleared so only the script acts.
 */
export async function scriptedTrace(arena) {
  const s = await createPhysicsGame(4217, mapOf(arena), content()), frames = [];
  try {
    const p = joinGame(s, 'human', 'contestant', 'warden', 'Characterization');
    const hunter = joinGame(s, 'hunter', 'gladiator', 'hook', 'Hook');
    synchronizePhysics(s);
    for (const other of s.players) { other.bot = false; other.input = {}; }
    for (const item of [...s.map.items]) removeItem(s, item);
    s.map.traps = [];
    synchronizePhysics(s);
    const rival = s.players.find(q => q.role === 'contestant' && q !== p);
    const g = s.players.find(q => q.role === 'gladiator' && q !== hunter);
    const capture = label => {
      const frame = snapshot(s);
      frames.push({ label, frame, views: ['human', rival.id, g.id, 'spectator'].map(id => playerView(s, frame, id)) });
    };
    const press = (who, values) => { setInput(s, who.id, { seq: who.lastSeq + 1, ...values }); step(s); };
    const carried = (id, kind, fields) => ({ kind, ...fields, instanceId: id, lineageId: id });
    capture('joined');
    p.inventory = [carried('pistol', 'weapon', { weaponType: 'pistol', ammo: 7 }), carried('med-a', 'med', { count: 2 }),
      carried('med-b', 'med', { count: 2 }), carried('shield', 'shield', { count: 1 }), carried('cell', 'cell', { charge: 0 }), null];
    p.hp = 45;
    // Two inputs arriving between two ticks: each is spent by its own tick rather than merged.
    setInput(s, p.id, { seq: p.lastSeq + 1, slot: 1, moveSlot: { from: 1, to: 2 } });
    setInput(s, p.id, { seq: p.lastSeq + 2, attack: true });
    step(s); capture('queued-first-spent');
    step(s); capture('queued-second-spent');
    press(p, { slot: 4, drop: true }); capture('drop');
    for (let i = 0; i < 30; i++) step(s);
    capture('dropped-settled');
    const dropped = s.map.items[0];
    place(s, p, dropped);
    for (let i = 0; i < 30; i++) step(s);
    capture('automatic-pickup');
    const charger = s.map.chargers[0];
    place(s, p, charger, at => hypot(at.x - charger.x, at.y - charger.y) < 40);
    press(p, { interact: true });
    for (let i = 0; i < 40; i++) step(s);
    capture('charging');
    press(p, { x: 1 }); press(p, {}); capture('charge-cancel');
    place(s, p, charger, at => hypot(at.x - charger.x, at.y - charger.y) < 40);
    press(p, { interact: true });
    for (let i = 0; i < 100; i++) step(s);
    capture('charged');
    const door = s.map.gates.find(gate => gate.kind === 'door' && !gate.locked && !gate.open);
    const centre = { x: door.x, y: door.y };
    const beside = at => hypot(at.x - centre.x, at.y - centre.y) > 30;
    place(s, p, centre, beside);
    press(p, { interact: true }); capture('door-open');
    place(s, rival, centre);
    press(p, { interact: true }); capture('door-occupied');
    place(s, rival, { x: centre.x, y: centre.y }, at => hypot(at.x - centre.x, at.y - centre.y) > 120);
    press(p, { interact: true }); capture('door-close');
    place(s, p, s.map.spawns[0]);
    place(s, rival, { x: p.x + 32, y: p.y }, at => at.x > p.x + 20);
    rival.hp = 1; p.attackCd = 0;
    press(p, { slot: 0, attack: true, aim: atan2(rival.y - p.y, rival.x - p.x) });
    for (let i = 0; i < 5; i++) press(p, {});
    capture('pvp-death');
    place(s, g, { x: p.x + 40, y: p.y }, at => at.x > p.x + 30);
    Object.assign(g, { hp: 1, maxHp: 400, level: 3, kills: 2 }); p.attackCd = 0;
    press(p, { attack: true, aim: atan2(g.y - p.y, g.x - p.x) });
    for (let i = 0; i < 5; i++) press(p, {});
    capture('gladiator-death');
    for (let i = 0; i < 400; i++) step(s);
    capture('respawn');
    place(s, hunter, { x: p.x - 150, y: p.y }, at => at.x < p.x - 100);
    press(hunter, { skill: true, aim: atan2(p.y - hunter.y, p.x - hunter.x) });
    for (let i = 0; i < 20; i++) step(s);
    capture('hook');
    place(s, g, { x: p.x + 60, y: p.y }, at => at.x > p.x + 45);
    press(g, { aim: atan2(p.y - g.y, p.x - g.x), skill: true, attack: true }); capture('ability-and-melee');
    place(s, g, s.map.stations[0]);
    press(g, { interact: true }); capture('transit');
    place(s, p, s.map.exit);
    press(p, { interact: true }); capture('extraction');
    s.slots = 0; step(s); capture('completion');
    return frames;
  } finally { disposePhysics(s); }
}
