import { lineClear, litPoint } from './movement.ts';
import type { VisibilityPoint } from './movement.ts';
import type { Building, CollisionMap, GameMap, Gate, GateId, ObservedGate, Player, Tick, Vec2, ViewBounds, World } from './types.ts';

/** A gate as last seen, kept per client so an unobserved gate is drawn stale rather than current. */
export type RememberedGate = Gate & { lastSeenTick: Tick };
/** The map fields roof concealment reads. */
type RoofMap = Pick<GameMap, 'buildings'>;

// Bound camera coverage on very large displays so potential visibility stays finite.
// Physical screen pixels never grant an unbounded view of the arena.
export const MAX_VIEW_WIDTH = 2400;
export const MAX_VIEW_HEIGHT = 1600;
export const POTENTIAL_RADIUS = Math.ceil(Math.hypot(MAX_VIEW_WIDTH, MAX_VIEW_HEIGHT) / 2) + 250;
const PLAYER_ZOOM = 1.12;
export function playerZoom(width: number, height: number, overview = false): number {
  return Math.max(overview ? 0.85 : PLAYER_ZOOM, width / MAX_VIEW_WIDTH, height / MAX_VIEW_HEIGHT);
}

// A directed camera frames the whole arena, which is two orders of magnitude wider than a player's
// view, so an unscaled contestant covers about three pixels and the roster is impossible to read.
// Markers are enlarged by the ratio the camera is zoomed out by, which holds their apparent size
// steady instead of shrinking with the camera, and never shrinks them below life size.
export const MARKER_ZOOM = 0.8;
/** Apparent text height in screen pixels; labels are authored at LABEL_FONT_PX and scaled to it. */
export const LABEL_SCREEN_PX = 10;
export const LABEL_FONT_PX = 24;
export function markerScale(zoom: number): number {
  return Math.max(1, MARKER_ZOOM / zoom);
}
// Names stay legible at a fixed pixel height rather than riding the marker scale, which would leave
// them unreadable at whole arena zoom. Authoring above the drawn size keeps the glyphs downscaled.
export function labelScale(zoom: number, marker: number): number {
  return LABEL_SCREEN_PX / LABEL_FONT_PX / (zoom * marker);
}
export function viewBounds(eye: Vec2, width: number, height: number, zoom: number): ViewBounds {
  return { x: eye.x - width / zoom / 2, y: eye.y - height / zoom / 2, width: width / zoom, height: height / zoom };
}
function inViewport(bounds: ViewBounds, x: World, y: World, margin: World = 0): boolean {
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
/** One viewer's computed sight: where they look from, what the camera covers, and the lit polygon. */
export interface Sight {
  eye: Vec2;
  bounds: ViewBounds;
  points: VisibilityPoint[];
}
// Entities are shown slightly beyond the camera edge so one does not pop as it enters frame.
const ENTITY_MARGIN: World = 30;

// What a viewer may know is a gameplay rule, not a rendering detail — see docs/15. The world view and
// the minimap each used to answer this separately and had already drifted apart: the minimap applied
// roof concealment before consulting a reveal, so a revealed player under a roof was drawn in the
// world and missing from the map. One predicate cannot disagree with itself.
export function seesPoint(sight: Sight | null | undefined, map: RoofMap, x: World, y: World, margin: World = ENTITY_MARGIN): boolean {
  if (!sight) return false; // No computed sight knows nothing; a directed view is the caller's decision.
  return !roofConceals(map, sight.eye, { x, y })
    && inViewport(sight.bounds, x, y, margin)
    && litPoint(sight.points, sight.eye, x, y);
}
/** Gladiator sensor and scan reveals are the documented exception to concealment and to cloak. */
export function revealsActor(viewer: Player | null | undefined, actor: Player): boolean {
  return viewer?.role === 'gladiator' && actor.revealed > 0;
}
export function seesActor(sight: Sight | null | undefined, map: RoofMap, viewer: Player | null | undefined, actor: Player): boolean {
  if (revealsActor(viewer, actor)) return true;
  if (actor.cloak) return false;
  return seesPoint(sight, map, actor.x, actor.y);
}
export function buildingAt(map: RoofMap, point: Vec2): Building | null {
  return map.buildings?.find(b => point.x > b.x && point.x < b.x + b.w && point.y > b.y && point.y < b.y + b.h) || null;
}
export function roofConceals(map: RoofMap, eye: Vec2, point: Vec2): boolean {
  const building = buildingAt(map, point);
  return !!building && buildingAt(map, eye)?.id !== building.id;
}
