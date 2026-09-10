import { lineClear } from './movement.js';

// Bound camera coverage on very large displays so potential visibility stays finite.
// Physical screen pixels never grant an unbounded view of the arena.
export const MAX_VIEW_WIDTH = 2400;
export const MAX_VIEW_HEIGHT = 1600;
export const POTENTIAL_RADIUS = Math.ceil(Math.hypot(MAX_VIEW_WIDTH, MAX_VIEW_HEIGHT) / 2) + 250;
export function playerZoom(width, height, overview = false) {
  return Math.max(overview ? 0.85 : 1.12, width / MAX_VIEW_WIDTH, height / MAX_VIEW_HEIGHT);
}
export function viewBounds(eye, width, height, zoom) {
  return { x: eye.x - width / zoom / 2, y: eye.y - height / zoom / 2, width: width / zoom, height: height / zoom };
}
export function inViewport(bounds, x, y, margin = 0) {
  return x >= bounds.x - margin && x <= bounds.x + bounds.width + margin
    && y >= bounds.y - margin && y <= bounds.y + bounds.height + margin;
}
export function viewRadius(bounds, eye) {
  return Math.max(...[bounds.x, bounds.x + bounds.width].flatMap(x =>
    [bounds.y, bounds.y + bounds.height].map(y => Math.hypot(x - eye.x, y - eye.y)))) + 100;
}

// Memory is presentation-only. Collision and server outcomes use the actual gates.
// Unknown gates are drawn as closed, muted and marked '?', never as secretly current.
export function observeGates(map, eye, bounds, memory, tick) {
  return map.gates.map(gate => {
    const visible = inViewport(bounds, gate.x, gate.y) && lineClear(map, eye, gate, gate.id);
    if (visible) memory.set(gate.id, { ...gate, lastSeenTick: tick });
    const remembered = memory.get(gate.id);
    return { ...(remembered || { ...gate, open: false }), known: !!remembered, stale: !visible };
  });
}
export function buildingAt(map, point) {
  return map.buildings?.find(b => point.x > b.x && point.x < b.x + b.w && point.y > b.y && point.y < b.y + b.h) || null;
}
export function roofConceals(map, eye, point) {
  const building = buildingAt(map, point);
  return !!building && buildingAt(map, eye)?.id !== building.id;
}
