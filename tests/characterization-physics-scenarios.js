// The live engine's frozen characterization (#920): what physics matches do on stored chain arenas.
// Captured at the physics-1 checkpoint (`fixtures/behavior-physics-1.v8.gz`). Expected results are never
// updated by tests; the fixture README says when recapturing is a decision and how to do it.
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, joinGame, setInput, snapshot, playerView } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { contentById } from '../shared/simulation/content.ts';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';
import { attachPortalGraph, portalGraphOf } from '../shared/navigation/portal-graph.ts';
import { canOccupy } from '../shared/movement.ts';
import { actorRadius } from '../shared/simulation/actor-physics.ts';
import { removeItem } from '../shared/simulation/ground-items.ts';
import { atan2, cos, hypot, sin } from '../shared/math.ts';
import { identifyItems } from './helpers/item-identity.js';

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
export async function botTrace(seed, arena, observe = () => {}) {
  const s = await createGame(seed, mapOf(arena), content()), chunks = [];
  try {
    let digest = createHash('sha256');
    const { match } = startGame(s);
    digest.update(JSON.stringify(match.snapshot()));
    while (s.phase === 'live') {
      const completed = stepGame(s);
      const frame = snapshot(s);
      observe(s, frame);
      // Opening state plus each core change list covers authority; also pin its public frame and views.
      digest.update(JSON.stringify(completed));
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
function place(s, boundary, p, target, fits = () => true) {
  const radius = actorRadius(s, p);
  for (let ring = 0; ring <= 40; ring++) {
    const steps = ring ? 16 : 1;
    for (let i = 0; i < steps; i++) {
      const x = Math.round(target.x + cos(i * Math.PI / 8) * ring * 4), y = Math.round(target.y + sin(i * Math.PI / 8) * ring * 4);
      if (!fits({ x, y }) || !canOccupy(s.map, x, y, radius)
        || s.players.some(q => q !== p && q.status === 'active' && hypot(x - q.x, y - q.y) < radius + actorRadius(s, q))) continue;
      if (boundary.teleport(p.id, [x, y]) && stepGame(s)?.discontinuities.some(d => d.kind === 'devWarped')) return;
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
export async function scriptedTrace(arena, observe = () => {}) {
  const s = await createGame(4217, mapOf(arena), content()), frames = [];
  try {
    const p = joinGame(s, 'human', 'contestant', 'warden', 'Characterization');
    const hunter = joinGame(s, 'hunter', 'gladiator', 'hook', 'Hook');
    for (const other of s.players) { other.bot = false; other.input = {}; }
    for (const item of [...s.items]) removeItem(s, item);
    s.traps = [];
    s.slots = 1;
    const rival = s.players.find(q => q.role === 'contestant' && q !== p);
    const g = s.players.find(q => q.role === 'gladiator' && q !== hunter);
    rival.hp = 1;
    Object.assign(g, { hp: 1, maxHp: 400, level: 3, kills: 2 });
    const capture = label => {
      const frame = snapshot(s);
      observe(s, frame);
      frames.push({ label, frame, core: match.snapshot(), views: ['human', rival.id, g.id, 'spectator'].map(id => playerView(s, frame, id)) });
    };
    const carried = (id, kind, fields) => ({ kind, ...fields, instanceId: id, lineageId: id });
    p.inventory = [carried('pistol', 'weapon', { weaponType: 'pistol', ammo: 7 }), carried('med-a', 'med', { count: 2 }),
      carried('med-b', 'med', { count: 2 }), carried('shield', 'shield', { count: 1 }), carried('cell', 'cell', { charge: 0 }), null];
    identifyItems(s);
    p.hp = 45;
    const { match, boundary } = startGame(s);
    const press = (who, values) => {
      assert.ok(setInput(s, who.id, { seq: who.lastSeq + 1, ...values }));
      return stepGame(s);
    };
    const advance = ticks => { for (let i = 0; i < ticks; i++) stepGame(s); };
    const warp = (who, target, fits) => place(s, boundary, who, target, fits);
    capture('joined');
    // Two inputs arriving between two ticks: each is spent by its own tick rather than merged.
    setInput(s, p.id, { seq: p.lastSeq + 1, slot: 1, moveSlot: { from: 1, to: 2 } });
    setInput(s, p.id, { seq: p.lastSeq + 2, attack: true });
    stepGame(s); assert.equal(p.lastSeq, 0); capture('queued-first-spent');
    stepGame(s); assert.equal(p.lastSeq, 1); capture('queued-second-spent');
    // Selection and dropping spend separate weapon-slot actions under R1.
    press(p, { slot: 4 }); press(p, { drop: true });
    assert.equal(p.inventory[4], null); capture('drop');
    advance(30);
    capture('dropped-settled');
    const dropped = s.items[0];
    warp(p, dropped);
    advance(30);
    assert.ok(p.inventory.some(item => item?.kind === 'cell'));
    capture('automatic-pickup');
    const charger = s.map.chargers[0];
    warp(p, charger, at => hypot(at.x - charger.x, at.y - charger.y) < 40);
    press(p, { interact: true });
    advance(40);
    assert.ok(p.charging);
    capture('charging');
    press(p, { x: 1 }); press(p, {}); assert.ok(!p.charging); capture('charge-cancel');
    warp(p, charger, at => hypot(at.x - charger.x, at.y - charger.y) < 40);
    press(p, { interact: true });
    advance(100);
    assert.equal(p.inventory.find(item => item?.kind === 'cell').charge, 100);
    capture('charged');
    const door = s.map.gates.find(gate => gate.kind === 'door' && !gate.locked && !gate.open);
    const centre = { x: door.x, y: door.y };
    const beside = at => hypot(at.x - centre.x, at.y - centre.y) > 30;
    const interactDoor = () => press(p, { interact: true, target: { kind: 'gate', gateIdx: s.gates.indexOf(door) } });
    warp(p, centre, beside);
    interactDoor(); assert.ok(door.open); capture('door-open');
    warp(rival, centre);
    interactDoor(); assert.ok(door.open); capture('door-occupied');
    warp(rival, centre, at => hypot(at.x - centre.x, at.y - centre.y) > 120);
    interactDoor(); assert.ok(!door.open); capture('door-close');
    warp(p, s.map.spawns[0]);
    warp(rival, { x: p.x + 32, y: p.y }, at => at.x > p.x + 20);
    press(p, { slot: 0 });
    press(p, { attack: true, aim: atan2(rival.y - p.y, rival.x - p.x) });
    for (let i = 0; i < 5; i++) press(p, {});
    assert.equal(rival.status, 'eliminated');
    capture('pvp-death');
    warp(g, { x: p.x + 40, y: p.y }, at => at.x > p.x + 30);
    advance(p.attackCd);
    press(p, { attack: true, aim: atan2(g.y - p.y, g.x - p.x) });
    for (let i = 0; i < 5; i++) press(p, {});
    assert.equal(g.status, 'respawning'); capture('gladiator-death');
    advance(400);
    assert.equal(g.status, 'active');
    capture('respawn');
    warp(hunter, { x: p.x - 150, y: p.y }, at => at.x < p.x - 100);
    press(hunter, { skill: true, aim: atan2(p.y - hunter.y, p.x - hunter.x) });
    for (let i = 0; i < 20 && !match.snapshot().state.hooks.some(h => h.hook.phase.kind === 'pulling'); i++) stepGame(s);
    assert.ok(match.snapshot().state.hooks.some(h => h.hook.phase.kind === 'pulling'));
    capture('hook');
    warp(g, { x: p.x + 60, y: p.y }, at => at.x > p.x + 45);
    const ability = press(g, { aim: atan2(p.y - g.y, p.x - g.x), skill: true, attack: true });
    assert.ok(ability.changes.events.length >= 2);
    capture('ability-and-melee');
    warp(g, s.map.stations[0]);
    const from = { x: g.x, y: g.y };
    press(g, { interact: true });
    assert.ok(hypot(g.x - from.x, g.y - from.y) > 100);
    capture('transit');
    warp(p, s.map.exit);
    press(p, { interact: true }); capture('extraction');
    assert.equal(p.status, 'escaped');
    assert.equal(s.phase, 'finished'); capture('completion');
    return frames;
  } finally { disposePhysics(s); }
}
