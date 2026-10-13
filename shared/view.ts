import { lineClear, litPoint } from './movement.ts';
import type { VisibilityPoint } from './movement.ts';
import type { Building, CollisionMap, GameMap, Gate, GateId, ObservedGate, PlayableArea, Player, Roof, Tick, Vec2, ViewBounds, World } from './types.ts';

/** A gate as last seen, kept per client so an unobserved gate is drawn stale rather than current. */
export type RememberedGate = Gate & { lastSeenTick: Tick };
/** The map fields roof concealment reads. */
type RoofMap = Pick<GameMap, 'buildings'> & { roofs?: Roof[] | undefined; playableArea?: PlayableArea | undefined };

// Bound camera coverage on very large displays so potential visibility stays finite.
// Physical screen pixels never grant an unbounded view of the arena.
export const MAX_VIEW_WIDTH = 2400;
export const MAX_VIEW_HEIGHT = 1600;
export const POTENTIAL_RADIUS = Math.ceil(Math.hypot(MAX_VIEW_WIDTH, MAX_VIEW_HEIGHT) / 2) + 250;
const PLAYER_ZOOM = 1.12;
export function playerZoom(width: number, height: number): number {
  return Math.max(PLAYER_ZOOM, width / MAX_VIEW_WIDTH, height / MAX_VIEW_HEIGHT);
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

// Level of detail zoom thresholds for distant / spectator views.
// Zooming out below these thresholds collapses sub-pixel geometry into fast rects and outlines.
export const LOD_LOW_ZOOM = 0.2;
export const LOD_LABEL_ZOOM = 0.35;
export const LOD_MEDIUM_ZOOM = 0.5;
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
export function roofAt(map: RoofMap, point: Vec2): Roof | null {
  if (!map.roofs?.length) return null;
  const cellSize = map.playableArea?.cellSize ?? 40;
  const cx = Math.floor(point.x / cellSize), cy = Math.floor(point.y / cellSize);
  for (const roof of map.roofs) {
    if (point.x < roof.bounds.x || point.x > roof.bounds.x + roof.bounds.w
      || point.y < roof.bounds.y || point.y > roof.bounds.y + roof.bounds.h) continue;
    if (roof.cells.some(c => c.x === cx && c.y === cy)) return roof;
  }
  return null;
}
export function roofConceals(map: RoofMap, eye: Vec2, point: Vec2): boolean {
  if (map.roofs?.length) {
    const targetRoof = roofAt(map, point);
    if (!targetRoof) return false;
    const eyeRoof = roofAt(map, eye);
    return !eyeRoof || (eyeRoof.groupId !== targetRoof.groupId && eyeRoof.id !== targetRoof.id);
  }
  const building = buildingAt(map, point);
  return !!building && buildingAt(map, eye)?.id !== building.id;
}

// ---------------------------------------------------------------------------
// Roof presentation. Cosmetic only: none of this changes `roofConceals` or what a viewer may know.
// ---------------------------------------------------------------------------

/** How far apart two walls may sit and still count as one shared edge (wall thickness is thinner). */
const ROOF_EDGE = 2;
/** Distance from a door or window at which a roof starts to fade, and how transparent it gets there. */
export const ROOF_FADE_RANGE = 160;
export const ROOF_FADE_FLOOR = 0.4;
/** Roofs extend this far past the walls they cover, except where another room of the group abuts. */
export const ROOF_OVERHANG = 12;
/** Extra camera zoom while the viewer stands inside a building. */
export const INSIDE_ZOOM = 1.15;

type Side = 'n' | 'e' | 's' | 'w';
type RoofBox = Pick<Building, 'id' | 'x' | 'y' | 'w' | 'h'>;

/** The side of `a` that `b` abuts, if their boxes share an edge of positive length. */
function abutting(a: RoofBox, b: RoofBox): Side | null {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (xOverlap > 0 && Math.abs(a.y + a.h - b.y) <= ROOF_EDGE) return 's';
  if (xOverlap > 0 && Math.abs(b.y + b.h - a.y) <= ROOF_EDGE) return 'n';
  if (yOverlap > 0 && Math.abs(a.x + a.w - b.x) <= ROOF_EDGE) return 'e';
  if (yOverlap > 0 && Math.abs(b.x + b.w - a.x) <= ROOF_EDGE) return 'w';
  return null;
}

/**
 * Buildings or roofs that read as one roof: declared roof groups when present on the map,
 * or derived from abutting boxes sharing a door as a fallback for legacy maps.
 */
export function roofGroups(map: Pick<GameMap, 'buildings' | 'gates'> & { roofs?: Roof[] }): Map<string, Array<Building | Roof>> {
  if (map.roofs?.length) {
    const byGroup = new Map<string, Roof[]>();
    for (const r of map.roofs) {
      const list = byGroup.get(r.groupId) ?? [];
      list.push(r);
      byGroup.set(r.groupId, list);
    }
    const groups = new Map<string, Roof[]>();
    for (const list of byGroup.values()) for (const r of list) groups.set(r.id, list);
    return groups as Map<string, Array<Building | Roof>>;
  }
  const buildings = map.buildings || [], parent = new Map<string, string>();
  const find = (id: string): string => { const p = parent.get(id) ?? id; return p === id ? id : (parent.set(id, find(p)), parent.get(id)!); };
  for (const gate of map.gates) {
    const near = buildings.filter(b => gate.x < b.x + b.w + ROOF_EDGE && gate.x + gate.w > b.x - ROOF_EDGE
      && gate.y < b.y + b.h + ROOF_EDGE && gate.y + gate.h > b.y - ROOF_EDGE);
    for (const a of near) for (const b of near) if (a.id < b.id && abutting(a, b)) parent.set(find(b.id), find(a.id));
  }
  const members = new Map<string, Building[]>();
  for (const b of buildings) { const root = find(b.id); (members.get(root) ?? members.set(root, []).get(root)!).push(b); }
  const groups = new Map<string, Building[]>();
  for (const list of members.values()) for (const b of list) groups.set(b.id, list);
  return groups;
}

/** How far each side of a building's roof overhangs: none where a room of the same group abuts it. */
export function roofOverhang(building: RoofBox, group: readonly RoofBox[]): Record<Side, number> {
  const out: Record<Side, number> = { n: ROOF_OVERHANG, e: ROOF_OVERHANG, s: ROOF_OVERHANG, w: ROOF_OVERHANG };
  for (const other of group) if (other.id !== building.id) { const side = abutting(building, other); if (side) out[side] = 0; }
  return out;
}

/** Roof opacity target: gone for a viewer inside the group, fading toward the floor near an opening. */
export function roofTargetAlpha(inside: boolean, openingDistance: number): number {
  if (inside) return 0;
  const near = Math.min(1, Math.max(0, 1 - openingDistance / ROOF_FADE_RANGE));
  return 1 - (1 - ROOF_FADE_FLOOR) * near;
}

/** Nearest door or window of the group to a point, for the fade; Infinity when it has none. */
export function openingDistance(map: Pick<GameMap, 'gates' | 'obstacles'> & { playableArea?: PlayableArea }, group: readonly (RoofBox | Roof)[], point: Vec2): number {
  const ids = new Set(group.map(b => b.id));
  let best = Infinity;
  const consider = (box: { x: number; y: number; w: number; h: number }) => {
    const dx = Math.max(box.x - point.x, 0, point.x - box.x - box.w), dy = Math.max(box.y - point.y, 0, point.y - box.y - box.h);
    best = Math.min(best, Math.hypot(dx, dy));
  };
  const cellSize = map.playableArea?.cellSize ?? 40;
  for (const item of group) {
    const r = item as Roof;
    if (r.thresholds?.length) {
      for (const t of r.thresholds) consider({ x: t.x * cellSize, y: t.y * cellSize, w: cellSize, h: cellSize });
    }
  }
  for (const g of map.gates) if (g.buildingId && ids.has(g.buildingId)) consider(g);
  for (const o of map.obstacles) if (o.kind === 'window' && o.buildingId && ids.has(o.buildingId)) consider(o);
  return best;
}
