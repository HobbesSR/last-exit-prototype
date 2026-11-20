import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics } from '../shared/simulation.ts';
import { canOccupy } from '../shared/movement.ts';
import { reachClear } from '../shared/sight.ts';
import { cos, hypot, sin } from '../shared/math.ts';
import { allocateItemId } from '../shared/item-instances.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { addItems } from '../shared/simulation/ground-items.ts';
import { scatterPoint } from '../shared/simulation/loot.ts';
import { openField } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';

// The drop planner's spiral search runs in the core for a game with a physics world (`rust/core/src/scatter.rs`,
// #1228, docs/27 "Step 5c.1"). The fixture drops rarely, so this holds the core's spot equal to the TypeScript
// search it replaced, with that search's loot-body test (`physicalDropPlacementClear`), near crates, gates, a prop,
// actors, ground records and earlier spots, on the ground list and on a staged list.

/** The TypeScript search the core replaced (`scatterPoint` with `physicalDropPlacementClear`, before #1228), as the reference. */
function scatterTs(s, r, origin, phase, items, points = [], { prop = true, actors = true } = {}) {
  const radius = s.content.worldPhysics.loot.radius;
  const distance = (a, b) => hypot(a.x - b.x, a.y - b.y);
  for (let j = 0; j < 180; j++) {
    const angle = (phase + j) * 2.39996, ring = 36 + Math.floor(j / 12) * 24;
    const candidate = { x: origin.x + cos(angle) * ring, y: origin.y + sin(angle) * ring };
    if (canOccupy(s.map, candidate.x, candidate.y, 16) && reachClear(s.map, origin, candidate)
      && items.every(other => distance(other, candidate) > 32)
      && points.every(other => distance(other, candidate) > 32)
      && (!prop || !r.world.overlapsProp(candidate.x, candidate.y, radius))
      && (!actors || s.players.every(p => p.status !== 'active'
        || hypot(candidate.x - p.x, candidate.y - p.y) >= radius + s.content.actorPhysics.geometry[p.role].bodyRadius))) return candidate;
  }
  return undefined;
}

/** A field of crates with three gates and a crate prop, three actors, and ground records strewn across it. */
async function field() {
  const { map } = openField(1920, { rows: 4, scatter: { density: 0.55, seed: 7 } });
  map.gates = [{ id: 'd0', x: 700, y: 300, w: 26, h: 54, open: false, locked: false, kind: 'door' },
    { id: 'd1', x: 900, y: 420, w: 54, h: 26, open: true, locked: false, kind: 'door' },
    { id: 'd2', x: 1100, y: 200, w: 26, h: 54, open: false, locked: false, kind: 'door' }];
  map.physicsProps = [{ id: 'crate', profile: 'crate', x: 1300, y: 500, angle: Math.PI / 5 }];
  const spots = [];
  for (let x = 60; spots.length < 3 && x < 1900; x += 37) if (canOccupy(map, x, 700, 30)) spots.push({ x, y: 700 }), x += 120;
  const actors = [{ role: 'contestant', ...spots[0] }, { role: 'contestant', ...spots[1] }, { role: 'gladiator', ...spots[2] }];
  const staged = await stagePhysics(map, { actors: actors.map(a => ({ ...a, bot: false })) });
  const { s } = staged;
  const records = [];
  for (let x = 90; x < 1900; x += 113) for (let y = 70; y < 760; y += 97) if (canOccupy(s.map, x, y, 16)) {
    const id = allocateItemId(s);
    records.push({ kind: 'med', id, lineageId: id, count: 1, x, y });
  }
  addItems(s, ...records);
  return staged;
}

const same = (want, got) => want === got || !!want && !!got && Object.is(want.x, got.x) && Object.is(want.y, got.y);

test('the core\'s drop scatter lands where the TypeScript\'s did, on the ground and on a staged list', async () => {
  const { s, players } = await field();
  try {
    const r = physicsRuntime(s), misses = [];
    // Origins at the actors, against the obstacles' and gates' sides, and off the map, each with its own phase; then
    // origins whose first spots fall on the crate prop, so the prop test decides.
    const origins = players.map((p, k) => [{ x: p.x, y: p.y }, k * 7]);
    for (const o of s.map.obstacles.slice(0, 40)) origins.push([{ x: o.x - 14, y: o.y + o.h / 2 }], [{ x: o.x + o.w / 2, y: o.y - 14 }]);
    for (const g of s.gates) origins.push([{ x: g.x - 20, y: g.y }], [{ x: g.x + 40, y: g.y + 20 }]);
    origins.push([{ x: -50, y: 300 }], [{ x: 960, y: -200 }]);
    for (let phase = 0; phase < 6; phase++) for (const ring of [36, 60]) {
      const angle = phase * 2.39996;
      origins.push([{ x: 1300 - cos(angle) * ring, y: 500 - sin(angle) * ring }, phase]);
    }
    let cases = 0, late = 0, refused = 0, byProp = 0, byActor = 0;
    for (let round = 0; round < 2; round++) {
      // Gates change between calls: each call writes the mask as they stand.
      if (round) s.gates.forEach(g => { g.open = !g.open; });
      for (const [k, [origin, given]] of origins.entries()) {
        const phase = given ?? (k * 7 + round * 3) % 40;
        // The ground list through its grid; a staged list (a swap's, one record left out) read whole; earlier spots.
        const staged = s.items.filter((_, i) => i % 5 !== k % 5);
        const points = k % 3 ? [] : [{ x: origin.x + 40, y: origin.y }, { x: origin.x, y: origin.y - 60 }];
        for (const [items, spots] of [[s.items, []], [staged, points]]) {
          const want = scatterTs(s, r, origin, phase, items, spots), got = scatterPoint(s, origin, phase, items, spots);
          cases++;
          if (!want) refused++;
          else {
            const first = { x: origin.x + cos(phase * 2.39996) * 36, y: origin.y + sin(phase * 2.39996) * 36 };
            if (!same(want, first)) late++;
          }
          // Where the search without one of the loot-body tests would have stopped elsewhere, that test decided.
          if (!same(want, scatterTs(s, r, origin, phase, items, spots, { prop: false }))) byProp++;
          if (!same(want, scatterTs(s, r, origin, phase, items, spots, { actors: false }))) byActor++;
          if (!same(want, got) && misses.push({ origin, phase, want, got }) >= 5) break;
        }
      }
    }
    assert.deepEqual(misses, []);
    // The cases reach the later spots, a refusal, and spots the loot-body test turns away.
    assert.ok(late > cases / 4 && refused > 0, `late ${late}, refused ${refused} of ${cases}`);
    assert.ok(byProp > 0 && byActor > 0, `the prop test decided ${byProp}, the actor test ${byActor} of ${cases}`);
  } finally { disposePhysics(s); }
});
