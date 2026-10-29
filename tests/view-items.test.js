import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatchFor } from '../server/match.js';
import { liveZoneSize } from '../map/live.ts';
import { contentById } from '../shared/simulation/content.ts';
import { POTENTIAL } from '../shared/simulation/visibility.ts';
import { addItems } from '../shared/simulation/ground-items.ts';
import { distance } from '../shared/simulation/geometry.ts';

// #641: a player's view reads its items through the ground grid. The grid may only spare testing items out of
// reach; the potential-visibility rule still decides, so a view holds exactly what the whole-list filter gives:
// nothing hidden gained, nothing visible lost.
test('a player view holds exactly the items within potential visibility, in list order (#641)', async () => {
  const match = await createMatchFor(4217, liveZoneSize({ zoneWidth: 12, zoneHeight: 6 }), undefined, contentById('content-6'));
  try {
    const s = match.diagnosticState;
    // A ring at the view's edge around each player's start, a hair inside, on and outside it, so movement carries
    // items across the edge in every direction. Added after the map's own items, so their order is tested too.
    let serial = 0;
    for (const p of s.players) for (let k = 0; k < 24; k++) {
      const angle = k * Math.PI / 12, r = POTENTIAL + [-1e-9, 0, 1e-9, -40, 40][k % 5];
      addItems(s, { id: `edge${serial++}`, kind: 'med', x: p.x + r * Math.cos(angle), y: p.y + r * Math.sin(angle) });
    }
    let frame = match.snapshot(), compared = 0, edgeIn = 0, edgeOut = 0;
    for (let tick = 0; tick < 240 && match.phase === 'live'; tick++, frame = match.advance()) {
      for (const p of frame.players) {
        const expected = frame.items.filter(i => distance(p, i) < POTENTIAL).map(i => i.id);
        const view = match.project(frame, p.id), shown = view.items.map(i => i.id);
        assert.deepEqual(shown, expected, `tick ${frame.tick} player ${p.id}`);
        const carried = new Set(shown);
        for (const body of view.bodies ?? []) if (body.itemId !== undefined) assert.ok(carried.has(body.itemId), `body of ${body.itemId} without its item`);
        for (const i of frame.items) if (String(i.id).startsWith('edge')) carried.has(i.id) ? edgeIn++ : edgeOut++;
        compared++;
      }
    }
    assert.ok(compared > 500 && edgeIn > 0 && edgeOut > 0, 'views were compared on both sides of the edge');
    // The directed view is unculled: every item.
    assert.deepEqual(match.project(frame, null).items.map(i => i.id), frame.items.map(i => i.id));
  } finally { match.dispose(); }
});
