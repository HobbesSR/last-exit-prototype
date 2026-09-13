import { lineClear } from './movement.ts';
import type { Building, CollisionMap, GameMap, Gate, GateId, ObservedGate, Tick, Vec2, ViewBounds, World } from './types.ts';

/** A gate as last seen, kept per client so an unobserved gate is drawn stale rather than current. */
export type RememberedGate = Gate & { lastSeenTick: Tick };
/** The map fields roof concealment reads. */
type RoofMap = Pick<GameMap, 'buildings'>;

// Bound camera coverage on very large displays so potential visibility stays finite.
// Physical screen pixels never grant an unbounded view of the arena.
export const MAX_VIEW_WIDTH = 2400;
export const MAX_VIEW_HEIGHT = 1600;
export const POTENTIAL_RADIUS = Math.ceil(Math.hypot(MAX_VIEW_WIDTH, MAX_VIEW_HEIGHT) / 2) + 250;
export function playerZoom(width: number, height: number, overview = false): number {
  return Math.max(overview ? 0.85 : 1.12, width / MAX_VIEW_WIDTH, height / MAX_VIEW_HEIGHT);
}
export function viewBounds(eye: Vec2, width: number, height: number, zoom: number): ViewBounds {
  return { x: eye.x - width / zoom / 2, y: eye.y - height / zoom / 2, width: width / zoom, height: height / zoom };
}
export function inViewport(bounds: ViewBounds, x: World, y: World, margin: World = 0): boolean {
  return x >= bounds.x - margin && x <= bounds.x + bounds.width + margin
    && y >= bounds.y - margin && y <= bounds.y + bounds.height + margin;
}
export function viewRadius(bounds: ViewBounds, eye: Vec2): World {
  return Math.max(...[bounds.x, bounds.x + bounds.width].flatMap(x =>
    [bounds.y, bounds.y + bounds.height].map(y => Math.hypot(x - eye.x, y - eye.y)))) + 100;
}

// Memory is presentation-only. Collision and server outcomes use the actual gates.
// Unknown gates are drawn as closed, muted and marked '?', never as secretly current.
export function observeGates(map: CollisionMap, eye: Vec2, bounds: ViewBounds, memory: Map<GateId, RememberedGate>, tick: Tick): ObservedGate[] {
  return map.gates.map(gate => {
    const visible = inViewport(bounds, gate.x, gate.y) && lineClear(map, eye, gate, gate.id);
    if (visible) memory.set(gate.id, { ...gate, lastSeenTick: tick });
    const remembered = memory.get(gate.id);
    return { ...(remembered || { ...gate, open: false }), known: !!remembered, stale: !visible };
  });
}
export function buildingAt(map: RoofMap, point: Vec2): Building | null {
  return map.buildings?.find(b => point.x > b.x && point.x < b.x + b.w && point.y > b.y && point.y < b.y + b.h) || null;
}
export function roofConceals(map: RoofMap, eye: Vec2, point: Vec2): boolean {
  const building = buildingAt(map, point);
  return !!building && buildingAt(map, eye)?.id !== building.id;
}
