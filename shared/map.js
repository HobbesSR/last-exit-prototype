import { canOccupy, insideMap, TILE } from './movement.js';
import { count, start, stop } from './profiler.js';

export const WORLD_WIDTH = 86400, WORLD_HEIGHT = 2880;
export const MODULE_COUNT = 64;
const navigationCache = new WeakMap();
const TEMPLATES = [
  { id: 'service-yard', kind: 'yard', bend: -35, cover: 10 },
  { id: 'ruined-depot', kind: 'depot', bend: 35, cover: 15 },
  { id: 'overgrown-block', kind: 'garden', bend: 0, cover: 12 }
];
const segmentDistance = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
export function generateMap(seed) {
  let rng = seed || 1;
  const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
  const range = (a, b) => Math.round(a + random() * (b - a));
  const cy = WORLD_HEIGHT / 2, entry = { x: 1500, y: cy }, exit = { x: WORLD_WIDTH - 1500, y: cy };
  const map = { seed, width: WORLD_WIDTH, height: WORLD_HEIGHT, entry, exit, modules: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], routes: [] };
  let serial = 0;
  const rect = (x, y, w, h, kind, color = 0) => map.obstacles.push({ id: 'o' + serial++, x, y, w, h, kind, color });
  const extentAt = x => (1 - Math.abs(x - WORLD_WIDTH / 2) / (WORLD_WIDTH / 2 - 40)) * (WORLD_HEIGHT / 2 - 40);
  const checkpointXs = [0.28, 0.52, 0.76].map(f => Math.round(WORLD_WIDTH * f));
  // District -> template -> lane anchors -> geometry/loot. Longitudinal access slots stay stable.
  for (let index = 0; index < MODULE_COUNT; index++) {
    const x = 2300 + index * (WORLD_WIDTH - 4600) / (MODULE_COUNT - 1);
    const template = TEMPLATES[range(0, TEMPLATES.length - 1)];
    map.modules.push({ id: index, district: Math.floor(index / 8), x, y: cy, width: 1280, height: extentAt(x) * 2, template: template.id, kind: template.kind, bend: template.bend, cover: template.cover });
  }
  for (const [band, side] of [['top', -1], ['middle', 0], ['bottom', 1]]) {
    const points = [entry, ...map.modules.map(m => ({ x: m.x, y: cy + side * Math.max(0, extentAt(m.x) - 100) * 0.62 + (side ? m.bend * Math.min(1, extentAt(m.x) / 200) : 0) })), exit];
    // Keys open direct crossings; the middle route retains guaranteed hazardous bypasses.
    if (!side) for (const x of checkpointXs) {
      for (let i = points.length - 1; i >= 0; i--) if (Math.abs(points[i].x - x) < 380) points.splice(i, 1);
      points.push({ x: x - 380, y: cy }, { x: x - 150, y: cy + 430 }, { x: x + 150, y: cy + 430 }, { x: x + 380, y: cy });
    }
    points.sort((a, b) => a.x - b.x); map.routes.push({ band, points });
  }
  const reserved = (x, y, radius) => map.routes.some(route => route.points.some((b, i) => i && segmentDistance({ x, y }, route.points[i - 1], b) < radius + 60));
  for (const m of map.modules) {
    for (let i = 0; i < m.cover; i++) {
      const x = range(m.x - 540, m.x + 540), y = cy + range(-m.height / 2 + 60, m.height / 2 - 60);
      const w = range(50, 140), h = range(45, 100), radius = Math.hypot(w, h) / 2;
      if (!insideMap(map, x + w / 2, y + h / 2, radius + 30) || reserved(x + w / 2, y + h / 2, radius)) continue;
      if (checkpointXs.some(gx => Math.abs(x - gx) < 450)) continue;
      rect(x, y, w, h, m.kind === 'depot' ? 'container' : 'crate', range(0, 2));
    }
    // Separate U-shaped walls provide playable ruined interiors and optional dead ends.
    if (m.height > 1500 && m.id % 3 === 0 && !checkpointXs.some(x => Math.abs(x - m.x) < 500)) {
      const x = m.x - 130, y = cy - 300;
      if (!reserved(m.x, y + 75, 150)) {
        map.obstacles = map.obstacles.filter(o => o.x + o.w < x - 35 || o.x > x + 295 || o.y + o.h < y - 35 || o.y > y + 200);
        rect(x, y, 260, 18, 'building'); rect(x, y, 18, 150, 'building'); rect(x + 242, y, 18, 150, 'building');
        m.interior = { x: x + 18, y: y + 18, w: 224, h: 132 };
      }
    }
  }
  for (const [i, x] of checkpointXs.entries()) {
    rect(x - 13, cy - 290, 26, 263, 'fence'); rect(x - 13, cy + 27, 26, 263, 'fence');
    map.gates.push({ id: 'gate-' + i, x, y: cy, open: false });
    map.hazards.push({ x: x - 100, y: cy - 390, w: 210, h: 100 }, { x: x - 100, y: cy + 290, w: 210, h: 100 });
    const gx = x + 165, gy = cy - 140;
    rect(gx - 14, gy - 116, 28, 100, 'fence'); rect(gx - 14, gy + 16, 28, 100, 'fence');
    map.gaps.push({ x: gx, y: gy });
  }
  map.stations = [0.06, 0.25, 0.44, 0.63, 0.82, 0.96].map((f, i) => ({ id: 'rail-' + i, x: Math.round(WORLD_WIDTH * f), y: cy + 35 }));
  map.chargers = [0.18, 0.46, 0.72, 0.9].map((f, i) => ({ id: 'charger-' + i, x: Math.round(WORLD_WIDTH * f), y: cy }));
  map.sensors = [0.3, 0.55, 0.8].map((f, i) => ({ id: 'sensor-' + i, x: Math.round(WORLD_WIDTH * f), y: cy - 45 }));
  const addItem = (x, y, kind) => { if (canOccupy(map, x, y, 30)) map.items.push({ id: 'item-' + serial++, x, y, kind, ...(kind === 'weapon' ? { weaponType: ['pistol', 'rifle', 'scattergun'][range(0, 2)] } : {}) }); };
  for (const m of map.modules) {
    for (let i = 0; i < 8; i++) addItem(range(m.x - 480, m.x + 480), cy + range(-m.height / 2 + 65, m.height / 2 - 65), ['access', 'med', 'weapon', 'shield'][range(0, 3)]);
    if (m.interior) addItem(m.x, m.interior.y + 60, 'weapon');
  }
  addItem(entry.x + 150, cy, 'weapon'); addItem(entry.x + 280, cy, 'access');
  for (const x of [2600, 3400, 4200, 5200, 6900, 8800, 11000, 14000, 28000, 41000, 57000, 69000]) addItem(x, cy, 'cell');
  for (const x of checkpointXs) addItem(x - 600, cy, 'access');
  map.traps = [];
  for (const m of map.modules) if (m.id > 3 && m.id < MODULE_COUNT - 3 && m.id % 2 === 0) {
    const kind = ['mine', 'turret', 'flame', 'spider'][range(0, 3)], x = m.x + 300, y = cy + (m.id % 4 ? 95 : -95);
    if (canOccupy(map, x, y, 25) && map.chargers.every(st => Math.hypot(st.x - x, st.y - y) > 850)) map.traps.push({ id: 'trap-' + serial++, kind, x, y, homeX: x, homeY: y, heading: y < cy ? Math.PI / 2 : -Math.PI / 2, offset: range(0, 159), cooldown: 35, spent: false });
  }
  return map;
}

// Local windows prevent a long arena from making every bot clone a whole-world grid.
export function navigationGrid(map, role, bounds = { x: 0, y: 0, width: Math.ceil(map.width / TILE), height: Math.ceil(map.height / TILE) }) {
  const gateKey = map.gates.map(g => Number(g.open)).join('');
  let cached = navigationCache.get(map);
  if (!cached || cached.key !== gateKey) { cached = { key: gateKey, grids: new Map() }; navigationCache.set(map, cached); }
  const key = [role, bounds.x, bounds.y, bounds.width, bounds.height].join(':');
  count('calls.navigationGrid');
  if (!cached.grids.has(key)) {
    start('sim.navGridRebuild'); count('work.navGridRebuild');
    const matrix = Array.from({ length: bounds.height }, (_, y) => Array.from({ length: bounds.width }, (_, x) => canOccupy(map, (x + bounds.x + 0.5) * TILE, (y + bounds.y + 0.5) * TILE, role === 'gladiator' ? 25 : 14) ? 0 : 1));
    if (cached.grids.size >= 40) cached.grids.delete(cached.grids.keys().next().value);
    cached.grids.set(key, matrix); stop('sim.navGridRebuild');
  }
  return cached.grids.get(key);
}
