import { lineClear, litPoint } from './movement.ts';
import type { VisibilityPoint } from './movement.ts';
import type { Building, Cell, CollisionMap, GameMap, Gate, GateId, ObservedGate, PlayableArea, Player, Roof, Tick, Vec2, ViewBounds, World } from './types.ts';

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

export function pointInRoof(roof: Roof, point: Vec2, cellSet?: Set<string>): boolean {
  if (point.x <= roof.bounds.x || point.x >= roof.bounds.x + roof.bounds.w
    || point.y <= roof.bounds.y || point.y >= roof.bounds.y + roof.bounds.h) return false;
  const cx = Math.floor((point.x - roof.origin.x) / roof.cellSize);
  const cy = Math.floor((point.y - roof.origin.y) / roof.cellSize);
  if (cellSet) return cellSet.has(`${cx},${cy}`);
  return roof.cells.some(c => c.x === cx && c.y === cy);
}

interface PhysicalBox {
  roofId?: string | undefined;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RoofIndex {
  coveredBuildingIds: Set<string>;
  bucketSize: number;
  roofBuckets: Map<string, Roof[]>;
  buildingBuckets: Map<string, Building[]>;
  roofCellSets: WeakMap<Roof, Set<string>>;
  obstacleBuckets: Map<string, PhysicalBox[]>;
  undeclaredBuildings: Building[];
}

// Cached per map object and never invalidated: a map is immutable after generation, and the client
// replaces the object on every change. Editing `buildings` or `roofs` in place reads a stale index.
const roofIndexCache = new WeakMap<object, RoofIndex>();

export function getRoofIndex(map: RoofMap): RoofIndex {
  let index = roofIndexCache.get(map);
  if (!index) {
    const roofs = map.roofs || [];
    const coveredBuildingIds = new Set<string>();
    for (const r of roofs) {
      if (r.buildingId) coveredBuildingIds.add(r.buildingId);
    }
    const undeclaredBuildings = (map.buildings || []).filter(b => !coveredBuildingIds.has(b.id));
    const bucketSize = 160;
    const roofBuckets = new Map<string, Roof[]>();
    const buildingBuckets = new Map<string, Building[]>();
    const roofCellSets = new WeakMap<Roof, Set<string>>();
    const obstacleBuckets = new Map<string, PhysicalBox[]>();

    for (const roof of roofs) {
      const set = new Set<string>();
      for (const c of roof.cells) {
        set.add(`${c.x},${c.y}`);
        const x0 = roof.origin.x + c.x * roof.cellSize;
        const y0 = roof.origin.y + c.y * roof.cellSize;
        const x1 = x0 + roof.cellSize;
        const y1 = y0 + roof.cellSize;
        const box: PhysicalBox = { roofId: roof.id, x0, y0, x1, y1 };
        const minBx = Math.floor(x0 / bucketSize);
        const maxBx = Math.floor(x1 / bucketSize);
        const minBy = Math.floor(y0 / bucketSize);
        const maxBy = Math.floor(y1 / bucketSize);
        for (let bx = minBx; bx <= maxBx; bx++) {
          for (let by = minBy; by <= maxBy; by++) {
            const key = `${bx},${by}`;
            let list = obstacleBuckets.get(key);
            if (!list) { list = []; obstacleBuckets.set(key, list); }
            list.push(box);
          }
        }
      }
      roofCellSets.set(roof, set);

      const minBx = Math.floor(roof.bounds.x / bucketSize);
      const maxBx = Math.floor((roof.bounds.x + roof.bounds.w) / bucketSize);
      const minBy = Math.floor(roof.bounds.y / bucketSize);
      const maxBy = Math.floor((roof.bounds.y + roof.bounds.h) / bucketSize);
      for (let bx = minBx; bx <= maxBx; bx++) {
        for (let by = minBy; by <= maxBy; by++) {
          const key = `${bx},${by}`;
          let list = roofBuckets.get(key);
          if (!list) { list = []; roofBuckets.set(key, list); }
          list.push(roof);
        }
      }
    }

    for (const b of undeclaredBuildings) {
      const box: PhysicalBox = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
      const minBx = Math.floor(box.x0 / bucketSize);
      const maxBx = Math.floor(box.x1 / bucketSize);
      const minBy = Math.floor(box.y0 / bucketSize);
      const maxBy = Math.floor(box.y1 / bucketSize);
      for (let bx = minBx; bx <= maxBx; bx++) {
        for (let by = minBy; by <= maxBy; by++) {
          const key = `${bx},${by}`;
          let bList = buildingBuckets.get(key);
          if (!bList) { bList = []; buildingBuckets.set(key, bList); }
          bList.push(b);
          let oList = obstacleBuckets.get(key);
          if (!oList) { oList = []; obstacleBuckets.set(key, oList); }
          oList.push(box);
        }
      }
    }

    index = {
      coveredBuildingIds,
      bucketSize,
      roofBuckets,
      buildingBuckets,
      roofCellSets,
      obstacleBuckets,
      undeclaredBuildings,
    };
    roofIndexCache.set(map, index);
  }
  return index;
}

export interface BoundaryInterval {
  start: number;
  end: number;
}

export interface EdgeBorders {
  hasNeighbor: boolean;
  covered: BoundaryInterval[];
  exposed: BoundaryInterval[];
}

export interface CellBorders {
  hasW: boolean;
  hasE: boolean;
  hasN: boolean;
  hasS: boolean;
  abutsW: boolean;
  abutsE: boolean;
  abutsN: boolean;
  abutsS: boolean;
  w: EdgeBorders;
  e: EdgeBorders;
  n: EdgeBorders;
  s: EdgeBorders;
}

function computeEdge(
  start: number,
  end: number,
  hasNeighbor: boolean,
  rawCovered: BoundaryInterval[],
): EdgeBorders {
  if (hasNeighbor) {
    return {
      hasNeighbor: true,
      covered: [],
      exposed: [],
    };
  }

  const clamped: BoundaryInterval[] = [];
  for (const interval of rawCovered) {
    const s = Math.max(start, interval.start);
    const e = Math.min(end, interval.end);
    if (e > s) clamped.push({ start: s, end: e });
  }

  clamped.sort((a, b) => a.start - b.start || a.end - b.end);

  const covered: BoundaryInterval[] = [];
  for (const interval of clamped) {
    if (!covered.length) {
      covered.push({ start: interval.start, end: interval.end });
    } else {
      const prev = covered[covered.length - 1];
      if (interval.start <= prev.end) {
        prev.end = Math.max(prev.end, interval.end);
      } else {
        covered.push({ start: interval.start, end: interval.end });
      }
    }
  }

  const exposed: BoundaryInterval[] = [];
  let cursor = start;
  for (const interval of covered) {
    if (interval.start > cursor) {
      exposed.push({ start: cursor, end: interval.start });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < end) {
    exposed.push({ start: cursor, end });
  }

  return {
    hasNeighbor: false,
    covered,
    exposed,
  };
}

/**
 * Spatial borders of a declared roof's cell: whether each side touches another cell of the same roof
 * (`has*`), or physically abuts any other roof/building on the map (`abuts*`).
 * Decided solely by physical geometry, completely independent of presentation fade groups.
 * Resolves adjacency by comparing boundary intervals, partitioning each side into covered (shared)
 * and exposed intervals (`w`, `e`, `n`, `s`).
 */
export function roofCellBorders(roof: Roof, cell: Cell, map: RoofMap): CellBorders {
  const index = getRoofIndex(map);
  const cellSet = index.roofCellSets.get(roof);
  const hasW = !!cellSet?.has(`${cell.x - 1},${cell.y}`);
  const hasE = !!cellSet?.has(`${cell.x + 1},${cell.y}`);
  const hasN = !!cellSet?.has(`${cell.x},${cell.y - 1}`);
  const hasS = !!cellSet?.has(`${cell.x},${cell.y + 1}`);

  const rawW: BoundaryInterval[] = [];
  const rawE: BoundaryInterval[] = [];
  const rawN: BoundaryInterval[] = [];
  const rawS: BoundaryInterval[] = [];

  const cx0 = roof.origin.x + cell.x * roof.cellSize;
  const cy0 = roof.origin.y + cell.y * roof.cellSize;
  const cx1 = cx0 + roof.cellSize;
  const cy1 = cy0 + roof.cellSize;

  if (!hasW || !hasE || !hasN || !hasS) {
    const minBx = Math.floor((cx0 - ROOF_EDGE) / index.bucketSize);
    const maxBx = Math.floor((cx1 + ROOF_EDGE) / index.bucketSize);
    const minBy = Math.floor((cy0 - ROOF_EDGE) / index.bucketSize);
    const maxBy = Math.floor((cy1 + ROOF_EDGE) / index.bucketSize);

    const visited = new Set<PhysicalBox>();
    for (let bx = minBx; bx <= maxBx; bx++) {
      for (let by = minBy; by <= maxBy; by++) {
        const list = index.obstacleBuckets.get(`${bx},${by}`);
        if (!list) continue;
        for (const b of list) {
          if (b.roofId === roof.id || visited.has(b)) continue;
          visited.add(b);

          if (!hasW && Math.abs(b.x1 - cx0) <= ROOF_EDGE) {
            rawW.push({ start: b.y0, end: b.y1 });
          }
          if (!hasE && Math.abs(b.x0 - cx1) <= ROOF_EDGE) {
            rawE.push({ start: b.y0, end: b.y1 });
          }
          if (!hasN && Math.abs(b.y1 - cy0) <= ROOF_EDGE) {
            rawN.push({ start: b.x0, end: b.x1 });
          }
          if (!hasS && Math.abs(b.y0 - cy1) <= ROOF_EDGE) {
            rawS.push({ start: b.x0, end: b.x1 });
          }
        }
      }
    }
  }

  const w = computeEdge(cy0, cy1, hasW, rawW);
  const e = computeEdge(cy0, cy1, hasE, rawE);
  const n = computeEdge(cx0, cx1, hasN, rawN);
  const s = computeEdge(cx0, cx1, hasS, rawS);

  const abutsW = !hasW && w.covered.length > 0;
  const abutsE = !hasE && e.covered.length > 0;
  const abutsN = !hasN && n.covered.length > 0;
  const abutsS = !hasS && s.covered.length > 0;

  return {
    hasW, hasE, hasN, hasS,
    abutsW, abutsE, abutsN, abutsS,
    w, e, n, s,
  };
}

export function roofAt(map: RoofMap, point: Vec2): Roof | Building | null {
  if (!map) return null;
  const index = getRoofIndex(map);
  const bx = Math.floor(point.x / index.bucketSize);
  const by = Math.floor(point.y / index.bucketSize);
  const bucketKey = `${bx},${by}`;

  const roofCandidates = index.roofBuckets.get(bucketKey);
  if (roofCandidates) {
    for (const roof of roofCandidates) {
      const cellSet = index.roofCellSets.get(roof);
      if (pointInRoof(roof, point, cellSet)) return roof;
    }
  }

  const bCandidates = index.buildingBuckets.get(bucketKey);
  if (bCandidates) {
    for (const b of bCandidates) {
      if (point.x > b.x && point.x < b.x + b.w && point.y > b.y && point.y < b.y + b.h) return b;
    }
  }

  return null;
}

export function roofConceals(map: RoofMap, eye: Vec2, point: Vec2): boolean {
  const targetRoof = roofAt(map, point);
  if (!targetRoof) return false;
  const eyeRoof = roofAt(map, eye);
  return !eyeRoof || eyeRoof.id !== targetRoof.id;
}

// ---------------------------------------------------------------------------
// Roof presentation. Cosmetic only: none of this changes `roofConceals` or what a viewer may know.
// ---------------------------------------------------------------------------

/** How far apart two walls may sit and still count as one shared edge (wall thickness is thinner). */
const ROOF_EDGE = 2;
/**
 * How near a door, window or threshold cell of its group the viewer must be for a roof to reveal: a
 * body pressed to a window from outside, or standing in a doorway's threshold cell (distance 0).
 */
export const ROOF_REVEAL_RANGE = 32;
/** How long a complete fade between covered and revealed takes; a partial fade takes its share. */
export const ROOF_FADE_MS = 300;
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
  const groups = new Map<string, Array<Building | Roof>>();
  const coveredBuildingIds = map.roofs?.length ? getRoofIndex(map).coveredBuildingIds : new Set<string>();

  if (map.roofs?.length) {
    const byGroup = new Map<string, Roof[]>();
    for (const r of map.roofs) {
      const list = byGroup.get(r.groupId) ?? [];
      list.push(r);
      byGroup.set(r.groupId, list);
    }
    for (const list of byGroup.values()) {
      for (const r of list) groups.set(r.id, list);
    }
  }

  const buildings = (map.buildings || []).filter(b => !coveredBuildingIds.has(b.id));
  if (buildings.length) {
    const parent = new Map<string, string>();
    const find = (id: string): string => { const p = parent.get(id) ?? id; return p === id ? id : (parent.set(id, find(p)), parent.get(id)!); };
    for (const gate of map.gates) {
      const near = buildings.filter(b => gate.x < b.x + b.w + ROOF_EDGE && gate.x + gate.w > b.x - ROOF_EDGE
        && gate.y < b.y + b.h + ROOF_EDGE && gate.y + gate.h > b.y - ROOF_EDGE);
      for (const a of near) for (const b of near) if (a.id < b.id && abutting(a, b)) parent.set(find(b.id), find(a.id));
    }
    const members = new Map<string, Building[]>();
    for (const b of buildings) { const root = find(b.id); (members.get(root) ?? members.set(root, []).get(root)!).push(b); }
    for (const list of members.values()) {
      for (const b of list) groups.set(b.id, list);
    }
  }
  return groups;
}

/** How far each side of a building's roof overhangs: none where a room of the same group abuts it. */
export function roofOverhang(building: RoofBox, group: readonly RoofBox[]): Record<Side, number> {
  const out: Record<Side, number> = { n: ROOF_OVERHANG, e: ROOF_OVERHANG, s: ROOF_OVERHANG, w: ROOF_OVERHANG };
  for (const other of group) if (other.id !== building.id) { const side = abutting(building, other); if (side) out[side] = 0; }
  return out;
}

/** A roof is revealed for a viewer inside its group or within reach of one of its openings, else covered. */
export function roofRevealed(inside: boolean, openingDistance: number): boolean {
  return inside || openingDistance <= ROOF_REVEAL_RANGE;
}

/**
 * Moves roof opacity toward 0 (revealed) or 1 (covered) at a constant rate, so a full fade takes
 * `ROOF_FADE_MS` and a target flip mid-fade reverses from the current alpha for the remaining share.
 */
export function stepRoofAlpha(alpha: number, revealed: boolean, dtMs: number): number {
  const step = Math.max(0, dtMs) / ROOF_FADE_MS;
  return revealed ? Math.max(0, alpha - step) : Math.min(1, alpha + step);
}

/** Nearest door, window or threshold cell of the group to a point, for the reveal; Infinity when it has none. */
export function openingDistance(map: Pick<GameMap, 'gates' | 'obstacles'> & { playableArea?: PlayableArea }, group: readonly (RoofBox | Roof)[], point: Vec2): number {
  const ids = new Set<string>();
  for (const item of group) {
    ids.add(item.id);
    if ('buildingId' in item && item.buildingId) ids.add(item.buildingId);
  }
  let best = Infinity;
  const consider = (box: { x: number; y: number; w: number; h: number }) => {
    const dx = Math.max(box.x - point.x, 0, point.x - box.x - box.w), dy = Math.max(box.y - point.y, 0, point.y - box.y - box.h);
    best = Math.min(best, Math.hypot(dx, dy));
  };
  for (const item of group) {
    if ('thresholds' in item && item.thresholds?.length) {
      for (const t of item.thresholds) {
        consider({
          x: item.origin.x + t.x * item.cellSize,
          y: item.origin.y + t.y * item.cellSize,
          w: item.cellSize,
          h: item.cellSize,
        });
      }
    }
  }
  for (const g of map.gates) if (g.buildingId && ids.has(g.buildingId)) consider(g);
  for (const o of map.obstacles) if (o.kind === 'window' && o.buildingId && ids.has(o.buildingId)) consider(o);
  return best;
}
