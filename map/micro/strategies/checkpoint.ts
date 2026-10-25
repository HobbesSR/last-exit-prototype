import type { BuildingObserver } from '../building/trace.ts';
import { CHECKPOINT_BARRIER } from '../placeables/checkpoint-barrier.ts';
import { WAREHOUSE } from '../placeables/warehouse.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot } from './scatter.ts';
import { draw } from '../random.ts';
import { capsule, createAccessMask, createFillMask, createRegionMask, elementShapes, findRegionRoute, shapesOverlap, travelClear } from '../geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../portals.ts';
import { boxesAgainstHints } from '../hints.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { createBuilderCanvas } from '../canvas.ts';
import type { Shape } from '../../../shared/shape.ts';
import { rect } from '../../../shared/shape.ts';
import type { BuiltRegion, Portal, RegionBrief, RegionElement } from '../types.ts';
import { builtRegion } from '../result.ts';

/** Barrier gaps and post spacing, as well as clear space around each post. */
const AISLE = CELL_SCALE.doorway;
/** Barrier start/end clearance; portal reach is checked after each placement. */
const BARRIER_MARGIN = 1, POST_SETBACK = 5, PITCH = 4;
/** How far a barrier reaches either side of the line, in cells, where the region is that wide. */
const REACH = 4;
/** A barrier's thickness in cells, centred in its column. */
const THICK = 0.5;
/** The post's box in cells: its long side, and its short side. The warehouse design wants at least 6 × 5. */
const LONG = [6, 7, 8], SHORT = [5, 6];
/** How many places to try for the post, nearest first, before it is left out. */
const POST_TRIES = 6;

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { start: 1, side: 2, long: 3, short: 4, tie: 5, loot: 6, design: 7 };

type Box = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };

const centre = (portal: Portal): Point => portal.axis === 'h'
  ? { x: portal.x + portal.length / 2, y: portal.y } : { x: portal.x, y: portal.y + portal.length / 2 };

/**
 * The `checkpoint` region type (54): a military choke. Chicane barriers stand across the line
 * between the region's two farthest portals, alternating sides, and a small roofed post stands
 * beside them. It has no decomposer.
 *
 * The line runs from one portal's centre to the other's (the first in id order, when several
 * pairs are as far apart). Barriers stand on it `PITCH` cells apart, from one cell in at a
 * seeded offset, each a thin wall across the line's longer axis. A barrier reaches `REACH` cells
 * either side of the line, or as far as the region goes, and attaches to the region's edge on one
 * side and stops `AISLE` cells short of the other. The sides alternate along the line, so a body
 * crossing slaloms, and a wall of ruin stops sight along it. Where the region is wider than the
 * barrier a body can go round, which slows a crossing without sealing it.
 *
 * The post is a roofed box of 6 to 8 by 5 or 6 cells, built as `depot`'s warehouse is (56). It
 * stands nearest the chicane's middle, off the line and clear of every barrier. It keeps only
 * the cells beside portals clear; boxes against hinted perimeter runs are tried first. A region
 * with one portal, or none, has no line: its post stands
 * nearest the portal, or the region's middle, and a region with no room for either is `open`
 * (17 M24).
 *
 * The promise is kept by pruning during the solve, not by retry: the empty shape is checked
 * once with the independent validator. Swept routes then connect nearby portals into a tree
 * and join the stands along each portal. A new piece off those paths keeps the evidence;
 * affected paths are searched again, and blocked threshold crossings are refused immediately.
 * A barrier that fails is left out and the next goes on; a post that fails is left out and
 * the next place is tried. Nothing is
 * rebuilt. A region whose own shape breaks the promise is `open`.
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every piece, indoors or out. A checkpoint sites no core elements; any the brief lists are left
 * for the report. `observe`, when given, sees the post's design as `depot` reports its warehouses.
 */
export function buildCheckpoint(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const mask = createFillMask(brief), accessMask = createAccessMask(brief), size = brief.cellSize;
  if (!mask.cells.length) return unfilledRegion(brief, CHANNEL.loot);
  const stands = portalStands(brief), radius = hunterClearance(size);
  // Only accepted pieces remain in `elements`, so each trial extends the accepted
  // blocker prefix. Cached capsules cover actual hunter sweeps: the portal tree plus
  // each portal's joined stands proves connectivity. A new piece disjoint from every
  // capsule cannot break those routes; affected routes are searched against all blockers.
  // Rejected trials leave both the accepted prefix and its proof unchanged.
  type Evidence = { a: Point; b: Point; swept: Shape[] };
  let acceptedCount = 0, proof: Evidence[] | undefined;
  const evidence = (points: Point[]): Evidence => ({ a: points[0]!, b: points[points.length - 1]!,
    swept: points.slice(1).flatMap((p, i) => capsule(points[i]!, p, radius)) });
  // A stand straddles the seam, so its body is the crossing (20.6).
  const crossings = stands.flatMap(({ points }) => points.flatMap(point => capsule(point, point, radius)));
  const holds = (blockers: readonly Shape[]) => {
    if (stands.length < 2) return true;
    const added = blockers.slice(acceptedCount);
    // This is the same threshold collision test as the independent validator,
    // done before any route searches and only against the new piece.
    if (added.some(shape => crossings.some(crossing => shapesOverlap(shape, crossing)))) return false;
    if (proof) {
      const next: Evidence[] = [];
      for (const path of proof) {
        if (!added.some(shape => path.swept.some(sweep => shapesOverlap(shape, sweep)))) { next.push(path); continue; }
        const route = findRegionRoute(accessMask, blockers, path.a, path.b, radius);
        if (!route) return false;
        next.push(evidence(route));
      }
      proof = next;
      acceptedCount = blockers.length;
      return true;
    }
    const checked = validatePortalReach({ ...brief, blockers: [...blockers] });
    if (!checked.valid) return false;
    const paths: Evidence[] = [];
    // A tree of nearby portals is enough to establish connectivity, and avoids
    // keeping a long diagonal from the first portal to every other one.
    const connected = new Set([0]);
    while (connected.size < stands.length) {
      let pair: [number, number] | undefined, distance = Infinity;
      for (const a of connected) for (let b = 0; b < stands.length; b++) if (!connected.has(b)) {
        const p = stands[a]!.points[0]!, q = stands[b]!.points[0]!, d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < distance) { distance = d; pair = [a, b]; }
      }
      const [a, b] = pair!, p = stands[a]!.points[0]!, q = stands[b]!.points[0]!;
      const route = findRegionRoute(accessMask, blockers, p, q, radius);
      const fallback = checked.routes.find(r => r.to === stands[b]!.portal.id)?.points;
      if (!route && !fallback) { proof = undefined; acceptedCount = blockers.length; return true; }
      paths.push(evidence(route ?? fallback!)); connected.add(b);
    }
    for (const { points } of stands) for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      const route = travelClear(accessMask, blockers, a, b, radius) ? [a, b] : findRegionRoute(accessMask, blockers, a, b, radius);
      if (!route) { proof = undefined; acceptedCount = blockers.length; return true; }
      paths.push(evidence(route));
    }
    proof = paths;
    acceptedCount = blockers.length;
    return true;
  };
  if (!holds([])) return unfilledRegion(brief, CHANNEL.loot);

  // `elements` holds the accepted pieces and one trial; the canvas takes each accepted piece.
  const elements: RegionElement[] = [], canvas = createBuilderCanvas(brief);
  const blockers = (): Shape[] => elements.flatMap(element => elementShapes(element));
  // Siting and the route proof have already accepted the piece. A canvas refusal is a broken
  // placement invariant, rather than a new fallback that silently changes the seeded build.
  const commit = (element: RegionElement) => {
    if (!canvas.commit({ elements: [element] })) throw new Error(`Checkpoint placement ${element.label} failed its canvas commit.`);
  };
  const barriers: Box[] = [];

  // The line between the two farthest portals, and the barriers stood along it.
  const ends = brief.portals.map(portal => ({ id: portal.id, at: centre(portal) })).sort((a, b) => a.id < b.id ? -1 : 1);
  let line: [Point, Point] | undefined, farthest = -1;
  for (const [i, a] of ends.entries()) for (const b of ends.slice(i + 1)) {
    const span = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
    if (span > farthest) { farthest = span; line = [a.at, b.at]; }
  }
  if (line) {
    const [a, b] = line, alongX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    // u runs along the line's longer axis and v across it, so one loop serves both.
    const u = (p: Point) => alongX ? p.x : p.y, v = (p: Point) => alongX ? p.y : p.x;
    const owns = (iu: number, iv: number) => alongX ? mask.has(iu, iv) : mask.has(iv, iu);
    const sign = Math.sign(u(b) - u(a)) || 1, length = Math.abs(u(b) - u(a));
    const start = BARRIER_MARGIN + Math.floor(draw(brief.seed, 0, 0, CHANNEL.start) * 3);
    const first = draw(brief.seed, 0, 0, CHANNEL.side) < 0.5;
    for (let k = 0, along = start; along <= length - BARRIER_MARGIN; k++, along += PITCH) {
      const column = Math.floor(u(a) + sign * along), crossing = u(b) === u(a) ? v(a)
        : v(a) + (column + 0.5 - u(a)) / (u(b) - u(a)) * (v(b) - v(a));
      const home = Math.floor(crossing);
      if (!owns(column, home)) continue;
      let lo = home, hi = home + 1;
      while (lo - 1 > home - REACH && owns(column, lo - 1)) lo--;
      while (hi < home + 1 + REACH && owns(column, hi)) hi++;
      if (hi - lo < AISLE + 1) continue;
      // Attached on the low side for alternate stations, the high side for the rest.
      const low = (k % 2 === 0) === first;
      const [from, to] = low ? [lo, hi - AISLE] : [lo + AISLE, hi];
      const box: Box = alongX ? { x: column + (1 - THICK) / 2, y: from, w: THICK, h: to - from }
        : { x: from, y: column + (1 - THICK) / 2, w: to - from, h: THICK };
      const [element] = placedElements(expectPlaced(CHECKPOINT_BARRIER.build({ w: box.w, h: box.h }, size)),
        `checkpoint-barrier-${barriers.length + 1}`, box.x, box.y, size) as [RegionElement];
      elements.push(element);
      if (holds(blockers())) { commit(element); barriers.push(box); } else elements.pop();
    }
  }

  // The post, at the nearest place off the line that keeps its aisle, and keeps the promise.
  const lineAlongX = line ? Math.abs(line[1].x - line[0].x) >= Math.abs(line[1].y - line[0].y) : mask.bounds.w >= mask.bounds.h;
  const owned = mask.cells, bounds = mask.bounds;
  const anchor: Point = barriers.length ? { x: barriers.reduce((s, c) => s + c.x + c.w / 2, 0) / barriers.length, y: barriers.reduce((s, c) => s + c.y + c.h / 2, 0) / barriers.length }
    : line ? { x: (line[0].x + line[1].x) / 2, y: (line[0].y + line[1].y) / 2 }
    : brief.portals.length === 1 ? inward(brief.portals[0]!, createRegionMask(brief)) : { x: (bounds.x + bounds.w / 2) / size, y: (bounds.y + bounds.h / 2) / size };
  const longSide = LONG[Math.floor(draw(brief.seed, 0, 0, CHANNEL.long) * LONG.length)]!, shortSide = SHORT[Math.floor(draw(brief.seed, 0, 0, CHANNEL.short) * SHORT.length)]!;
  const [pw, ph] = lineAlongX ? [longSide, shortSide] : [shortSide, longSide];
  const onLine = (box: Box) => !!line && Array.from({ length: Math.ceil(farthest * 2) + 1 }, (_, i) => i / Math.max(1, Math.ceil(farthest * 2)))
    .some(t => { const p = { x: line![0].x + (line![1].x - line![0].x) * t, y: line![0].y + (line![1].y - line![0].y) * t };
      return p.x > box.x - AISLE && p.x < box.x + box.w + AISLE && p.y > box.y - AISLE && p.y < box.y + box.h + AISLE; });
  // Only the barriers are committed yet, so the post keeps its aisle from them.
  const fits = ({ x, y, w, h }: Box) => {
    const shape = rect(x * size, y * size, w * size, h * size);
    return canvas.fits(shape) && canvas.spaced(shape, AISLE * size);
  };
  const hinted = new Set(boxesAgainstHints(brief, pw, ph).map(({ x, y }) => `${x},${y}`));
  const sites: { box: Box; hinted: boolean; near: number; tie: number }[] = [];
  for (const { x, y } of owned) {
    const box = { x, y, w: pw, h: ph };
    if (!fits(box) || onLine(box)) continue;
    sites.push({ box, hinted: hinted.has(`${x},${y}`), near: Math.hypot(x + pw / 2 - anchor.x, y + ph / 2 - anchor.y), tie: draw(brief.seed, x, y, CHANNEL.tie) });
  }
  sites.sort((a, b) => Number(b.hinted) - Number(a.hinted) || a.near - b.near || a.tie - b.tie || a.box.y - b.box.y || a.box.x - b.box.x);
  let posts = 0, designed = 0;
  for (const { box } of sites.slice(0, POST_TRIES)) {
    const seed = Math.floor(draw(brief.seed, box.x, box.y, CHANNEL.design) * 2 ** 31);
    const built = expectPlaced(WAREHOUSE.build({ w: box.w, h: box.h, alongX: box.w >= box.h, seed }, size)), { design, allocation, realization, rejected } = built.details;
    const [element] = placedElements(built, 'checkpoint-post-1', box.x, box.y, size) as [RegionElement];
    elements.push(element);
    if (!holds(blockers())) { elements.pop(); continue; }
    commit(element);
    if (design.spaces.length > 1) designed++;
    observe?.({ label: element.label, origin: { x: box.x * size, y: box.y * size }, cellSize: size, design, allocation, realization, ...rejected.length ? { rejected } : {} });
    posts = 1;
    break;
  }
  if (!posts && !barriers.length) return unfilledRegion(brief, CHANNEL.loot);

  const placed = [...canvas.elements];
  const loot = cellLoot(brief, createRegionMask(brief), placed.flatMap(element => elementShapes(element, true)), CHANNEL.loot);
  return builtRegion(brief, placed, loot, [], { barriers: barriers.length, posts, designed });
}

/** A point `POST_SETBACK` cells inside a portal's centre, for a region with one portal. */
function inward(portal: Portal, mask: { has(x: number, y: number): boolean }): Point {
  const at = centre(portal), h = portal.axis === 'h';
  // The portal's first segment has the region on its after side (right or below) or its before side.
  const sign = mask.has(portal.x, portal.y) ? 1 : -1;
  return h ? { x: at.x, y: at.y + sign * POST_SETBACK } : { x: at.x + sign * POST_SETBACK, y: at.y };
}
