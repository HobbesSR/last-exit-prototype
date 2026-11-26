import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord, createGame, disposePhysics, snapshot, playerView } from '../shared/simulation.ts';
import { startGame } from '../shared/simulation/tick.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { generatedMap } from './helpers/room-harness.js';
import { gatesJson } from '../shared/simulation/frame-gates.ts';
import { setDoor } from '../shared/simulation/doors.ts';
import { createLayerEncoder } from '../shared/frame-layers.ts';

test('a frame shares its gate list until a gate changes, then shares every unchanged copy (#655)', () => {
  // Never steps, so the game is built without its physics world (#920).
  const s = createGameRecord(4217, generatedMap(), defaultContent());
  assert.ok(s.map.gates.length > 2, 'the game has gates');
  const first = snapshot(s), again = snapshot(s);
  assert.equal(again.gates, first.gates, 'no gate changed, so the frame holds the same list');
  assert.ok(first.gates.every(Object.isFrozen), 'a frame holds frozen copies');
  assert.equal(Object.isFrozen(first.gates), false, 'the list is marked, not frozen');
  assert.notEqual(first.gates[0], s.map.gates[0], 'never the live record');

  // Gates change in place, by rules and by tests arranging a scenario.
  s.map.gates[1].open = !s.map.gates[1].open;
  const changed = snapshot(s);
  assert.notEqual(changed.gates, first.gates);
  assert.equal(changed.gates[1].open, s.map.gates[1].open);
  assert.equal(first.gates[1].open, !s.map.gates[1].open, 'an earlier frame keeps the gate as it stood');
  changed.gates.forEach((gate, i) => { if (i !== 1) assert.equal(gate, first.gates[i]); });

  // A field added or removed is a change too.
  s.map.gates[0].note = 'x';
  assert.equal('note' in snapshot(s).gates[0], false, 'unlisted static/private fields stay off dynamic state');
  delete s.map.gates[0].note;
  assert.equal('note' in snapshot(s).gates[0], false);
});

/** A completed tick that changes only one gate: what the frame store takes from the core when a door moves. */
const gateTick = (tick, id, gate) => ({ tick, inbound: [], discontinuities: [], discovery: { gates: [], samples: [] },
  changes: { actors: [], items: [], projectiles: [], hooks: [], gates: [{ id, gate }], traps: [], extraction: null, hazardX: null,
    removed: [], poses: [], events: [] } });

test('frame gates serialize, project and encode as cloned gates did (#655)', async () => {
  // Frames come from the core (27.2 "Frames"), so a door changes by a completed tick's gate record, given to the frame
  // store directly; the expected list is the store's gate states as those ticks leave them.
  const s = await createGame(4217, generatedMap(), defaultContent()), encoders = new Map();
  try {
    const { frames } = startGame(s), states = s.map.gates.map(g => ({ open: g.open, locked: g.locked }));
    let previous;
    for (let tick = 1; tick <= 12; tick++) {
      const at = tick % states.length;
      if (tick % 4 === 2) states[at] = { ...states[at], open: !states[at].open };
      frames.take(gateTick(tick, at, states[at]));
      const frame = snapshot(s), expected = states.map((g, gateIdx) => ({ gateIdx, open: g.open, locked: g.locked }));
      if (previous && tick % 4 !== 2) assert.equal(frame.gates, previous, 'an unchanged gate keeps the list shared');
      previous = frame.gates;
      assert.equal(JSON.stringify(frame.gates), JSON.stringify(expected));
      assert.equal(gatesJson(frame.gates), JSON.stringify(expected));
      const views = [...s.players.map(p => p.id), null].map(id => playerView(s, frame, id));
      // The store runs ahead of the core here, so the rules project, with the core's latest knowledge: a contestant still
      // sees what it has discovered (review 1134).
      s.players.forEach((p, i) => { if (p.role === 'contestant') assert.ok(Array.isArray(views[i].self.discovered) && views[i].self.discovered.length, `tick ${tick}: ${p.id} keeps its discovery`); });
      // Every view carries every gate, so they share one projected list.
      for (const view of views) assert.equal(view.gates, views[0].gates);
      const cloned = playerView(s, { ...frame, gates: expected }, null);
      assert.equal(JSON.stringify(views[0].gates), JSON.stringify(cloned.gates));
      // The encoder's identity shortcut gives what a fresh comparison gives.
      for (const [i, view] of views.entries()) {
        let encoder = encoders.get(i);
        if (!encoder) encoders.set(i, encoder = { live: createLayerEncoder(), plain: createLayerEncoder() });
        const live = encoder.live.encode(view), again = encoder.live.encode(view), plain = encoder.plain.encode({ gates: view.gates.slice() });
        assert.equal(again.gates, live.gates);
        assert.deepEqual(live.gates.changes, { ...plain.gates.changes, k: live.gates.k });
      }
    }
  } finally { disposePhysics(s); }
});


test('canonical gate state slots retain authored order while physics admits in legacy lexical order', async () => {
  const { openField } = await import('./helpers/arena.js');
  const { physicsRuntime } = await import('../shared/simulation/physics-runtime.ts');
  const { synchronizePhysics } = await import('../shared/simulation/game.ts');
  const gates = [
    { id: 'door-2', kind: 'door', x: 900, y: 100, w: 20, h: 80, open: true, locked: false },
    { id: 'door-10', kind: 'door', x: 1200, y: 100, w: 20, h: 80, open: false, locked: false },
  ];
  const { map } = openField(2000, { gates });
  map.spawns = [{ x: 300, y: 500 }]; map.hunterSpawns = [{ x: 600, y: 500 }];
  const content = { ...defaultContent(), roster: { contestants: ['C'], gladiators: [{ name: 'G', kit: 'hook' }] } };
  const s = await createGame(7, map, content);
  try {
    const r = physicsRuntime(s);
    assert.deepEqual(r.gateOrder, [1, 0]);
    assert.deepEqual([...r.gates], [1, 2]);
    assert.deepEqual(s.map.gates.map(g => g.id), ['door-2', 'door-10']);
    assert.equal(r.world.hasBody('gate:door-10'), true);
    setDoor(s, 0, { open: false }); setDoor(s, 1, { open: true });
    synchronizePhysics(s);
    assert.deepEqual([...r.gates], [2, 1]);
    assert.equal(r.world.hasBody('gate:door-10'), false);
    assert.equal(r.world.hasBody('gate:door-2'), true);
    assert.deepEqual(snapshot(s).gates.map(g => g.gateIdx), [0, 1]);
  } finally { disposePhysics(s); }
});
