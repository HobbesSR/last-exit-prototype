import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { estimatedFrontX, hasEvidenceFurtherRight, noteHunterTarget, sweepTarget, transitPlan } from '../shared/simulation/hunting.ts';
import { hearShot } from '../shared/simulation/hearing.ts';
import { visibleTo } from '../shared/simulation/visibility.ts';
import { arena } from './helpers/arena.js';
import { gunfight, run, stagePhysics } from './helpers/scenario.js';

// Gladiator bots sweep regions ahead of the wall and take transit when it is quicker (#683, #681, 14 "Gladiator bots").

test('content-11 is content-10 with gladiators sweeping and transiting', () => {
  const { id, hunting, ...eleven } = contentById('content-11'), { id: ten, ...rest } = contentById('content-10');
  assert.deepEqual([id, ten, hunting, eleven], ['content-11', 'content-10', 'sweep', rest]);
});

test('content-12 is content-11 with front-estimated coarse sweeping, repulsion and exit goalkeeping', () => {
  const { id, hunting, ...twelve } = contentById('content-12'), { id: eleven, hunting: _, ...rest } = contentById('content-11');
  assert.deepEqual([id, eleven, hunting, twelve], ['content-12', 'content-11', 'front', rest]);
});

test('a transit is planned only when walking to a station, transiting and walking on is quicker', () => {
  const stations = [{ id: 'a', x: 600, y: 0 }, { id: 'b', x: 8000, y: 0 }, { id: 'c', x: 4000, y: 3000 }];
  const s = { map: { stations }, hazardX: -80, content: {} };
  const gladiator = (x, railCd = 0) => ({ role: 'gladiator', x, y: 0, railCd, boost: 0, stun: 0 });
  assert.deepEqual(transitPlan(s, gladiator(500), { x: 8200, y: 0 }), { from: stations[0], to: stations[1] }, 'the station nearest the goal');
  assert.equal(transitPlan(s, gladiator(500), { x: 1500, y: 0 }), null, 'a short walk is not worth it');
  assert.equal(transitPlan({ ...s, map: { stations: stations.slice(0, 2) } }, gladiator(500, 200), { x: 8200, y: 0 }), null, 'the cooldown would not be spent on arrival');
  // Station c is far enough away for the cooldown to be spent by then, and still quicker than walking.
  assert.deepEqual(transitPlan(s, gladiator(500, 200), { x: 8200, y: 0 }), { from: stations[2], to: stations[1] });
  assert.equal(transitPlan({ ...s, hazardX: 8500 }, gladiator(9000), { x: 9500, y: 0 }), null, 'stations behind the wall are not used');
});

test('a gladiator that hears a far gunfight transits to the station beside it', async () => {
  const stations = [300, 4000 - 300];
  const ten = await gunfight(4000, { content: contentById('content-10'), stations, ticks: 600 });
  const eleven = await gunfight(4000, { content: contentById('content-11'), stations, ticks: 600 });
  assert.ok(ten > 400, `walking, ${ten}`);
  assert.ok(eleven < 60, `by transit, ${eleven}`);
});

test('with no one seen and nothing heard, a gladiator sweeps the regions ahead, nearest first', async () => {
  // Five regions in a row; the gladiator starts in the first, a scripted contestant waits in a corner of the last.
  const { map } = arena({ cols: 20, rows: 3, corridor: { gaps: [1, 1, 1, 1] } });
  const { s, players: [g] } = await stagePhysics(map, { content: contentById('content-11'),
    actors: [{ role: 'gladiator', x: 300, y: 288 }, { role: 'contestant', bot: false, x: 3750, y: 60 }] });
  try {
    const centres = [1152, 1920, 2688].map(x => ({ x, y: 288 })), reached = centres.map(() => null);
    run(s, { ticks: 900, trace: s => centres.forEach((c, i) => { if (reached[i] === null && Math.hypot(g.x - c.x, g.y - c.y) < 400) reached[i] = s.tick; }) });
    assert.ok(reached.every(t => t !== null), `reached ${reached}`);
    assert.ok(reached[0] < reached[1] && reached[1] < reached[2], `in order ${reached}`);
  } finally { disposePhysics(s); }
});

test('under content-12, sweeping targets coarse regions near the estimated left-to-right front and switches to the exit once evidence is further right', () => {
  const { map } = arena({ cols: 60, rows: 6, corridor: { gaps: [2, 2, 2, 2, 2, 2, 2, 2, 2] } });
  const g1 = { id: 'g0', role: 'gladiator', status: 'active', x: 10500, y: 576, railCd: 0, boost: 0, stun: 0 };
  const c1 = { id: 'c0', role: 'contestant', status: 'active', x: 960, y: 576, revealed: 0 };
  const s = {
    tick: 100, hazardX: -80, slots: 3, events: [],
    content: contentById('content-12'),
    map, players: [g1, c1],
  };
  noteHunterTarget(s, g1, false);
  const first = sweepTarget(s, g1, at => at);
  assert.ok(first, 'picked a sweep target');
  // Gladiator at x=10500 picks a coarse region (> 2400 away) toward the early front, not the immediate neighbour.
  assert.ok(Math.hypot(g1.x - first.x, g1.y - first.y) >= 2400, `coarse step from ${g1.x} to ${first.x}`);
  assert.ok(Math.abs(first.x - estimatedFrontX(s)) < 2000, `near estimated front ${estimatedFrontX(s)}: got ${first.x}`);
  assert.equal(hasEvidenceFurtherRight(s), false);

  // Once evidence suggests a contestant is further right (e.g. shot heard near the exit), targetless gladiators head toward the exit to goalkeep.
  const g2 = { id: 'g1', role: 'gladiator', status: 'active', x: 6000, y: 576, railCd: 0, boost: 0, stun: 0 };
  s.players.push(g2);
  s.tick = 101;
  hearShot(s, { id: 'c0', role: 'contestant', x: map.exit.x - 300, y: 576 }, 'pistol');
  noteHunterTarget(s, g2, false);
  assert.equal(hasEvidenceFurtherRight(s), true);
  const keep = sweepTarget(s, g2, at => at);
  assert.ok(keep && keep.x > map.exit.x - 2400, `goalkeeping near exit (${map.exit.x}): got ${keep?.x}`);
});

test('hasEvidenceFurtherRight checks each evidence branch without string-parsing match events', () => {
  const { map } = arena({ cols: 60, rows: 6, corridor: { gaps: [2, 2, 2, 2, 2, 2, 2, 2, 2] } });
  const frontX = 1000;
  const threshold = frontX + 1600; // 2600
  const gladiator = { id: 'g0', role: 'gladiator', status: 'active', x: 500, y: 576, railCd: 0, boost: 0, stun: 0 };
  const baseState = () => ({
    tick: 100, hazardX: -80, slots: 3, events: [],
    content: contentById('content-12'),
    map, players: [gladiator],
  });

  // Branch 1: slots < INITIAL_ESCAPE_SLOTS (an escape pod was powered)
  const sSlots = baseState();
  sSlots.slots = 2;
  assert.equal(hasEvidenceFurtherRight(sSlots), true, 'claimed escape pod latches evidence');

  // Branch 2: front itself reaches exit
  const sExit = baseState();
  sExit.tick = 20000;
  assert.equal(hasEvidenceFurtherRight(sExit), true, 'front reaching exit latches evidence');

  // Branch 3: contestant sighted beyond threshold
  const sSight = baseState();
  const cSight = { id: 'c0', role: 'contestant', status: 'active', x: threshold + 100, y: 576, revealed: 0 };
  gladiator.x = threshold + 50; // In sight and clear line
  sSight.players = [gladiator, cSight];
  assert.equal(hasEvidenceFurtherRight(sSight), true, 'sighted contestant beyond threshold latches evidence');

  // Contestant sighted behind threshold does NOT latch
  const sBehind = baseState();
  gladiator.x = 500;
  const cBehind = { id: 'c0', role: 'contestant', status: 'active', x: 600, y: 576, revealed: 0 };
  sBehind.players = [gladiator, cBehind];
  assert.equal(hasEvidenceFurtherRight(sBehind), false, 'sighted contestant behind threshold does not latch');

  // Branch 4: contestant revealed beyond threshold (e.g. pulse scan) even if not directly visible
  const sReveal = baseState();
  const cReveal = { id: 'c0', role: 'contestant', status: 'active', x: threshold + 200, y: 576, revealed: 50 };
  gladiator.x = 500; // Far away, cannot see directly
  sReveal.players = [gladiator, cReveal];
  assert.equal(hasEvidenceFurtherRight(sReveal), true, 'revealed contestant beyond threshold latches evidence');

  // Branch 5: heard gunfire cue beyond threshold
  const sHeard = baseState();
  const gHeard = { id: 'g0', role: 'gladiator', status: 'active', x: 500, y: 576, railCd: 0, boost: 0, stun: 0 };
  sHeard.players = [gHeard];
  hearShot(sHeard, { id: 'c0', role: 'contestant', x: threshold + 300, y: 576 }, 'pistol');
  assert.equal(hasEvidenceFurtherRight(sHeard), true, 'heard shot beyond threshold latches evidence');

  // Shot heard behind threshold does NOT latch
  const sHeardBehind = baseState();
  const gHeardBehind = { id: 'g0', role: 'gladiator', status: 'active', x: 500, y: 576, railCd: 0, boost: 0, stun: 0 };
  sHeardBehind.players = [gHeardBehind];
  hearShot(sHeardBehind, { id: 'c0', role: 'contestant', x: 600, y: 576 }, 'pistol');
  assert.equal(hasEvidenceFurtherRight(sHeardBehind), false, 'heard shot behind threshold does not latch');
});

test('bot-match under content-12 runs physics simulation cleanly and uses transit', async () => {
  const { map } = arena({ cols: 30, rows: 6, corridor: { gaps: [2, 2, 2, 2] },
    stations: [{ id: 'st0', nodeId: 'n0', x: 300, y: 576 }, { id: 'st1', nodeId: 'n1', x: 5000, y: 576 }] });
  const actors = [
    { role: 'gladiator', x: 250, y: 576 },
    { role: 'contestant', bot: true, x: 5400, y: 576 },
  ];
  const { s, players: [g] } = await stagePhysics(map, {
    content: contentById('content-12'),
    actors,
  });
  try {
    let sawOrTransit = false;
    run(s, { ticks: 120, trace: s => { if (g.status === 'transit' || g.railCd > 0 || visibleTo(s, g, s.players[1])) sawOrTransit = true; } });
    assert.ok(s.tick === 120, 'ran 120 ticks cleanly');
    assert.ok(sawOrTransit, 'gladiator swept or transited toward the contestant/goal');
  } finally { disposePhysics(s); }
});

test('under content-12, a powered cell directs gladiators to investigate the charging station rather than goalkeep at exit', () => {
  const chargers = [{ id: 'ch0', nodeId: 'n0', x: 3840, y: 576 }, { id: 'ch1', nodeId: 'n1', x: 7680, y: 576 }];
  const { map } = arena({ cols: 60, rows: 6, corridor: { gaps: [2, 2, 2, 2, 2, 2, 2, 2, 2] }, chargers });
  const gladiator = { id: 'g0', role: 'gladiator', status: 'active', x: 10500, y: 576, railCd: 0, boost: 0, stun: 0 };
  const cell = { kind: 'cell', charge: 100 };
  const contestant = { id: 'c0', role: 'contestant', status: 'active', x: 3850, y: 576, inventory: [cell] };
  const s = {
    tick: 100, hazardX: -80, slots: 3, events: [],
    content: contentById('content-12'),
    map, players: [gladiator, contestant],
  };
  noteHunterTarget(s, gladiator, false);
  // Charging in the west does NOT trigger exit goalkeeping.
  assert.equal(hasEvidenceFurtherRight(s), false, 'charging in the west does not trigger goalkeeping at exit');
  // Instead, the gladiator is directed to investigate the charging station.
  const target = sweepTarget(s, gladiator, at => at);
  assert.ok(target, 'picked investigation target');
  assert.equal(target.x, chargers[0].x, 'gladiator targets the charging station where cell was powered');

  // Once the gladiator arrives at the charging station, it marks it checked and resumes normal sweeping.
  gladiator.x = chargers[0].x;
  gladiator.y = chargers[0].y;
  const afterArrival = sweepTarget(s, gladiator, at => at);
  assert.ok(afterArrival, 'resumed sweeping after checking charger');
  assert.notEqual(afterArrival.x, chargers[0].x, 'picked a new region after investigating charger');
});

test('under content-12, targetless gladiators repel each other while targeted gladiators do not', () => {
  const { map } = arena({ cols: 60, rows: 6, corridor: { gaps: [2, 2, 2, 2, 2, 2, 2, 2, 2] } });
  const peer = { id: 'g0', role: 'gladiator', status: 'active', x: 0, y: 576, railCd: 0, boost: 0, stun: 0 };
  const seekerA = { id: 'g1', role: 'gladiator', status: 'active', x: 10500, y: 576, railCd: 0, boost: 0, stun: 0 };
  const seekerB = { id: 'g2', role: 'gladiator', status: 'active', x: 10500, y: 576, railCd: 0, boost: 0, stun: 0 };
  const s = {
    tick: 1380, hazardX: -80, slots: 3, events: [],
    content: contentById('content-12'),
    map, players: [peer, seekerA],
  };
  const frontRegionX = sweepTarget({ ...s, players: [{ ...seekerB }] }, { ...seekerB }, at => at).x;
  // Place `peer` near `frontRegionX` (without sweeping `frontRegionX` itself, since peer is within 2400 of it).
  peer.x = frontRegionX;
  // When `peer` has no target, `seekerA` is repelled away from `peer`'s position near `frontRegionX`.
  noteHunterTarget(s, peer, false);
  noteHunterTarget(s, seekerA, false);
  const repelled = sweepTarget(s, seekerA, at => at);

  // When `peer` has a concrete target, `seekerB` ignores `peer` for repulsion and picks the region at `frontRegionX`.
  s.players = [peer, seekerB];
  noteHunterTarget(s, peer, true);
  noteHunterTarget(s, seekerB, false);
  const unrepelled = sweepTarget(s, seekerB, at => at);

  assert.ok(repelled && unrepelled);
  assert.equal(unrepelled.x, frontRegionX, 'unrepelled gladiator picks the region right on the front');
  assert.notEqual(repelled.x, unrepelled.x, `repelled gladiator picks a different region (${repelled.x} vs ${unrepelled.x})`);
});
