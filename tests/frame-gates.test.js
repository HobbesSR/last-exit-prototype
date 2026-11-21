import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord, createGame, disposePhysics, snapshot, playerView, step } from '../shared/simulation.ts';
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

test('frame gates serialize, project and encode as cloned gates did (#655)', async () => {
  const s = await createGame(4217, generatedMap(), defaultContent()), encoders = new Map();
  try {
    for (let tick = 0; tick < 12; tick++) {
      if (tick % 4 === 2) setDoor(s, tick % s.map.gates.length, { open: !s.map.gates[tick % s.map.gates.length].open });
      step(s);
      const frame = snapshot(s), expected = s.map.gates.map((g, gateIdx) => ({ gateIdx, open: g.open, locked: g.locked }));
      assert.equal(JSON.stringify(frame.gates), JSON.stringify(expected));
      assert.equal(gatesJson(frame.gates), JSON.stringify(expected));
      const views = [...s.players.map(p => p.id), null].map(id => playerView(s, frame, id));
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
