import { rect } from '../../../shared/shape.ts';
import type { BuildingObserver } from '../building/trace.ts';
import { buildOpen } from './open.ts';
import { warehouse } from './depot.ts';
import { cellLoot, draw } from './scatter.ts';
import { createRegionMask, elementShapes } from '../geometry.ts';
import { validatePortalReach } from '../portals.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, Portal, RegionBrief, RegionElement } from '../types.ts';

/**
 * Clear cells around the post's box, from the region's edge and from every barrier, and the width of
 * the gap a barrier leaves: a doorway (52), so a hunter fits each.
 */
const AISLE = CELL_SCALE.doorway;
/** Cells from a portal to the first barrier, and between barriers along the line. */
const MARGIN = 5, PITCH = 4;
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
 * pairs are as far apart). Barriers stand on it `PITCH` cells apart, from `MARGIN` cells in at a
 * seeded offset, each a thin wall across the line's longer axis. A barrier reaches `REACH` cells
 * either side of the line, or as far as the region goes, and attaches to the region's edge on one
 * side and stops `AISLE` cells short of the other. The sides alternate along the line, so a body
 * crossing slaloms, and a wall of ruin stops sight along it. Where the region is wider than the
 * barrier a body can go round, which slows a crossing without sealing it.
 *
 * The post is a roofed box of 6 to 8 by 5 or 6 cells, built as `depot`'s warehouse is (56). It
 * stands nearest the chicane's middle, off the line, with `AISLE` clear cells from the region's
 * edge and from every barrier. A region with one portal, or none, has no line: its post stands
 * nearest the portal, or the region's middle, and a region with no room for either is `open`
 * (17 M24).
 *
 * The promise is kept by pruning during the solve, not by retry: the empty shape is checked
 * once, and every piece is kept only while the elective flood check (`validatePortalReach`)
 * still finds a hunter route between every pair of portals. A barrier that fails it is left out
 * and the next goes on; a post that fails is left out and the next place is tried. Nothing is
 * rebuilt. A region whose own shape breaks the promise is `open`.
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every piece, indoors or out. A checkpoint sites no core elements; any the brief lists are left
 * for the report. `observe`, when given, sees the post's design as `depot` reports its warehouses.
 */
export function buildCheckpoint(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const mask = createRegionMask(brief), size = brief.cellSize;
  const holds = (blockers: readonly Shape[]) => brief.portals.length < 2
    || validatePortalReach({ cells: brief.cells, cellSize: size, portals: brief.portals, blockers: [...blockers] }).valid;
  if (!holds([])) return buildOpen(brief);

  const elements: RegionElement[] = [];
  const blockers = (): Shape[] => elements.flatMap(element => elementShapes(element));
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
    const start = MARGIN + Math.floor(draw(brief.seed, 0, 0, CHANNEL.start) * 3);
    const first = draw(brief.seed, 0, 0, CHANNEL.side) < 0.5;
    for (let k = 0, along = start; along <= length - MARGIN; k++, along += PITCH) {
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
      const element: RegionElement = { label: `checkpoint-barrier-${barriers.length + 1}`, x: box.x * size, y: box.y * size,
        template: { w: box.w * size, h: box.h * size, parts: [{ part: 'obstacle', kind: 'ruin-wall', shape: rect(0, 0, box.w * size, box.h * size) }] } };
      elements.push(element);
      if (holds(blockers())) barriers.push(box); else elements.pop();
    }
  }

  // The post, at the nearest place off the line that keeps its aisle, and keeps the promise.
  const lineAlongX = line ? Math.abs(line[1].x - line[0].x) >= Math.abs(line[1].y - line[0].y) : mask.bounds.w >= mask.bounds.h;
  const owned = mask.cells, bounds = mask.bounds;
  const anchor: Point = barriers.length ? { x: barriers.reduce((s, c) => s + c.x + c.w / 2, 0) / barriers.length, y: barriers.reduce((s, c) => s + c.y + c.h / 2, 0) / barriers.length }
    : line ? { x: (line[0].x + line[1].x) / 2, y: (line[0].y + line[1].y) / 2 }
    : brief.portals.length === 1 ? inward(brief.portals[0]!, mask) : { x: (bounds.x + bounds.w / 2) / size, y: (bounds.y + bounds.h / 2) / size };
  const longSide = LONG[Math.floor(draw(brief.seed, 0, 0, CHANNEL.long) * LONG.length)]!, shortSide = SHORT[Math.floor(draw(brief.seed, 0, 0, CHANNEL.short) * SHORT.length)]!;
  const [pw, ph] = lineAlongX ? [longSide, shortSide] : [shortSide, longSide];
  const touches = (box: Box, other: Box) => box.x < other.x + other.w + AISLE && box.x + box.w + AISLE > other.x && box.y < other.y + other.h + AISLE && box.y + box.h + AISLE > other.y;
  const onLine = (box: Box) => !!line && Array.from({ length: Math.ceil(farthest * 2) + 1 }, (_, i) => i / Math.max(1, Math.ceil(farthest * 2)))
    .some(t => { const p = { x: line![0].x + (line![1].x - line![0].x) * t, y: line![0].y + (line![1].y - line![0].y) * t };
      return p.x > box.x - AISLE && p.x < box.x + box.w + AISLE && p.y > box.y - AISLE && p.y < box.y + box.h + AISLE; });
  const fits = ({ x, y, w, h }: Box) => {
    for (let j = y - AISLE; j < y + h + AISLE; j++) for (let i = x - AISLE; i < x + w + AISLE; i++) if (!mask.has(i, j)) return false;
    return true;
  };
  const sites: { box: Box; near: number; tie: number }[] = [];
  for (const { x, y } of owned) {
    const box = { x, y, w: pw, h: ph };
    if (!fits(box) || barriers.some(b => touches(box, b)) || onLine(box)) continue;
    sites.push({ box, near: Math.hypot(x + pw / 2 - anchor.x, y + ph / 2 - anchor.y), tie: draw(brief.seed, x, y, CHANNEL.tie) });
  }
  sites.sort((a, b) => a.near - b.near || a.tie - b.tie || a.box.y - b.box.y || a.box.x - b.box.x);
  let posts = 0, designed = 0;
  for (const { box } of sites.slice(0, POST_TRIES)) {
    const seed = Math.floor(draw(brief.seed, box.x, box.y, CHANNEL.design) * 2 ** 31);
    const built = warehouse(size, box.w, box.h, box.w >= box.h, seed);
    const element: RegionElement = { label: 'checkpoint-post-1', x: box.x * size, y: box.y * size, template: built.template };
    elements.push(element);
    if (!holds(blockers())) { elements.pop(); continue; }
    if (built.design.spaces.length > 1) designed++;
    observe?.({ label: element.label, origin: { x: box.x * size, y: box.y * size }, cellSize: size, design: built.design, allocation: built.allocation,
      realization: built.realization, ...built.rejected.length ? { rejected: built.rejected } : {} });
    posts = 1;
    break;
  }
  if (!posts && !barriers.length) return buildOpen(brief);

  const parts = elements.flatMap(element => element.template.parts);
  const loot = cellLoot(brief, mask, elements.flatMap(element => elementShapes(element, true)), CHANNEL.loot);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: posts, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0,
      barriers: barriers.length, posts, designed } };
}

/** A point `MARGIN` cells inside a portal's centre, for a region with one portal. */
function inward(portal: Portal, mask: { has(x: number, y: number): boolean }): Point {
  const at = centre(portal), h = portal.axis === 'h';
  // The portal's first segment has the region on its after side (right or below) or its before side.
  const sign = mask.has(portal.x, portal.y) ? 1 : -1;
  return h ? { x: at.x, y: at.y + sign * MARGIN } : { x: at.x + sign * MARGIN, y: at.y };
}
