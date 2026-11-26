// The live engine's frozen characterization (#920): what physics matches do on stored chain arenas.
// Captured at the physics-1 checkpoint (`fixtures/behavior-physics-1.v8.gz`). Expected results are never
// updated by tests; the fixture README says when recapturing is a decision and how to do it.
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, joinGame, setInput, snapshot, stateOf, playerView } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { contentById } from '../shared/simulation/content.ts';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';
import { attachPortalGraph, portalGraphOf } from '../shared/navigation/portal-graph.ts';
import { canOccupy, gatesClear } from '../shared/movement.ts';
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
export async function botTrace(seed, arena, observe = () => {}, prepareMap = map => ({ map })) {
  const { map, release, navigation } = await prepareMap(mapOf(arena)), chunks = [];
  let s;
  try {
    s = await createGame(seed, map, content());
    let digest = createHash('sha256');
    const { match } = startGame(s, navigation);
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
  } finally {
    try { if (s) disposePhysics(s); } finally { release?.(); }
  }
}

/**
 * Put a player at the nearest legal spot to `target` that `fits` accepts, as a dev teleport would,
 * searching outward in rings. Throws rather than characterizing a scene that never happened.
 */
function place(s, boundary, p, target, fits = () => true) {
  // The others' places and the gates as of the last completed tick, read again after each attempt steps the match.
  let state, players, gates;
  const read = () => {
    state = stateOf(s); players = state.players;
    gates = { gates: s.map.gates.map((g, i) => ({ ...g, ...state.gates[i] })) };
  };
  read();
  const radius = actorRadius(s, p);
  for (let ring = 0; ring <= 40; ring++) {
    const steps = ring ? 16 : 1;
    for (let i = 0; i < steps; i++) {
      const x = Math.round(target.x + cos(i * Math.PI / 8) * ring * 4), y = Math.round(target.y + sin(i * Math.PI / 8) * ring * 4);
      if (!fits({ x, y }) || !canOccupy(s.map, x, y, radius, true) || !gatesClear(gates, x, y, radius)
        || s.players.some((q, i) => q !== p && players[i].status === 'active'
          && hypot(x - players[i].x, y - players[i].y) < radius + actorRadius(s, q))) continue;
      if (!boundary.teleport(p.id, [x, y])) continue;
      const warped = stepGame(s)?.discontinuities.some(d => d.kind === 'devWarped');
      if (warped) return;
      read();
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
    // What the match did, by roster place: the players above are the arrangement (docs/27.2 "Test API").
    const now = who => stateOf(s).players[s.players.indexOf(who)];
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
    assert.equal(now(p).inventory[4], null); capture('drop');
    advance(30);
    capture('dropped-settled');
    const dropped = stateOf(s).items[0];
    warp(p, dropped);
    advance(30);
    assert.ok(now(p).inventory.some(item => item?.kind === 'cell'));
    capture('automatic-pickup');
    const charger = s.map.chargers[0];
    warp(p, charger, at => hypot(at.x - charger.x, at.y - charger.y) < 40);
    press(p, { interact: true });
    advance(40);
    assert.ok(now(p).charging);
    capture('charging');
    press(p, { x: 1 }); press(p, {}); assert.ok(!now(p).charging); capture('charge-cancel');
    warp(p, charger, at => hypot(at.x - charger.x, at.y - charger.y) < 40);
    press(p, { interact: true });
    advance(100);
    assert.equal(now(p).inventory.find(item => item?.kind === 'cell').charge, 100);
    capture('charged');
    const door = s.map.gates.find(gate => gate.kind === 'door' && !gate.locked && !gate.open);
    const centre = { x: door.x, y: door.y };
    const beside = at => hypot(at.x - centre.x, at.y - centre.y) > 30;
    const doorIdx = s.gates.indexOf(door), doorOpen = () => stateOf(s).gates[doorIdx].open;
    const interactDoor = () => press(p, { interact: true, target: { kind: 'gate', gateIdx: doorIdx } });
    warp(p, centre, beside);
    interactDoor(); assert.ok(doorOpen()); capture('door-open');
    warp(rival, centre);
    interactDoor(); assert.ok(doorOpen()); capture('door-occupied');
    warp(rival, centre, at => hypot(at.x - centre.x, at.y - centre.y) > 120);
    interactDoor(); assert.ok(!doorOpen()); capture('door-close');
    warp(p, s.map.spawns[0]);
    // A fit reads where the player stands when it is asked, as the attempts step the match.
    { const a = now(p); warp(rival, { x: a.x + 32, y: a.y }, at => at.x > now(p).x + 20); }
    press(p, { slot: 0 });
    { const [a, b] = [now(p), now(rival)]; press(p, { attack: true, aim: atan2(b.y - a.y, b.x - a.x) }); }
    for (let i = 0; i < 5; i++) press(p, {});
    assert.equal(now(rival).status, 'eliminated');
    capture('pvp-death');
    { const a = now(p); warp(g, { x: a.x + 40, y: a.y }, at => at.x > now(p).x + 30); }
    advance(now(p).attackCd);
    { const [a, b] = [now(p), now(g)]; press(p, { attack: true, aim: atan2(b.y - a.y, b.x - a.x) }); }
    for (let i = 0; i < 5; i++) press(p, {});
    assert.equal(now(g).status, 'respawning'); capture('gladiator-death');
    advance(400);
    assert.equal(now(g).status, 'active');
    capture('respawn');
    { const a = now(p); warp(hunter, { x: a.x - 150, y: a.y }, at => at.x < now(p).x - 100); }
    { const [a, b] = [now(hunter), now(p)]; press(hunter, { skill: true, aim: atan2(b.y - a.y, b.x - a.x) }); }
    for (let i = 0; i < 20 && !match.snapshot().state.hooks.some(h => h.hook.phase.kind === 'pulling'); i++) stepGame(s);
    assert.ok(match.snapshot().state.hooks.some(h => h.hook.phase.kind === 'pulling'));
    capture('hook');
    { const a = now(p); warp(g, { x: a.x + 60, y: a.y }, at => at.x > now(p).x + 45); }
    const ability = (([a, b]) => press(g, { aim: atan2(b.y - a.y, b.x - a.x), skill: true, attack: true }))([now(g), now(p)]);
    assert.ok(ability.changes.events.length >= 2);
    capture('ability-and-melee');
    warp(g, s.map.stations[0]);
    const from = { x: now(g).x, y: now(g).y };
    press(g, { interact: true });
    assert.ok(hypot(now(g).x - from.x, now(g).y - from.y) > 100);
    capture('transit');
    warp(p, s.map.exit);
    press(p, { interact: true }); capture('extraction');
    assert.equal(now(p).status, 'escaped');
    assert.equal(s.phase, 'finished'); capture('completion');
    return frames;
  } finally { disposePhysics(s); }
}
