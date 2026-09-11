import { canOccupy, insideMap } from '../movement.js';
import { WORLD_WIDTH, WORLD_HEIGHT } from './world.js';
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// One context owns all random draws, IDs, and placement bookkeeping for a generation.
export function createGenerationContext(seed) {
  let rng = seed || 1;
  const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
  const range = (a, b) => Math.round(a + random() * (b - a));
  const map = { seed, width: WORLD_WIDTH, height: WORLD_HEIGHT, modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [] };
  let serial = 0;
  const nextId = prefix => prefix + serial++;
  const rect = (x, y, w, h, kind, extra = {}) => { const o = { id: nextId('o'), x, y, w, h, kind, ...extra }; map.obstacles.push(o); return o; };
  const overlaps = (a, b, margin = 0) => a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
  const reservations = [];
  const reserve = (x, y, radius) => reservations.push({ x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 });
  const clearFootprint = box => insideMap(map, box.x + box.w / 2, box.y + box.h / 2, Math.hypot(box.w, box.h) / 2)
    && !map.obstacles.some(o => overlaps(box, o, 20)) && !reservations.some(r => overlaps(box, r, 10));
  const spots = [];
  const occupied = [];
  function place(x, y, kind, extra = {}, separation = 55) {
    if (!canOccupy(map, x, y, 24) || occupied.some(p => distance(p, { x, y }) < separation)) return null;
    const item = { id: nextId('item-'), x, y, kind, ...extra }; map.items.push(item); occupied.push(item); return item;
  }
  return { map, random, range, nextId, rect, reservations, reserve, clearFootprint, spots, occupied, place };
}
