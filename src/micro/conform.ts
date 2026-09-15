/**
 * The perimeter contract, enforced.
 *
 * Macro states what must be able to cross each region boundary -- a floor
 * (`PerimeterPort.required`) and a ceiling (`allowed`) -- and then proves the
 * map reachable on the region graph from the floors alone. That proof is only
 * worth anything if micro actually honours the floors, so something has to
 * check, and that is this module. It is what lets the plan path drop the
 * reserved street network and the repair pass the legacy path needs: macro no
 * longer has to thread routes through finished geometry, because the geometry
 * is required to leave the routes open in the first place.
 *
 * `checkConformance` reports; `conformRegionEdit` is the same check applied as
 * a policy, in three ordered passes -- raise the ports below their floor, cap
 * the ports above their ceiling, then restore reachability between the ports
 * inside the region.
 *
 * Only segments are ever touched. Spawns, props, cell edits, vertices and
 * features come out exactly as the builder stated them, and that is a promise
 * with a consequence: a prop pinches a route in a way this module does not and
 * cannot see, because a prop is off-lattice detail inside one cell and nothing
 * here reads one. That stays `clearance.ts`'s business, and it is a real gap
 * rather than a rounding error -- a builder may satisfy every port here and
 * still hand the guard a region it has to open up.
 *
 * What a pass proves, exactly: the inside-reachability test is the `nav.ts`
 * lattice, whose every edge is an analytically checked swept-disc move, so a
 * route it finds is a real centered route for that body radius. It is a
 * sufficient test and not a necessary one -- a body may physically fit through
 * a gap the half-cell lattice cannot sample -- so a pass proves a centered
 * swept-disc route exists and a failure does not prove that none does. Failing
 * closed is deliberate, and per AGENTS.md none of it may be restated as a proof
 * about geometry that was not itself checked.
 *
 * On the legacy path `context.ports` is absent: regions there are discovered
 * from cell classes after the fact and there is no macro plan to honour. Then
 * `checkConformance` returns `ok` with no port reports and `conformRegionEdit`
 * returns the edit unchanged, which is what lets both paths share one set of
 * builders instead of forking them.
 */
import { PASSAGE_RANK, admitsPassage } from "../plan/types.ts";
import { latticeFor, nodeIndex, occupiable, reachable } from "../nav.ts";
import { segmentCells, segmentGridIndex } from "./edit.ts";
import { PASSAGE, admits, clearanceFor } from "./scale.ts";
import type { Box, NavTarget, Span, Wall } from "../types.ts";
import type {
  Passage,
  PerimeterPort,
  RegionContext,
  RegionEdit,
  SegmentEdit,
  SegmentRef,
} from "./types.ts";

/** Below this a span is not an opening and two openings are one opening. */
const WIDTH_EPS = 1e-9;

export interface PortReport {
  portId: string;
  width: number;
  admits: Passage;
  required: Passage;
  allowed: Passage;
  ok: boolean;
  problem?: "below-floor" | "above-ceiling" | "unreachable-inside";
}

export interface ConformanceReport {
  ok: boolean;
  ports: PortReport[];
  failures: string[];
}

/**
 * The widest body an opening of `width` segments admits.
 *
 * The thresholds come from `scale.ts` rather than from literals here, so the
 * body brief stays owned by one table: `PASSAGE.squeeze` is the contestant
 * clearance and `PASSAGE.door` the hunter one.
 */
function bandOf(width: number): Passage {
  if (admits(width + WIDTH_EPS, clearanceFor("hunter"))) return "hunter";
  if (admits(width + WIDTH_EPS, clearanceFor("contestant")))
    return "contestant";
  return "none";
}

/** The narrowest opening that satisfies a floor of `band`. */
function widthFor(band: Passage): number {
  return band === "none" ? 0 : clearanceFor(band);
}

/**
 * The widest continuous opening across a run of spans, measured end to end.
 *
 * A port is a run of segments, not a segment, and its passage width is a
 * property of the run: two adjacent segments each open `[0, 1]` are one
 * opening two units across, which is the difference between a door a hunter
 * fits through and two that nothing does. Consecutive entries are treated as
 * adjacent -- that is what "ordered along the boundary" means on a
 * `PerimeterPort` -- so segment `i` occupies `[i, i + 1]` of one line and two
 * openings join only where one ends exactly where the next begins.
 */
function runWidth(spans: readonly Span[]): number {
  let best = 0;
  let start = 0;
  let end = 0;
  let open = false;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    if (!span || span[1] - span[0] <= WIDTH_EPS) {
      open = false;
      continue;
    }
    const lo = i + span[0],
      hi = i + span[1];
    if (open && lo <= end + WIDTH_EPS) end = Math.max(end, hi);
    else {
      start = lo;
      end = hi;
      open = true;
    }
    best = Math.max(best, end - start);
  }
  return best;
}

/**
 * The spans of a run of `count` segments carrying one centered opening `width`
 * across, which is how `edit.ts` shapes a door and so how a gate this module
 * punches reads the same as one a builder placed.
 */
function gateSpans(count: number, width: number): Span[] {
  const open = Math.min(Math.max(width, 0), count);
  const lo = (count - open) / 2,
    hi = (count + open) / 2;
  const spans: Span[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = Math.min(1, Math.max(0, lo - i)),
      b = Math.min(1, Math.max(0, hi - i));
    spans.push(b - a <= WIDTH_EPS ? null : [a, b]);
  }
  return spans;
}

/** The smallest span containing both. Widening only; never a narrowing. */
function hull(a: Span, b: Span): Span {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

function spanWidth(span: Span): number {
  return span ? Math.max(0, span[1] - span[0]) : 0;
}

function isFullyOpen(span: Span): boolean {
  return !!span && span[0] <= WIDTH_EPS && span[1] >= 1 - WIDTH_EPS;
}

/**
 * What a segment is currently open by, under this edit.
 *
 * A declaration in the edit wins. Otherwise the region's own `openings` are
 * consulted, which is the only record micro is given of what a boundary
 * segment already carried, and an undeclared segment nobody reported is taken
 * as clear: the lattice a plan-path region is handed starts open, and micro
 * declares barriers rather than absences.
 */
function readerFor(context: RegionContext, segments: readonly SegmentEdit[]) {
  const { mask } = context;
  const declared = new Map<number, Span>();
  for (const segment of segments)
    declared.set(
      segmentGridIndex(mask.width, mask.height, segment.ref),
      segment.open,
    );
  const known = new Map<number, number>();
  for (const opening of context.openings)
    known.set(
      segmentGridIndex(mask.width, mask.height, opening),
      opening.width,
    );
  return (ref: SegmentRef): Span => {
    const index = segmentGridIndex(mask.width, mask.height, ref);
    if (declared.has(index)) return declared.get(index)!;
    const width = known.get(index);
    if (width === undefined) return [0, 1];
    if (width >= 1 - WIDTH_EPS) return [0, 1];
    if (width <= WIDTH_EPS) return null;
    // Centered, the same convention `scale.centeredSpan` gives an aperture,
    // because an opening records how much is open and never where.
    return [0.5 - width / 2, 0.5 + width / 2];
  };
}

/**
 * The widest continuous opening across a run of segments, given the edit.
 *
 * This is the crux of the contract: macro compares bands, and a band is only
 * meaningful if the width behind it is measured over the whole port rather
 * than segment by segment.
 */
export function portWidth(
  context: RegionContext,
  edit: RegionEdit,
  port: PerimeterPort,
): number {
  const spanAt = readerFor(context, edit.segments);
  return runWidth(port.segments.map(spanAt));
}

/** The local frame the inside check runs in: map coordinates minus an origin. */
interface Frame {
  target: NavTarget;
  box: Box;
  ox: number;
  oy: number;
}

/** Zero, one or two barriers, exactly as `core.deriveWalls` reads a span. */
function barriersOf(
  ref: SegmentRef,
  span: Span,
  ox: number,
  oy: number,
): Wall[] {
  const runs: Array<[number, number]> = span
    ? [
        [ref.offset, ref.offset + span[0]],
        [ref.offset + span[1], ref.offset + 1],
      ]
    : [[ref.offset, ref.offset + 1]];
  const walls: Wall[] = [];
  for (const [lo, hi] of runs) {
    if (hi - lo < WIDTH_EPS) continue;
    walls.push(
      ref.vertical
        ? { x1: ref.line - ox, y1: lo - oy, x2: ref.line - ox, y2: hi - oy }
        : { x1: lo - ox, y1: ref.line - oy, x2: hi - ox, y2: ref.line - oy },
    );
  }
  return walls;
}

/**
 * The region and its segment declarations as a navigable target.
 *
 * The frame is the region bounding box exactly, translated to the origin by
 * whole cells so every half-cell lattice node keeps its alignment, and with no
 * padding at all. That is load-bearing rather than thrifty, and `clearance.ts`
 * says why at length: a lattice evaluates no node outside its target, so
 * ending the frame at the bounding box is the only thing stopping a body from
 * leaving through one port, walking around the outside of the region and
 * arriving at another. Pad it and every severance test passes for the wrong
 * reason.
 *
 * Every mask boundary segment that is not a port is sealed, so the region's
 * surroundings are opaque and a route found here never borrows ground the
 * region does not own. The ports themselves stay as declared, because a body
 * standing in a doorway is standing half in it. One consequence is worth
 * stating: for a region whose bounding box contains cells it does not own, a
 * route could in principle leave by one port and re-enter by another within
 * the box. It is the same conservative shape `clearance.ts` accepts, and it
 * errs toward reporting a region connected, not toward breaking one.
 *
 * Props are deliberately absent. This module may only edit segments, so
 * including geometry it could never open would make it drop walls that were
 * not the problem.
 */
function frameFor(
  context: RegionContext,
  segments: readonly SegmentEdit[],
  ports: ReadonlySet<number>,
): Frame {
  const { mask } = context;
  const [bx0, by0, bx1, by1] = mask.bounds;
  const ox = bx0,
    oy = by0;
  const walls: Wall[] = [];
  for (const segment of segments)
    walls.push(...barriersOf(segment.ref, segment.open, ox, oy));

  const sealed = new Set<number>();
  for (const cell of mask.cells)
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const nx = cell.x + dx,
        ny = cell.y + dy;
      if (mask.has(nx, ny)) continue;
      const ref: SegmentRef =
        dx !== 0
          ? { vertical: true, line: dx > 0 ? nx : cell.x, offset: cell.y }
          : { vertical: false, line: dy > 0 ? ny : cell.y, offset: cell.x };
      const index = segmentGridIndex(mask.width, mask.height, ref);
      if (ports.has(index) || sealed.has(index)) continue;
      sealed.add(index);
      walls.push(...barriersOf(ref, null, ox, oy));
    }

  return {
    target: { width: bx1 + 1 - ox, height: by1 + 1 - oy, walls },
    box: [0, 0, bx1 + 1 - ox, by1 + 1 - oy],
    ox,
    oy,
  };
}

/**
 * The half-cell nodes inside one cell, centre first.
 *
 * A two-segment doorway is passable on its own midline, which falls on a cell
 * corner and not on a cell centre, so a port judged from cell centres alone
 * would read as sealed while a hunter walked through it.
 */
function nodesInCell(x: number, y: number): Array<{ x: number; y: number }> {
  const steps = [0.5, 0, 1];
  const nodes: Array<{ x: number; y: number }> = [];
  for (const dy of steps)
    for (const dx of steps) nodes.push({ x: x + dx, y: y + dy });
  return nodes;
}

interface StandingNode {
  x: number;
  y: number;
  index: number;
}

/** The cell of a segment that belongs to this region, or null for neither. */
function insideCellOf(
  context: RegionContext,
  ref: SegmentRef,
): { x: number; y: number } | null {
  const [a, b] = segmentCells(ref);
  if (context.mask.has(a.x, a.y)) return a;
  if (context.mask.has(b.x, b.y)) return b;
  return null;
}

/** Where a body of `radius` may stand just inside a port, deduplicated. */
function portNodes(
  context: RegionContext,
  frame: Frame,
  radius: number,
  port: PerimeterPort,
): StandingNode[] {
  const found: StandingNode[] = [];
  const seen = new Set<number>();
  for (const ref of port.segments) {
    const cell = insideCellOf(context, ref);
    if (!cell) continue;
    for (const node of nodesInCell(cell.x - frame.ox, cell.y - frame.oy)) {
      if (!occupiable(frame.target, radius, node.x, node.y)) continue;
      const index = nodeIndex(frame.target, node.x, node.y);
      if (index < 0 || seen.has(index)) continue;
      seen.add(index);
      found.push({ x: node.x, y: node.y, index });
    }
  }
  return found;
}

/** Which required ports are mutually reachable inside the region, and at what. */
interface InsideReach {
  connected: Set<string>;
  /** Required ports with nowhere inside the region to stand at all. */
  stranded: Set<string>;
  anchor: PerimeterPort | null;
  body: "contestant" | "hunter";
  radius: number;
}

/**
 * Are the required ports mutually reachable within the region?
 *
 * The radius is the strictest floor any of them carries, as the body actually
 * in force says it -- `context.clearance`, not the design band -- because the
 * band is what has to fit through the port and the body is what has to walk
 * between them. Fewer than two required ports cannot fail the mutual test.
 */
function insideReach(
  context: RegionContext,
  segments: readonly SegmentEdit[],
  ports: readonly PerimeterPort[],
): InsideReach {
  const required = ports.filter((port) => port.required !== "none");
  const body: "contestant" | "hunter" = required.some(
    (port) => port.required === "hunter",
  )
    ? "hunter"
    : "contestant";
  const radius = context.clearance[body];
  const reach: InsideReach = {
    connected: new Set(),
    stranded: new Set(),
    anchor: null,
    body,
    radius,
  };
  if (required.length < 2 || context.mask.area <= 1) {
    for (const port of required) reach.connected.add(port.id);
    return reach;
  }

  const open = new Set<number>();
  for (const port of ports)
    for (const ref of port.segments)
      open.add(segmentGridIndex(context.mask.width, context.mask.height, ref));
  const frame = frameFor(context, segments, open);
  // Built once here so every flood below shares one proven lattice.
  latticeFor(frame.target, radius);

  const served = required.map((port) => ({
    port,
    nodes: portNodes(context, frame, radius, port),
  }));
  for (const entry of served)
    if (!entry.nodes.length) reach.stranded.add(entry.port.id);

  // Flood from the first port with standing room, trying each of its own nodes
  // in turn and keeping the widest result, so one walled-off corner node
  // cannot make a whole region look severed.
  const anchor = served.find((entry) => entry.nodes.length);
  if (!anchor) return reach;
  reach.anchor = anchor.port;
  let found = new Set<number>();
  for (const node of anchor.nodes) {
    const seen = reachable(frame.target, radius, node.x, node.y, frame.box);
    if (seen.size > found.size) found = seen;
  }
  for (const entry of served)
    if (entry.nodes.some((node) => found.has(node.index)))
      reach.connected.add(entry.port.id);
  return reach;
}

/**
 * Does this edit satisfy the perimeter contract macro planned?
 *
 * Every port is measured end to end, compared against its floor and its
 * ceiling, and -- for the ports carrying a floor -- checked to be mutually
 * reachable inside the region at the clearance the strictest of them needs.
 *
 * With no `context.ports` there is no plan to honour, so this reports `ok`
 * with no port reports: the legacy path builds the same builders and must not
 * be failed by a contract it was never given.
 */
export function checkConformance(
  context: RegionContext,
  edit: RegionEdit,
): ConformanceReport {
  const ports = context.ports;
  if (!ports?.length) return { ok: true, ports: [], failures: [] };

  const spanAt = readerFor(context, edit.segments);
  const failures: string[] = [];
  const reports: PortReport[] = ports.map((port) => {
    const width = runWidth(port.segments.map(spanAt));
    const band = bandOf(width);
    const report: PortReport = {
      portId: port.id,
      width,
      admits: band,
      required: port.required,
      allowed: port.allowed,
      ok: true,
    };
    if (!admitsPassage(band, port.required)) {
      report.ok = false;
      report.problem = "below-floor";
      failures.push(
        `port ${port.id} opens ${width.toFixed(3)} (${band}) below its floor of ${port.required}`,
      );
    } else if (PASSAGE_RANK[band] > PASSAGE_RANK[port.allowed]) {
      report.ok = false;
      report.problem = "above-ceiling";
      failures.push(
        `port ${port.id} opens ${width.toFixed(3)} (${band}) above its ceiling of ${port.allowed}`,
      );
    }
    return report;
  });

  const reach = insideReach(context, edit.segments, ports);
  const byId = new Map(reports.map((report) => [report.portId, report]));
  for (const port of ports) {
    if (port.required === "none") continue;
    if (reach.connected.has(port.id)) continue;
    const report = byId.get(port.id)!;
    report.ok = false;
    if (!report.problem) report.problem = "unreachable-inside";
    failures.push(
      reach.stranded.has(port.id)
        ? `port ${port.id} has no standing room inside the region for a ${reach.body} (radius ${reach.radius})`
        : `port ${port.id} is cut off inside the region from port ${
            reach.anchor?.id ?? "any other"
          } for a ${reach.body} (radius ${reach.radius})`,
    );
  }

  return { ok: failures.length === 0, ports: reports, failures };
}

/**
 * The edit's segments in one canonical order, last declaration winning.
 *
 * Ascending grid index is the order `edit.ts` already emits, so a canvas edit
 * passes through untouched; an edit assembled some other way is normalised to
 * it. That is what makes this pass independent of the order a builder happened
 * to declare in, which a seed sweep depends on.
 */
function canonicalSegments(
  context: RegionContext,
  segments: readonly SegmentEdit[],
): Map<number, SegmentEdit> {
  const { mask } = context;
  const byIndex = new Map<number, SegmentEdit>();
  for (const segment of segments)
    byIndex.set(segmentGridIndex(mask.width, mask.height, segment.ref), {
      ref: { ...segment.ref },
      open: segment.open,
    });
  return new Map([...byIndex.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * Where to put a gate of `length` segments on a port.
 *
 * Preference order, and every tier of it is there to make the result read as a
 * built opening rather than as damage: the run that is already most open,
 * because re-opening what a builder left ajar respects its intent more than
 * cutting somewhere fresh; then the run nearest the middle of the port,
 * because a gate in a corner reads as a mistake; then the lowest start index,
 * because ties still have to be decided the same way every run.
 */
function chooseRun(spans: readonly Span[], length: number): number {
  const last = spans.length - length;
  let bestStart = 0;
  let bestOpen = -1;
  let bestOffset = Infinity;
  for (let start = 0; start <= last; start += 1) {
    let open = 0;
    for (let i = start; i < start + length; i += 1) open += spanWidth(spans[i]);
    const offset = Math.abs(start + length / 2 - spans.length / 2);
    if (
      open > bestOpen + WIDTH_EPS ||
      (open > bestOpen - WIDTH_EPS && offset < bestOffset - WIDTH_EPS)
    ) {
      bestStart = start;
      bestOpen = open;
      bestOffset = offset;
    }
  }
  return bestStart;
}

/** How many segments a continuous opening of `width` needs to live on. */
function runLength(width: number): number {
  return Math.max(1, Math.ceil(width - WIDTH_EPS));
}

/**
 * The same check, applied: an edit that satisfies the contract.
 *
 * Three ordered passes, each deterministic in the edit alone -- no stream is
 * drawn from, because a repair that moved with the rng would make a seed sweep
 * unreadable:
 *
 * 1. Raise every port below its floor, by opening a contiguous run in the
 *    middle of the port wide enough to admit `required`. Existing spans are
 *    only ever widened here, so nothing a builder opened is taken away.
 * 2. Cap every port above its ceiling. `allowed: "contestant"` is left exactly
 *    the squeeze `scale.isSqueeze` recognises -- every contestant, no hunter --
 *    which is how a planned squeeze survives a builder that would rather have
 *    left the whole side open; `allowed: "none"` is sealed.
 * 3. Restore reachability between the ports carrying a floor, by dropping the
 *    edit's own interior barriers, most recently declared first and
 *    cumulatively, never a port segment.
 *
 * Only `segments` changes. Spawns, obstacles, cells, vertices and features are
 * passed through byte for byte, which means the one thing this pass cannot
 * repair is a prop pinching a route -- see the module note; that is
 * `clearance.ts`'s job and this does not pretend to cover it.
 *
 * Narrowing defers to `context.isStandingRoom`, for the same reason the canvas
 * refuses it there: a barrier on the edge of ground another pass requires a
 * body to stand on makes the map invalid. A ceiling that cannot be met without
 * one is left unmet and reported rather than met and broken.
 *
 * With no `context.ports` this returns the edit unchanged, by identity. There
 * is no plan on the legacy path, so there is nothing to conform to.
 */
export function conformRegionEdit(
  context: RegionContext,
  edit: RegionEdit,
): RegionEdit {
  const ports = context.ports;
  if (!ports?.length) return edit;

  const { mask } = context;
  const indexOf = (ref: SegmentRef) =>
    segmentGridIndex(mask.width, mask.height, ref);
  const working = canonicalSegments(context, edit.segments);
  const base = readerFor(context, edit.segments);
  const spanAt = (ref: SegmentRef): Span => {
    const index = indexOf(ref);
    return working.has(index) ? working.get(index)!.open : base(ref);
  };
  const declare = (ref: SegmentRef, open: Span) => {
    working.set(indexOf(ref), { ref: { ...ref }, open });
  };
  const mayNarrow = (ref: SegmentRef) => {
    const [a, b] = segmentCells(ref);
    return (
      !context.isStandingRoom(a.x, a.y) && !context.isStandingRoom(b.x, b.y)
    );
  };

  let raised = 0,
    capped = 0,
    dropped = 0;
  /** Where step 1 put a gate, so step 2 narrows that gate rather than another. */
  const gates = new Map<string, number>();

  // 1. Raise every port below its floor.
  for (const port of ports) {
    if (port.required === "none" || !port.segments.length) continue;
    const spans = port.segments.map(spanAt);
    if (admitsPassage(bandOf(runWidth(spans)), port.required)) continue;
    const need = widthFor(port.required);
    const length = Math.min(port.segments.length, runLength(need));
    const start = chooseRun(spans, length);
    const gate = gateSpans(length, Math.min(need, length));
    for (let i = 0; i < length; i += 1)
      declare(port.segments[start + i], hull(spans[start + i], gate[i]));
    // A port shorter than its own floor cannot carry it however it is opened.
    // Opening it all the way is the most this pass can do; `checkConformance`
    // then reports the port as below-floor rather than this failing silently.
    if (
      !admitsPassage(bandOf(runWidth(port.segments.map(spanAt))), port.required)
    )
      for (const ref of port.segments) declare(ref, [0, 1]);
    gates.set(port.id, start);
    raised += 1;
  }

  // 2. Cap every port above its ceiling.
  for (const port of ports) {
    if (port.allowed === "hunter" || !port.segments.length) continue;
    const spans = port.segments.map(spanAt);
    if (PASSAGE_RANK[bandOf(runWidth(spans))] <= PASSAGE_RANK[port.allowed])
      continue;
    if (port.allowed === "none") {
      for (const ref of port.segments) if (mayNarrow(ref)) declare(ref, null);
      capped += 1;
      continue;
    }
    // A squeeze: a contiguous run carrying exactly `PASSAGE.squeeze`, and
    // nothing open anywhere else on the port, since the width is measured over
    // the whole run and a second gap would widen it again.
    const length = Math.min(port.segments.length, runLength(PASSAGE.squeeze));
    const start = gates.get(port.id) ?? chooseRun(spans, length);
    const gate = gateSpans(length, Math.min(PASSAGE.squeeze, length));
    port.segments.forEach((ref, i) => {
      if (!mayNarrow(ref)) return;
      const within = i >= start && i < start + length;
      declare(ref, within ? gate[i - start] : null);
    });
    capped += 1;
  }

  // 3. Restore reachability between the ports that carry a floor.
  const protectedSegments = new Set<number>();
  for (const port of ports)
    for (const ref of port.segments) protectedSegments.add(indexOf(ref));
  let list = [...working.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, segment]) => segment);
  const severed = () => {
    const reach = insideReach(context, list, ports);
    return ports.some(
      (port) => port.required !== "none" && !reach.connected.has(port.id),
    );
  };
  if (severed())
    // Most recently declared first and cumulatively, exactly as
    // `guardRegionEdit` does it: two walls in series across one route both have
    // to go before either helps, so a drop is never put back for having failed
    // to fix things on its own. A blunt policy that produces a legal edit
    // rather than the best one; a builder that minds its floors places fewer.
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const segment = list[i];
      if (protectedSegments.has(indexOf(segment.ref))) continue;
      if (isFullyOpen(segment.open)) continue;
      list = list.slice(0, i).concat(list.slice(i + 1));
      dropped += 1;
      if (!severed()) break;
    }

  if (!raised && !capped && !dropped) return edit;
  const notes = { ...(edit.manifest.notes ?? {}) };
  if (raised) notes.conformRaised = (notes.conformRaised ?? 0) + raised;
  if (capped) notes.conformCapped = (notes.conformCapped ?? 0) + capped;
  if (dropped) notes.conformDropped = (notes.conformDropped ?? 0) + dropped;
  return { ...edit, segments: list, manifest: { ...edit.manifest, notes } };
}
