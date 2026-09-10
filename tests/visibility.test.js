// Guards the wedge-culled visibility polygon against a brute-force implementation of the same rays.
// The optimisation must be exact: every vertex identical, not merely close.
import { generateMap } from '../shared/map.js';
import { visibilityPolygon, litPoint, lineClear, canOccupy, VISION } from '../shared/movement.js';
import assert from 'node:assert/strict';
import test from 'node:test';
const pts = o => o.r ? Array.from({ length: 16 }, (_, i) => ({ x: o.x + Math.cos(i * Math.PI / 8) * o.r, y: o.y + Math.sin(i * Math.PI / 8) * o.r }))
  : [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h }];
const edgesOf = o => { const p = pts(o); return p.map((a, i) => ({ a, b: p[(i + 1) % p.length] })); };
const gateShape = g => ({ x: g.x - (g.w ?? 26) / 2, y: g.y - (g.h ?? 54) / 2, w: g.w ?? 26, h: g.h ?? 54 });
function hitRay(o, dx, dy, e) {
  const sx = e.b.x - e.a.x, sy = e.b.y - e.a.y, cross = dx * sy - dy * sx;
  if (Math.abs(cross) < 1e-9) return Infinity;
  const ax = e.a.x - o.x, ay = e.a.y - o.y;
  const t = (ax * sy - ay * sx) / cross, u = (ax * dy - ay * dx) / cross;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}
function reference(map, origin, radius = VISION) {
  const all = [...map.obstacles.filter(o => o.kind !== 'window').flatMap(edgesOf), ...map.gates.filter(g => !g.open).flatMap(g => edgesOf(gateShape(g)))];
  const segments = all.filter(({ a, b }) => Math.min(a.x, b.x) < origin.x + radius && Math.max(a.x, b.x) > origin.x - radius && Math.min(a.y, b.y) < origin.y + radius && Math.max(a.y, b.y) > origin.y - radius);
  const angles = Array.from({ length: 100 }, (_, i) => i * Math.PI / 50 - Math.PI);
  for (const edge of segments) for (const p of [edge.a, edge.b]) { const ang = Math.atan2(p.y - origin.y, p.x - origin.x); angles.push(ang - 0.00001, ang, ang + 0.00001); }
  return angles.sort((a, b) => a - b).map(angle => {
    const dx = Math.cos(angle), dy = Math.sin(angle); let length = radius;
    for (const edge of segments) length = Math.min(length, hitRay(origin, dx, dy, edge));
    return { x: origin.x + dx * length, y: origin.y + dy * length };
  });
}
test('wedge-culled visibility polygons match a brute-force implementation exactly', () => {
let compared = 0, worst = 0;
for (const seed of [4217, 9, 11, 777, 20250908, 31337, 2, 65535]) {
  const map = generateMap(seed);
  for (const open of [false, true]) {
    for (const g of map.gates) g.open = open;
    const origins = [];
    for (let i = 0; i < 60; i++) origins.push({ x: 200 + (i * 7919) % (map.width - 400), y: 300 + (i * 271) % (map.height - 600) });
    // Include origins placed exactly on obstacle corners and edge midpoints, where the wedge is degenerate.
    for (const o of map.obstacles.slice(0, 12)) {
      if (o.r) origins.push({ x: o.x, y: o.y }, { x: o.x + o.r, y: o.y });
      else origins.push({ x: o.x, y: o.y }, { x: o.x, y: o.y + o.h / 2 }, { x: o.x + o.w / 2, y: o.y }, { x: o.x + o.w / 2, y: o.y + o.h / 2 });
    }
    for (const origin of origins) {
      const a = visibilityPolygon(map, origin), b = reference(map, origin);
      assert.equal(a.length, b.length, `vertex count seed ${seed} origin ${origin.x},${origin.y}`);
      for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y));
      compared++;
    }
  }
}
  assert.equal(worst, 0, `worst vertex deviation ${worst}`);
  assert.ok(compared > 1000, `compared ${compared} polygons`);
});

test('litPoint agrees with the fog it is derived from, to within its own edge', () => {
  const depths = [];
  let samples = 0;
  for (const seed of [4217, 9, 11, 777, 20250908]) {
    const map = generateMap(seed);
    for (let i = 0; i < 12; i++) {
      const origin = { x: map.width * (0.2 + i * 0.05), y: map.height / 2 + (i % 3 - 1) * 170 };
      if (!canOccupy(map, origin.x, origin.y, 12)) continue; // A player can never stand inside geometry.
      const poly = visibilityPolygon(map, origin);
      for (let k = 0; k < 400; k++) {
        // Offset samples from exact radius/vertex coincidences, which are boundary-ambiguous.
        const a = k * 2.39996, r = ((k % 40) + 0.37) * (VISION / 38);
        const p = { x: origin.x + Math.cos(a) * r, y: origin.y + Math.sin(a) * r };
        samples++;
        if ((r < VISION && lineClear(map, origin, p)) === litPoint(poly, origin, p.x, p.y)) continue;
        // Where they differ, the point must be sitting on the drawn boundary rather than deep either side.
        const angle = Math.atan2(p.y - origin.y, p.x - origin.x);
        let lo = 0, hi = poly.length - 1;
        if (angle >= poly[0].angle && angle <= poly[hi].angle) while (hi - lo > 1) { const m = (lo + hi) >> 1; if (poly[m].angle <= angle) lo = m; else hi = m; }
        else { lo = poly.length - 1; hi = 0; }
        const edge = { a: poly[lo], b: poly[hi] };
        depths.push(Math.abs(r - hitRay(origin, Math.cos(angle), Math.sin(angle), edge)));
      }
    }
  }
  assert.ok(samples > 10000, `sampled ${samples} points`);
  assert.ok(depths.length / samples < 0.03, `${depths.length} of ${samples} disagreed with a ray cast`);
  assert.ok(Math.max(...depths) < 8, `deepest disagreement ${Math.max(...depths)} px from the drawn edge`);
});
test('an eye buried in geometry lights nothing', () => {
  const map = generateMap(4217);
  const wall = map.obstacles.find(o => !o.r && o.kind !== 'window' && o.w > 60 && o.w < 180 && o.h > 60 && o.h < 180);
  const inside = { x: wall.x + wall.w / 2, y: wall.y + wall.h / 2 };
  const poly = visibilityPolygon(map, inside);
  assert.equal(litPoint(poly, inside, inside.x + 200, inside.y), false);
  assert.equal(litPoint(poly, inside, inside.x, inside.y + 200), false);
});
