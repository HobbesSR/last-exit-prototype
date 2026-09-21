import { searchRegions } from "./core.ts";
import { mergeRuns } from "./primitives.ts";
import {
  clearNavCache,
  nodeIndex,
  occupiable,
  reachable,
  segmentClear,
} from "./nav.ts";
import type {
  MacroComposition,
  MacroCompositionInput,
  MacroPlacement,
  MacroRouteCheck,
  MacroRouteConstraint,
  MacroSegment,
} from "./macro-types.ts";
import type { Orientation, Point, Span, Wall } from "./types.ts";

const MAX_WIDTH = 366;
const MAX_HEIGHT = 186;
const EPS = 1e-9;
const SPAN_TICKS = 1_000_000_000;

function fail(message: string): never {
  throw new Error(`invalid macro composition: ${message}`);
}
function integer(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value)
  )
    fail(`${name} must be a finite integer`);
  return value;
}
function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${name} must be finite`);
  return value;
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length)
    fail(`${name} must be a nonempty string`);
  return value;
}
function point(value: Point, name: string, whole = false): Point {
  const x = whole
    ? integer(value?.x, `${name}.x`)
    : finite(value?.x, `${name}.x`);
  const y = whole
    ? integer(value?.y, `${name}.y`)
    : finite(value?.y, `${name}.y`);
  return { x, y };
}
function key(x: number, y: number): string {
  return `${x},${y}`;
}
function rotated(p: Point, orientation: Orientation): Point {
  switch (orientation) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: -p.y, y: p.x };
    case 180:
      return { x: -p.x, y: -p.y };
    case 270:
      return { x: p.y, y: -p.x };
  }
}
function world(p: Point, placement: MacroPlacement): Point {
  const q = rotated(p, placement.orientation);
  return { x: q.x + placement.origin.x, y: q.y + placement.origin.y };
}
/** Rotate a unit cell as an area, then address it by its minimum corner. */
function worldCell(p: Point, placement: MacroPlacement): Point {
  const corners = [
    rotated(p, placement.orientation),
    rotated({ x: p.x + 1, y: p.y }, placement.orientation),
    rotated({ x: p.x, y: p.y + 1 }, placement.orientation),
    rotated({ x: p.x + 1, y: p.y + 1 }, placement.orientation),
  ];
  return {
    x: Math.min(...corners.map((corner) => corner.x)) + placement.origin.x,
    y: Math.min(...corners.map((corner) => corner.y)) + placement.origin.y,
  };
}
function span(value: Span, name: string): Span {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2)
    fail(`${name} must be a span or null`);
  const lo = finite(value[0], `${name}[0]`),
    hi = finite(value[1], `${name}[1]`);
  if (lo < 0 || hi > 1 || lo >= hi)
    fail(`${name} must satisfy 0 <= lo < hi <= 1`);
  const lower = Math.round(lo * SPAN_TICKS),
    upper = Math.round(hi * SPAN_TICKS);
  if (lower === upper) fail(`${name} collapses at 1e-9 cell precision`);
  return [lower / SPAN_TICKS, upper / SPAN_TICKS];
}
function reverseSpan(open: Span): Span {
  return open === null
    ? null
    : [
        (SPAN_TICKS - Math.round(open[1] * SPAN_TICKS)) / SPAN_TICKS,
        (SPAN_TICKS - Math.round(open[0] * SPAN_TICKS)) / SPAN_TICKS,
      ];
}
function segmentWorld(
  segment: MacroSegment,
  placement: MacroPlacement,
): { vertical: boolean; line: number; offset: number; open: Span } {
  const a = world({ x: segment.x, y: segment.y }, placement);
  const b = world(
    segment.axis === "h"
      ? { x: segment.x + 1, y: segment.y }
      : { x: segment.x, y: segment.y + 1 },
    placement,
  );
  const open = span(
    segment.open,
    `segment ${segment.axis}:${segment.x},${segment.y}.open`,
  );
  if (a.x === b.x) {
    const forward = b.y > a.y;
    return {
      vertical: true,
      line: a.x,
      offset: Math.min(a.y, b.y),
      open: forward ? open : reverseSpan(open),
    };
  }
  const forward = b.x > a.x;
  return {
    vertical: false,
    line: a.y,
    offset: Math.min(a.x, b.x),
    open: forward ? open : reverseSpan(open),
  };
}
function spanSame(a: Span, b: Span): boolean {
  return a === null ? b === null : b !== null && a[0] === b[0] && a[1] === b[1];
}
function inClosure(p: Point, cells: Set<string>): boolean {
  // At most four incident cells, including both sides of an integer boundary.
  // These bounds preserve the previous closed-cell EPS semantics without a scan.
  for (const y of [Math.ceil(p.y - 1 - EPS), Math.floor(p.y + EPS)])
    for (const x of [Math.ceil(p.x - 1 - EPS), Math.floor(p.x + EPS)])
      if (cells.has(key(x, y))) return true;
  return false;
}
/** A segment is contained in a union of closed unit cells when every interval
 * between grid-line crossings has an interior sample in that union. */
function segmentInCells(a: Point, b: Point, cells: Set<string>): boolean {
  if (!inClosure(a, cells) || !inClosure(b, cells)) return false;
  const cuts = new Set<number>([0, 1]);
  const addCrossings = (a0: number, b0: number) => {
    if (a0 === b0) return;
    const lo = Math.floor(Math.min(a0, b0)) + 1,
      hi = Math.ceil(Math.max(a0, b0)) - 1;
    for (let n = lo; n <= hi; n++) {
      const t = (n - a0) / (b0 - a0);
      if (t > EPS && t < 1 - EPS) cuts.add(t);
    }
  };
  addCrossings(a.x, b.x);
  addCrossings(a.y, b.y);
  const ordered = [...cuts].sort((x, y) => x - y);
  for (let i = 1; i < ordered.length; i++) {
    const t = (ordered[i - 1]! + ordered[i]!) / 2;
    if (
      !inClosure({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, cells)
    )
      return false;
  }
  return true;
}

const WALL_FIELDS = ["x1", "y1", "x2", "y2"] as const;

/**
 * Recheck a constructed composition's retained corridors and route constraints
 * against its current walls.
 *
 * This is the single implementation of those checks: `composeMacro` uses it, and
 * so must any caller that edits final geometry afterwards. Source fields,
 * ownership, dimensions, navBoxes and the retained definitions are assumed
 * unchanged and are never rewritten here; only `walls` may have moved. A prior
 * manifest is not evidence, so nothing is trusted from it.
 *
 * A `connected: false` observation means no route was found on the sampled
 * half-cell lattice at that radius. It is not a proof of continuous separation.
 */
export function checkMacroRoutes(map: MacroComposition): MacroRouteCheck {
  // Any cached wall index or lattice describes the geometry as it used to be.
  // Invalidate first, so even an early rejection cannot leave a stale cache.
  clearNavCache(map);
  const errors: string[] = [];
  const constraints: MacroRouteCheck["constraints"] = [];
  const reject = () => ({
    valid: false,
    errors,
    corridorsChecked: 0,
    constraints,
  });

  const walls = map?.walls;
  if (!Array.isArray(walls)) {
    errors.push("walls must be a list");
    return reject();
  }
  // Non-finite coordinates make every swept-disc distance NaN, which reads as
  // clear. Reject them here instead of asking navigation to interpret them.
  for (let i = 0; i < walls.length; i++) {
    const record = walls[i];
    if (!record || typeof record !== "object") {
      errors.push(`wall ${i} is not a wall record`);
      continue;
    }
    for (const field of WALL_FIELDS) {
      const value: unknown = record[field];
      if (typeof value !== "number" || !Number.isFinite(value))
        errors.push(`wall ${i}.${field} must be finite`);
    }
  }
  if (!Array.isArray(map.corridors)) errors.push("corridors must be a list");
  if (!Array.isArray(map.constraints))
    errors.push("constraints must be a list");
  if (errors.length) return reject();

  let corridorsChecked = 0;
  for (const corridor of map.corridors) {
    // Local centre-line ownership was proved during composition; only clearance
    // against the current walls can have changed.
    let clear = true;
    for (let i = 1; i < corridor.points.length; i++) {
      const a = corridor.points[i - 1]!,
        b = corridor.points[i]!;
      if (!segmentClear(map, a.x, a.y, b.x, b.y, corridor.radius)) {
        errors.push(
          `corridor ${corridor.placementId}/${corridor.id} segment ${i - 1} is not clear in the current geometry`,
        );
        clear = false;
      }
    }
    if (clear) corridorsChecked += 1;
  }
  for (const constraint of map.constraints) {
    const { placementId, id, radius, from, to } = constraint;
    // A body that cannot stand on an endpoint has not satisfied a requested cut.
    if (
      !occupiable(map, radius, from.x, from.y) ||
      !occupiable(map, radius, to.x, to.y)
    ) {
      errors.push(`constraint ${placementId}/${id} has a blocked endpoint`);
      continue;
    }
    const observed = reachable(map, radius, from.x, from.y, [
      0,
      0,
      map.width,
      map.height,
    ]).has(nodeIndex(map, to.x, to.y));
    constraints.push({ placementId, id, connected: observed });
    if (observed !== constraint.connected)
      errors.push(
        `constraint ${placementId}/${id} observed connectivity disagrees with declaration`,
      );
  }
  return { valid: errors.length === 0, errors, corridorsChecked, constraints };
}

/** Compose experimental macro structures into the shared clearance/nav core. */
export function composeMacro(input: MacroCompositionInput): MacroComposition {
  if (!input || input.version !== 1) fail("version must be 1");
  nonempty(input.seed, "seed");
  const width = integer(input.width, "width"),
    height = integer(input.height, "height");
  if (width < 1 || height < 1 || width > MAX_WIDTH || height > MAX_HEIGHT)
    fail("dimensions exceed supported bounds");
  nonempty(input.defaultCellClass, "defaultCellClass");
  if (!Array.isArray(input.mask) || !input.mask.length)
    fail("mask must be nonempty");
  if (!Array.isArray(input.placements)) fail("placements must be a list");

  const mask = new Set<string>();
  for (const cell of input.mask) {
    const p = point(cell, "mask cell", true);
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height)
      fail("mask cell is out of bounds");
    if (mask.has(key(p.x, p.y))) fail("mask cells must be unique");
    mask.add(key(p.x, p.y));
  }
  const cellClass = new Array<string>(width * height).fill("");
  // Filled from cellClass once the paint is final.
  const cellSolid = new Array<boolean>(width * height).fill(false);
  const cellOwner: Array<string | null> = new Array(width * height).fill(null);
  for (const entry of mask) {
    const [x, y] = entry.split(",").map(Number);
    cellClass[y * width + x] = input.defaultCellClass;
  }
  const verticalCount = (width + 1) * height;
  const segmentIndex = (vertical: boolean, line: number, offset: number) =>
    vertical
      ? offset * (width + 1) + line
      : verticalCount + line * width + offset;
  const segmentOpen: Span[] = new Array(
    verticalCount + (height + 1) * width,
  ).fill(null);
  const declarations = new Map<number, Span>();
  const placementIds = new Set<string>();
  const entrances: MacroComposition["entrances"] = [];
  const corridors: MacroComposition["corridors"] = [];
  const constraints: Array<{
    placementId: string;
    value: MacroRouteConstraint;
    from: Point;
    to: Point;
  }> = [];
  const manifest: MacroComposition["manifest"] = {
    placements: [],
    constraints: [],
    corridorsChecked: 0,
  };

  for (const placement of input.placements) {
    const placementId = nonempty(placement?.id, "placement id");
    if (placementIds.has(placementId)) fail("placement ids must be unique");
    placementIds.add(placementId);
    point(placement.origin, `placement ${placementId}.origin`, true);
    if (![0, 90, 180, 270].includes(placement.orientation))
      fail(`placement ${placementId}.orientation is invalid`);
    const structure = placement.structure;
    if (!structure || structure.version !== 1)
      fail(`placement ${placementId} has an unsupported structure version`);
    nonempty(structure.id, `placement ${placementId}.structure.id`);
    nonempty(
      structure.defaultCellClass,
      `structure ${structure.id}.defaultCellClass`,
    );
    if (!Array.isArray(structure.cells) || !structure.cells.length)
      fail(`structure ${structure.id} needs cells`);
    const local = new Set<string>();
    for (const cell of structure.cells) {
      const p = point(cell, `structure ${structure.id} cell`, true);
      if (local.has(key(p.x, p.y)))
        fail(`structure ${structure.id} cells must be unique`);
      local.add(key(p.x, p.y));
      if (cell.class !== undefined)
        nonempty(cell.class, `structure ${structure.id} cell class`);
      const q = worldCell(p, placement);
      if (!mask.has(key(q.x, q.y)))
        fail(`structure ${structure.id} cell falls outside mask`);
      const index = q.y * width + q.x;
      if (cellOwner[index] !== null)
        fail(`structures overlap at ${q.x},${q.y}`);
      cellOwner[index] = placementId;
      cellClass[index] = cell.class ?? structure.defaultCellClass;
    }
    const segments = structure.segments ?? [];
    if (!Array.isArray(segments))
      fail(`structure ${structure.id}.segments must be a list`);
    for (const segment of segments) {
      if (!segment || (segment.axis !== "h" && segment.axis !== "v"))
        fail(`structure ${structure.id} has invalid segment axis`);
      integer(segment.x, "segment.x");
      integer(segment.y, "segment.y");
      const incident =
        segment.axis === "h"
          ? [key(segment.x, segment.y - 1), key(segment.x, segment.y)]
          : [key(segment.x - 1, segment.y), key(segment.x, segment.y)];
      if (!incident.some((k) => local.has(k)))
        fail(
          `structure ${structure.id} declares a segment not incident to an owned cell`,
        );
      const q = segmentWorld(segment, placement);
      if (
        q.line < 0 ||
        q.offset < 0 ||
        (q.vertical
          ? q.line > width || q.offset >= height
          : q.line > height || q.offset >= width)
      )
        fail(`structure ${structure.id} segment is out of bounds`);
      const index = segmentIndex(q.vertical, q.line, q.offset),
        previous = declarations.get(index);
      if (previous !== undefined && !spanSame(previous, q.open))
        fail(
          `conflicting declarations for shared segment at ${q.line},${q.offset}`,
        );
      declarations.set(index, q.open);
    }
    const named = (items: Array<{ id: string }> | undefined, kind: string) => {
      const ids = new Set<string>();
      for (const item of items ?? []) {
        const id = nonempty(item?.id, `${kind} id`);
        if (ids.has(id))
          fail(`structure ${structure.id} ${kind} ids must be unique`);
        ids.add(id);
      }
    };
    if (!Array.isArray(structure.entrances ?? []))
      fail(`structure ${structure.id}.entrances must be a list`);
    named(structure.entrances, "entrance");
    for (const entrance of structure.entrances ?? []) {
      const p = point(entrance, `entrance ${entrance.id}`);
      if (!inClosure(p, local))
        fail(`entrance ${entrance.id} is outside the structure footprint`);
      entrances.push({ ...world(p, placement), id: entrance.id, placementId });
    }
    if (!Array.isArray(structure.corridors ?? []))
      fail(`structure ${structure.id}.corridors must be a list`);
    named(structure.corridors, "corridor");
    for (const corridor of structure.corridors ?? []) {
      if (!Array.isArray(corridor.points) || corridor.points.length < 2)
        fail(`corridor ${corridor.id} needs at least two points`);
      const radius = finite(corridor.radius, `corridor ${corridor.id}.radius`);
      if (radius <= 0) fail(`corridor ${corridor.id}.radius must be positive`);
      const points = corridor.points.map((p, i) =>
        point(p, `corridor ${corridor.id}.points[${i}]`),
      );
      for (let i = 1; i < points.length; i++)
        if (!segmentInCells(points[i - 1]!, points[i]!, local))
          fail(`corridor ${corridor.id} leaves the structure footprint`);
      corridors.push({
        id: corridor.id,
        radius,
        points: points.map((p) => world(p, placement)),
        placementId,
      });
    }
    if (!Array.isArray(structure.constraints ?? []))
      fail(`structure ${structure.id}.constraints must be a list`);
    named(structure.constraints, "constraint");
    for (const constraint of structure.constraints ?? []) {
      const radius = finite(
        constraint.radius,
        `constraint ${constraint.id}.radius`,
      );
      if (radius <= 0 || typeof constraint.connected !== "boolean")
        fail(`constraint ${constraint.id} is malformed`);
      const from = point(constraint.from, `constraint ${constraint.id}.from`),
        to = point(constraint.to, `constraint ${constraint.id}.to`);
      if (![from.x, from.y, to.x, to.y].every((n) => Number.isInteger(n * 2)))
        fail(
          `constraint ${constraint.id} endpoints must be on the half-cell lattice`,
        );
      if (!inClosure(from, local) || !inClosure(to, local))
        fail(
          `constraint ${constraint.id} endpoint is outside the structure footprint`,
        );
      constraints.push({
        placementId,
        value: constraint,
        from: world(from, placement),
        to: world(to, placement),
      });
    }
    manifest.placements.push({
      id: placementId,
      structureId: structure.id,
      cells: structure.cells.length,
      segments: segments.length,
    });
  }

  // Post-process: Adapt "any" cells on tile boundaries.
  // Because WFC matchVertex ensures no conflicting strict segments, an "any" cell
  // will receive at most one strict region type from its neighbors.
  let adapted = true;
  while (adapted) {
    adapted = false;
    const newClass = [...cellClass];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (cellClass[i] === "any") {
          const owner = cellOwner[i];
          const neighbors = [
            { nx: x, ny: y - 1 },
            { nx: x, ny: y + 1 },
            { nx: x - 1, ny: y },
            { nx: x + 1, ny: y }
          ];
          for (const n of neighbors) {
            if (n.nx >= 0 && n.nx < width && n.ny >= 0 && n.ny < height) {
              const ni = n.ny * width + n.nx;
              if (cellOwner[ni] !== owner && cellClass[ni] !== "any") {
                newClass[i] = cellClass[ni];
                adapted = true;
                break;
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < cellClass.length; i++) {
      cellClass[i] = newClass[i];
    }
  }
  
  // Resolve remaining "any" to "open"
  for (let i = 0; i < cellClass.length; i++) {
    if (cellClass[i] === "any") {
      cellClass[i] = "open";
    }
  }

  for (let i = 0; i < cellClass.length; i++)
    cellSolid[i] = false;

  // Unstated internal seams are open. Exterior and material interfaces are derived,
  // rather than being an accidental consequence of placement order.
  for (let y = 0; y < height; y++)
    for (let x = 0; x <= width; x++) {
      const left = x > 0 && mask.has(key(x - 1, y)),
        right = x < width && mask.has(key(x, y));
      if (
        left &&
        right &&
        !cellSolid[y * width + x - 1] &&
        !cellSolid[y * width + x]
      )
        segmentOpen[segmentIndex(true, x, y)] = [0, 1];
    }
  for (let y = 0; y <= height; y++)
    for (let x = 0; x < width; x++) {
      const above = y > 0 && mask.has(key(x, y - 1)),
        below = y < height && mask.has(key(x, y));
      if (
        above &&
        below &&
        !cellSolid[(y - 1) * width + x] &&
        !cellSolid[y * width + x]
      )
        segmentOpen[segmentIndex(false, y, x)] = [0, 1];
    }
  for (const [index, declared] of declarations) {
    if (segmentOpen[index] === null && declared !== null) {
      // Tolerate apertures pointing into the void. If it's a solid cell boundary, it stays null.
      continue;
    }
    segmentOpen[index] = declared;
  }
  const pieces: Wall[] = [];
  const emit = (vertical: boolean, line: number, lo: number, hi: number) => {
    if (hi - lo > EPS)
      pieces.push(
        vertical
          ? { x1: line, y1: lo, x2: line, y2: hi }
          : { x1: lo, y1: line, x2: hi, y2: line },
      );
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x <= width; x++) {
      if (!(
        (x > 0 && mask.has(key(x - 1, y))) ||
        (x < width && mask.has(key(x, y)))
      ))
        continue;
      const open = segmentOpen[segmentIndex(true, x, y)];
      if (open === null) emit(true, x, y, y + 1);
      else {
        emit(true, x, y, y + open[0]);
        emit(true, x, y + open[1], y + 1);
      }
    }
  for (let y = 0; y <= height; y++)
    for (let x = 0; x < width; x++) {
      if (!(
        (y > 0 && mask.has(key(x, y - 1))) ||
        (y < height && mask.has(key(x, y)))
      ))
        continue;
      const open = segmentOpen[segmentIndex(false, y, x)];
      if (open === null) emit(false, y, x, x + 1);
      else {
        emit(false, y, x, x + open[0]);
        emit(false, y, x + open[1], x + 1);
      }
    }
  const map: MacroComposition = {
    version: 1,
    seed: input.seed,
    segmentOpen,
    constraints: constraints.map(({ placementId, value, from, to }) => ({
      placementId,
      id: value.id,
      radius: value.radius,
      connected: value.connected,
      from: { ...from },
      to: { ...to },
    })),
    width,
    height,
    walls: mergeRuns(pieces),
    cellClass,
    cellSolid,
    cellOwner,
    navBoxes: [...mask]
      .filter((k) => {
        const [x, y] = k.split(",").map(Number);
        return !cellSolid[y * width + x];
      })
      .map((k) => {
        const [x, y] = k.split(",").map(Number);
        return [x, y, x + 1, y + 1];
      }),
    regions: searchRegions(
      { W: width, H: height, cellClass, segmentOpen, segmentIndex },
      input.seed,
    ),
    entrances,
    corridors,
    manifest,
  };
  // The composed geometry is final here, so the shared recheck is the authority
  // on corridors and constraints. Its observations, not its objects, are kept.
  const report = checkMacroRoutes(map);
  if (!report.valid) fail(report.errors.join("; "));
  manifest.corridorsChecked = report.corridorsChecked;
  manifest.constraints = report.constraints.map((entry) => ({ ...entry }));
  return map;
}
