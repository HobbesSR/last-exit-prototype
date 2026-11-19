import { VISION } from '../../shared/sight.ts';
import { digester } from './float-digest.js';
import { openArea } from './arena.js';

// The fixed cases whose visibility polygons tests/sight-core.test.js pins by digest (#1175, docs/27).
// They are synthetic so that content changes never move them: every shape kind and see-through kind,
// across bucket borders, origins at corners, on edges and across the -pi/pi seam, gates open and closed,
// a grown gate list, a copied one, and empty lists.

/** A fixed linear congruential sequence in [0, 1). */
function sequence(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function syntheticMap() {
  return {
    width: 2400, height: 2400,
    playableArea: openArea(2400, 2400, 200),
    obstacles: Array.from({ length: 120 }, (_, i) => {
      const x = 300 + i % 12 * 150, y = 300 + Math.floor(i / 12) * 160;
      const base = { id: `o${i}`, x, y, w: 35 + i % 4 * 20, h: 25 + i % 3 * 30, kind: ['building', 'window', 'pipe', 'hedge', 'tree', 'crate'][i % 6] };
      if (i % 3 === 0) return { ...base, r: 16 + i % 5 * 6 };
      if (i % 3 === 1) return { ...base, points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 15, y: 35 }] };
      return base;
    }),
    gates: Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, x: 380 + i * 140, y: 230 + i % 4 * 400, open: i % 3 === 0, ...(i % 2 ? { w: 54, h: 20 } : {}) })),
  };
}

/** Mixes each polygon's length, then every point's x, y, angle and length, signed zeros included. */
function polygonDigest(sight) {
  const { mix, hex } = digester();
  let polygons = 0;
  return {
    cast(map, origin, radius = VISION) {
      const points = sight.visibilityPolygon(map, origin, radius);
      mix(points.length);
      for (const p of points) { mix(p.x); mix(p.y); mix(p.angle); mix(p.length); }
      polygons++;
    },
    result: () => ({ digest: hex(), polygons }),
  };
}

/** Origins anywhere, exactly at corners and along edges (the never-culled case), and due east and west of corners (the seam). */
export function syntheticDigest(sight) {
  const map = syntheticMap(), next = sequence(7), { cast, result } = polygonDigest(sight);
  const origins = [];
  for (let i = 0; i < 150; i++) origins.push({ x: 100 + next() * 2200, y: 100 + next() * 2200 });
  for (const o of map.obstacles.slice(0, 30)) if (o.points === undefined && o.r === undefined)
    origins.push({ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x + o.w / 2, y: o.y });
  for (const o of map.obstacles.slice(0, 30)) origins.push({ x: o.x + 90, y: o.y }, { x: o.x - 90, y: o.y });
  for (const origin of origins) for (const radius of [VISION, 180, 47.5]) cast(map, origin, radius);
  return result();
}

/** The open-gate mask read each call, a gate list grown after upload, and a contestant's copied gate list. */
export function gateDigest(sight) {
  const map = syntheticMap(), origin = { x: 390, y: 300 }, { cast, result } = polygonDigest(sight);
  for (const g of map.gates) g.open = false;
  cast(map, origin);
  for (const g of map.gates) g.open = true;
  cast(map, origin);
  map.gates.push({ id: 'g-late', x: origin.x + 60, y: origin.y, open: false });
  cast(map, origin);
  cast({ ...map, gates: map.gates.map(g => ({ ...g, open: !g.open })) }, origin);
  return result();
}

/** An empty map and empty gate list, then an obstacle added to the emptied list. */
export function emptyDigest(sight) {
  const map = { width: 800, height: 800, playableArea: openArea(800, 800, 200), obstacles: [], gates: [] }, { cast, result } = polygonDigest(sight);
  cast(map, { x: 400, y: 400 });
  map.obstacles.push({ id: 'late', x: 450, y: 380, w: 40, h: 40, kind: 'building' });
  cast(map, { x: 400, y: 400 });
  return result();
}
