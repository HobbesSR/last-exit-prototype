/**
 * The clearance guard for micro edits.
 *
 * Containment is not sufficient. A builder that stayed inside its region can
 * still wall that region into disconnected halves, seal its own spawns away, or
 * close the last route a reserved corridor needed -- archived NEXT_TASKS item 4. So the
 * edit is replayed as geometry and flooded, rather than trusted.
 *
 * What this proves, exactly: `nav.ts` builds a half-cell lattice whose every
 * edge is an analytically checked swept-disc move, so a lattice route is a real
 * centered route for that body radius. It is a sufficient test and not a
 * necessary one -- a body may physically fit through a gap the half-cell
 * lattice cannot sample -- so a pass is a proof that a route exists and a
 * failure is not a proof that none does. Failing closed is deliberate, and this
 * is a geometric statement about the declared segments and props only: cell
 * class is not read here, so a cell painted `solid` is not yet a barrier to
 * this check.
 */
import { latticeFor, nodeIndex, occupiable, reachable } from "../nav.ts";
import { describeSegment, segmentGridIndex } from "./edit.ts";
import type { Box, NavTarget, Span, Wall } from "../types.ts";
import type {
  RegionContext,
  RegionEdit,
  RegionOpening,
  SegmentRef,
} from "./types.ts";

const SPAN_EPS = 1e-9;

export interface ClearanceReport {
  ok: boolean;
  failures: string[];
  /** Openings still mutually reachable inside the region, at the tested radius. */
  connected: number;
}

/** The local frame the check runs in: map coordinates minus an integer origin. */
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
    if (hi - lo < SPAN_EPS) continue;
    walls.push(
      ref.vertical
        ? { x1: ref.line - ox, y1: lo - oy, x2: ref.line - ox, y2: hi - oy }
        : { x1: lo - ox, y1: ref.line - oy, x2: hi - ox, y2: ref.line - oy },
    );
  }
  return walls;
}

/**
 * The region and its edits as a navigable target.
 *
 * It is built in a local frame -- the region bounding box, translated to the
 * origin -- because a `nav.ts` lattice spans its whole target and a region is a
 * small part of a map. The translation is by whole cells, so every half-cell
 * lattice node keeps its alignment.
 *
 * The frame is the bounding box exactly, with no margin around it, and that is
 * load-bearing rather than thrifty: a lattice evaluates no node outside its
 * target, so ending the frame at the region boundary is what stops a body from
 * stepping out through one opening, walking around the outside, and coming back
 * in through another. This check asks whether the openings are reachable from
 * each other *inside* the region.
 *
 * The walls are the barrier geometry of every declared segment, every prop, and
 * a seal on every mask boundary that is not a declared opening. That last one
 * treats the region surroundings as opaque, which is the conservative
 * direction: a route this check finds never depends on borrowing space the
 * region does not own.
 */
function frameFor(context: RegionContext, edit: RegionEdit): Frame {
  const { mask } = context;
  const [bx0, by0, bx1, by1] = mask.bounds;
  const ox = bx0,
    oy = by0;
  const width = bx1 + 1 - ox,
    height = by1 + 1 - oy;

  const walls: Wall[] = [];
  for (const segment of edit.segments)
    walls.push(...barriersOf(segment.ref, segment.open, ox, oy));
  for (const obstacle of edit.obstacles)
    walls.push({
      x1: obstacle.x1 - ox,
      y1: obstacle.y1 - oy,
      x2: obstacle.x2 - ox,
      y2: obstacle.y2 - oy,
    });

  const openings = new Set<number>(
    context.openings.map((opening) =>
      segmentGridIndex(mask.width, mask.height, opening),
    ),
  );
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
      if (openings.has(index) || sealed.has(index)) continue;
      sealed.add(index);
      walls.push(...barriersOf(ref, null, ox, oy));
    }

  return {
    target: { width, height, walls },
    box: [0, 0, width, height],
    ox,
    oy,
  };
}

/**
 * The half-cell nodes inside one cell, in local coordinates, centre first.
 *
 * An opening is represented by these rather than by its cell centre alone. A
 * two-segment doorway is passable on its own midline, which falls on a cell
 * corner and not on a cell centre, so insisting on the centre would report a
 * perfectly good door as sealed.
 */
function nodesInCell(x: number, y: number): Array<{ x: number; y: number }> {
  const steps = [0.5, 0, 1];
  const nodes: Array<{ x: number; y: number }> = [];
  for (const dy of steps)
    for (const dx of steps) nodes.push({ x: x + dx, y: y + dy });
  return nodes;
}

/** A lattice node the check can stand on: its local position and its index. */
interface StandingNode {
  x: number;
  y: number;
  index: number;
}

function standingNodes(
  frame: Frame,
  radius: number,
  x: number,
  y: number,
): StandingNode[] {
  const found: StandingNode[] = [];
  for (const node of nodesInCell(x - frame.ox, y - frame.oy)) {
    if (!occupiable(frame.target, radius, node.x, node.y)) continue;
    const index = nodeIndex(frame.target, node.x, node.y);
    if (index >= 0) found.push({ x: node.x, y: node.y, index });
  }
  return found;
}

function describeOpening(opening: RegionOpening): string {
  return `${describeSegment(opening)} (cell ${opening.inside.x},${opening.inside.y})`;
}

/**
 * Does the region still work, for a body of this radius, after these edits?
 *
 * Every opening must keep standing room and stay mutually reachable from every
 * other, every spawn must be reachable from an opening, and every reserved
 * corridor must stay traversable at its own radius. A region of one cell, or of
 * one opening, cannot fail the mutual test and is judged on its spawns.
 */
export function checkRegionEdit(
  context: RegionContext,
  edit: RegionEdit,
  radius: number,
): ClearanceReport {
  const { mask } = context;
  const failures: string[] = [];
  if (mask.area <= 1)
    return { ok: true, failures, connected: context.openings.length };

  const frame = frameFor(context, edit);
  const { target, box } = frame;
  // Built once here so every flood below shares one proven lattice per radius.
  latticeFor(target, radius);

  const served = context.openings.map((opening) => ({
    opening,
    nodes: standingNodes(frame, radius, opening.inside.x, opening.inside.y),
  }));
  for (const entry of served)
    if (!entry.nodes.length)
      failures.push(
        `opening ${describeOpening(entry.opening)} has no standing room for radius ${radius} inside the region`,
      );

  // Flood from the first opening that has standing room. Its own nodes are
  // tried in turn and the widest result kept, so a stray corner node that
  // happens to be walled off cannot make the whole region look severed.
  const anchorEntry = served.find((entry) => entry.nodes.length);
  const anchorNodes = anchorEntry
    ? anchorEntry.nodes
    : // With no openings at all the region is judged from its own first
      // standing cell, which is what its spawns have to be reachable from.
      (mask.cells
        .map((cell) => standingNodes(frame, radius, cell.x, cell.y))
        .find((nodes) => nodes.length) ?? []);
  let reach = new Set<number>();
  for (const node of anchorNodes) {
    const found = reachable(target, radius, node.x, node.y, box);
    if (found.size > reach.size) reach = found;
  }

  let connected = 0;
  for (const entry of served) {
    if (!entry.nodes.length) continue;
    if (entry.nodes.some((node) => reach.has(node.index))) {
      connected += 1;
      continue;
    }
    failures.push(
      `opening ${describeOpening(entry.opening)} is cut off from opening ${
        anchorEntry ? describeOpening(anchorEntry.opening) : "the region"
      } at radius ${radius}`,
    );
  }

  for (const spawn of edit.spawns) {
    const x = spawn.cellIndex % mask.width,
      y = Math.floor(spawn.cellIndex / mask.width);
    const nodes = standingNodes(frame, radius, x, y);
    if (nodes.some((node) => reach.has(node.index))) continue;
    failures.push(
      `spawn ${spawn.kind} at cell ${x},${y} cannot be reached at radius ${radius}`,
    );
  }

  // A corridor is a route through the region, so it usually starts and ends
  // outside one. Only the part of the centre line the region actually covers is
  // this pass to judge; a leg with an end outside the mask is left alone rather
  // than reported against geometry nobody here declared.
  const covers = (point: { x: number; y: number }) =>
    mask.has(Math.floor(point.x), Math.floor(point.y));
  context.corridors.forEach((corridor, index) => {
    const points = corridor.points;
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i]!;
      if (!covers(point)) continue;
      const lx = point.x - frame.ox,
        ly = point.y - frame.oy;
      if (!occupiable(target, corridor.radius, lx, ly)) {
        failures.push(
          `reserved corridor ${index} has no standing room at ${point.x},${point.y} for radius ${corridor.radius}`,
        );
        continue;
      }
      const previous = points[i - 1];
      if (!previous || !covers(previous)) continue;
      const from = reachable(
        target,
        corridor.radius,
        previous.x - frame.ox,
        previous.y - frame.oy,
        box,
      );
      if (!from.has(nodeIndex(target, lx, ly)))
        failures.push(
          `reserved corridor ${index} is severed between ${previous.x},${previous.y} and ${point.x},${point.y} at radius ${corridor.radius}`,
        );
    }
  });

  return { ok: failures.length === 0, failures, connected };
}

/**
 * The same check applied as a policy: an edit that passes, or the original when
 * it already did.
 *
 * Only segment declarations are dropped, because a wall is the only thing this
 * edit can contain that severs a route -- a prop lives inside one cell and a
 * spawn is not geometry at all -- and only those carrying a barrier, since a
 * fully open declaration can sever nothing. They go most recently added first,
 * cumulatively: two walls in series across one corridor both have to go before
 * either helps, so a drop is never put back for having failed to fix things on
 * its own. That makes this a blunt policy which produces a legal edit rather
 * than the best one, and a builder that cares should place fewer walls.
 */
export function guardRegionEdit(
  context: RegionContext,
  edit: RegionEdit,
  radius: number,
): RegionEdit {
  let report = checkRegionEdit(context, edit, radius);
  if (report.ok) return edit;

  let kept = [...edit.segments];
  let dropped = 0;
  for (let i = kept.length - 1; i >= 0 && !report.ok; i -= 1) {
    const span = kept[i]!.open;
    if (span && span[0] <= SPAN_EPS && span[1] >= 1 - SPAN_EPS) continue;
    kept = kept.slice(0, i).concat(kept.slice(i + 1));
    dropped += 1;
    report = checkRegionEdit(context, { ...edit, segments: kept }, radius);
  }

  const notes = { ...(edit.manifest.notes ?? {}) };
  notes.guardDropped = (notes.guardDropped ?? 0) + dropped;
  return {
    ...edit,
    segments: kept,
    manifest: {
      ...edit.manifest,
      // Reported from the check rather than from the builder: an edit that
      // still fails with every barrier gone was never the barriers fault.
      corridorsHonored: report.ok,
      notes,
    },
  };
}
