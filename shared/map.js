import { canOccupy, insideMap, TILE } from './movement.js';
import { count, start, stop } from './profiler.js';

export const WORLD_WIDTH = 6720, WORLD_HEIGHT = 2880;
const navigationCache = new WeakMap();
export function generateMap(seed) {
  let rng = seed || 1;
  const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
  const range = (a, b) => Math.round(a + random() * (b - a));
  const cy = WORLD_HEIGHT / 2;
  const map = { seed, width: WORLD_WIDTH, height: WORLD_HEIGHT, modules: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], sensors: [], items: [], exit: { x: WORLD_WIDTH - 185, y: cy } };
  let serial = 0;
  const rect = (x, y, w, h, kind, color = 0) => map.obstacles.push({ id: `o${serial++}`, x, y, w, h, kind, color });
  // Modules choose a layout and generate geometry within their continuous footprints.
  for (let index = 0; index < 9; index++) {
    const cx = 620 + index * 660;
    const extent = Math.max(110, (1 - Math.abs(cx - WORLD_WIDTH / 2) / (WORLD_WIDTH / 2 - 40)) * (WORLD_HEIGHT / 2 - 100));
    const kind = ['yard', 'depot', 'garden'][range(0, 2)];
    map.modules.push({ id: index, x: cx, y: cy, width: 660, height: extent * 2, kind, accent: index % 3 });
    for (let i = 0; i < 12; i++) {
      const x = range(cx - 270, cx + 270), side = i % 2 ? 1 : -1;
      const y = cy + side * range(130, Math.max(140, extent - 90));
      const w = range(68, kind === 'depot' ? 190 : 125), h = range(54, 115);
      if (!insideMap(map, x + w / 2, y + h / 2, Math.max(w, h))) continue;
      if ([1800, 3600, 5300].some(gx => Math.abs(x - gx) < 260)) continue;
      if (i % 4 === 0) map.obstacles.push({ id: `o${serial++}`, x, y, r: range(24, 43), kind: kind === 'garden' ? 'tree' : 'rock' });
      else rect(x, y, w, h, kind === 'depot' && i % 3 === 0 ? 'building' : 'container', range(0, 2));
    }
    if (index > 0 && index < 8 && ![1800, 3600, 5300].some(gx => Math.abs(cx - gx) < 280)) rect(cx + range(-90, 60), cy + (index % 2 ? 65 : -115), range(80, 125), 48, 'crate', index % 3);
  }
  for (const [i, x] of [1800, 3600, 5300].entries()) {
    const y = cy;
    rect(x - 13, y - 290, 26, 263, 'fence'); rect(x - 13, y + 27, 26, 263, 'fence');
    map.gates.push({ id: `gate-${i}`, x, y, open: false });
    map.hazards.push({ x: x - 100, y: y - 390, w: 210, h: 100 }, { x: x - 100, y: y + 290, w: 210, h: 100 });
    const gx = x + 165, gy = y - 140;
    rect(gx - 14, gy - 116, 28, 100, 'fence'); rect(gx - 14, gy + 16, 28, 100, 'fence');
    map.gaps.push({ x: gx, y: gy });
  }
  map.stations = [1050, 3370, 5570].map((x, i) => ({ id: `rail-${i}`, x, y: cy + 35 }));
  map.sensors = [2280, 4220, 5780].map((x, i) => ({ id: `sensor-${i}`, x, y: cy - 45 }));
  const addItem = (x, y, kind) => map.items.push({ id: `item-${serial++}`, x, y, kind });
  for (const module of map.modules) for (let i = 0; i < 10; i++) {
    const x = range(module.x - 260, module.x + 260), y = cy + range(-module.height / 2 + 65, module.height / 2 - 65);
    if (canOccupy(map, x, y, 30)) addItem(x, y, ['access', 'med', 'weapon', 'shield'][range(0, 3)]);
  }
  for (const [x, kind] of [[390, 'weapon'], [510, 'access'], [1250, 'shield'], [2970, 'access'], [4590, 'med'], [4860, 'access']]) addItem(x, cy, kind);
  return map;
}
export function navigationGrid(map, role) {
  const key = map.gates.map(g => Number(g.open)).join('');
  let cached = navigationCache.get(map);
  if (!cached || cached.key !== key) { cached = { key }; navigationCache.set(map, cached); }
  count('calls.navigationGrid');
  if (!cached[role]) {
    start('sim.navGridRebuild'); count('work.navGridRebuild');
    cached[role] = Array.from({ length: Math.ceil(map.height / TILE) }, (_, y) => Array.from({ length: Math.ceil(map.width / TILE) }, (_, x) => canOccupy(map, (x + 0.5) * TILE, (y + 0.5) * TILE, role === 'gladiator' ? 25 : 14) ? 0 : 1));
    stop('sim.navGridRebuild');
  }
  return cached[role];
}
