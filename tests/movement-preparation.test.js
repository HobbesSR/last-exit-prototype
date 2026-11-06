import assert from 'node:assert/strict';
import test from 'node:test';
import { canOccupy, lineClear, moveBody, prepareMovementGeometry, reachClear, sweptClear, visibilityPolygon } from '../shared/movement.ts';

// Small synthetic maps cover shape kinds and bucket boundaries without map-generation or physics cost.
function mapOf(count = 180) {
  return {
    width: 2400, height: 3000,
    playableArea: { cellSize: 200, rows: Array.from({ length: 15 }, (_, y) => ({ y, runs: [[0, 12]] })) },
    obstacles: Array.from({ length: count }, (_, i) => {
      const x = 400 + i % 12 * 110, y = 400 + Math.floor(i / 12) * 90;
      const base = { id: `o${i}`, x, y, w: 35, h: 25, kind: ['building', 'window', 'pipe', 'hedge', 'tree'][i % 5] };
      if (i % 3 === 0) return { ...base, r: 16 };
      if (i % 3 === 1) return { ...base, points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 15, y: 35 }] };
      return base;
    }),
    gates: [{ id: 'g0', x: 600, y: 600, open: false }, { id: 'g1', x: 1200, y: 800, open: true }],
  };
}
function answers(map) {
  return Array.from({ length: 16 }, (_, i) => {
    const a = { x: 450 + i * 59, y: 600 + i * 37 }, b = { x: a.x + 240, y: a.y - 120 };
    return {
      occupy: canOccupy(map, a.x, a.y), line: lineClear(map, a, b), reach: reachClear(map, a, b),
      swept: sweptClear(map, a, b, 12), moved: moveBody(map, { ...a }, { x: 1, y: -0.4 }, 12, 9),
      polygon: visibilityPolygon(map, a, 140),
    };
  });
}

test('prepared geometry exactly matches synchronous collision, movement and sight queries', async () => {
  const sync = mapOf(), prepared = structuredClone(sync), expected = answers(sync);
  let yields = 0;
  await prepareMovementGeometry(prepared, async () => { yields++; });
  assert.ok(yields > 1, 'large enough to exercise multiple preparation batches');
  assert.deepEqual(answers(prepared), expected);
  // Maps that differ only in gates retain the existing obstacle-array cache sharing.
  await prepareMovementGeometry({ ...prepared, gates: [] }, async () => assert.fail('already prepared'));
});

test('preparation yields before resolving every collider, and a concurrent query sees complete data', async () => {
  const map = mapOf(300), resolved = new Set();
  for (const [i, obstacle] of map.obstacles.entries()) {
    const points = obstacle.points;
    Object.defineProperty(obstacle, 'points', { get() { resolved.add(i); return points; } });
  }
  let resume, batches = 0;
  const preparation = prepareMovementGeometry(map, () => {
    batches++;
    return batches === 1 ? new Promise(resolve => { resume = resolve; }) : Promise.resolve();
  });
  assert.equal(batches, 1);
  assert.ok(resolved.size > 0 && resolved.size < map.obstacles.length, 'the first batch is bounded');
  const last = map.obstacles.at(-1);
  assert.equal(canOccupy(map, last.x + 10, last.y + 10, 1), false, 'a query must not read partial buckets');
  assert.equal(lineClear(map, { x: last.x - 10, y: last.y + 10 }, { x: last.x + 60, y: last.y + 10 }), false,
    'a query must not read partial sight edges');
  resume();
  await preparation;
  assert.deepEqual(answers(map), answers(mapOf(300)));
});

test('rejection leaves no partial cache and a later preparation can retry', async () => {
  const map = mapOf(), failure = new Error('cancel preparation');
  let attempts = 0;
  await assert.rejects(prepareMovementGeometry(map, async () => {
    if (++attempts === 2) throw failure;
  }), error => error === failure);
  let yields = 0;
  await prepareMovementGeometry(map, async () => { yields++; });
  assert.ok(yields > 1, 'the rejected build must not be treated as a completed cache');
  assert.deepEqual(answers(map), answers(mapOf()));
});

test('concurrent preparations publish complete geometry even when one rejects', async () => {
  const map = mapOf();
  let resume;
  const first = prepareMovementGeometry(map, () => new Promise(resolve => { resume = resolve; }));
  await assert.rejects(prepareMovementGeometry(map, async () => { throw new Error('cancel sibling'); }), /cancel sibling/);
  const second = prepareMovementGeometry(map, async () => {});
  await second;
  // Finish the suspended build with a completed cache already available.
  while (resume) {
    const next = resume; resume = undefined; next();
    await Promise.resolve();
  }
  await first;
  assert.deepEqual(answers(map), answers(mapOf()));
});

test('preparation retries when the obstacle list grows or is replaced during a yield', async () => {
  for (const replace of [false, true]) {
    const map = mapOf(), expected = mapOf();
    const extra = { id: 'extra', x: 1200, y: 1200, w: 40, h: 40, kind: 'building' };
    expected.obstacles.push(extra);
    let yields = 0;
    await prepareMovementGeometry(map, async () => {
      if (yields++ === 0) {
        if (replace) map.obstacles = [...map.obstacles, extra];
        else map.obstacles.push(extra);
      }
    });
    assert.ok(yields > 1);
    assert.equal(canOccupy(map, 1220, 1220, 1), false);
    assert.deepEqual(answers(map), answers(expected));
    map.obstacles.push({ ...extra, x: 1250 });
    let refreshed = false;
    await prepareMovementGeometry(map, async () => { refreshed = true; });
    assert.ok(refreshed, 'a completed cache is invalidated by later list growth');
  }
});
