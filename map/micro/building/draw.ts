import { OUTSIDE } from './design.ts';
import type { BuildingConnection } from './design.ts';
import type { BuildingTrace } from './trace.ts';

/**
 * Drawing a strategy's building traces (56 L4), for the tools that show them: the micro lab
 * and the Map Lab's region drill-down (20.5, 53). Everything is drawn in world units, in the
 * pen's current transform, so each tool sets its own projection. `px` is one screen pixel in
 * world units: line widths, dots and text are given in screen pixels and scaled by it.
 */
export interface Pen {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  font: string;
  textAlign: unknown;
  textBaseline: unknown;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  setLineDash(segments: number[]): void;
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
}
type Point = { x: number; y: number };

export const SPACE_COLOURS = ['#5fa8d3', '#c77dff', '#e9c46a', '#80ed99', '#f28482', '#4cc9f0', '#f4a261', '#b5e48c'];
export const OPENING_COLOURS: Record<string, string> = { door: '#ff8a5c', open: '#7ee08a', window: '#6fc8ff' };
const WARNING = '#e9ad59';
const BACKING = '#0b1515';

/** Connections whose two spaces got no opening between them. Guidance, so a warning, never an error (17.2.8 M29). */
export function unmetConnections(trace: BuildingTrace): BuildingConnection[] {
  const placed = new Set(trace.realization.openings.map(o => o.connectionId));
  return trace.design.connections.filter(c => !placed.has(c.id));
}
export function spansOf(trace: BuildingTrace) {
  return trace.realization.boundaries.flatMap(boundary => boundary.spans.map(span => ({ boundary, span })));
}
/** A building in one line: "hut-building: 3 spaces, 2 connections, 3 openings, 9 spans". */
export function traceSummary(trace: BuildingTrace): string {
  const { design, realization } = trace, spaces = design.spaces.length;
  return `${trace.label}: ${spaces} space${spaces === 1 ? '' : 's'}, ${design.connections.length} connections, ${realization.openings.length} openings, ${spansOf(trace).length} spans`;
}
/** One line per connection a building didn't meet, with the realization's reason. */
export function guidanceNotMet(trace: BuildingTrace): string[] {
  return unmetConnections(trace).map(c => `Guidance not met: ${c.id} (${c.kind}, ${c.a}–${c.b}), ${trace.realization.misses.find(m => m.connectionId === c.id)?.reason ?? 'no opening'}`);
}
/** One line per design a strategy tried before this building's and didn't use, with why. */
export function designsNotUsed(trace: BuildingTrace): string[] {
  return (trace.rejected ?? []).map(({ design, reason }) => `Design not used: ${design}, ${reason}`);
}

const gridPoint =(x: number, y: number, size: number, at: Point): Point => ({ x: at.x + x * size, y: at.y + y * size });
const runEnd = (run: { axis: 'h' | 'v'; x: number; y: number; length: number }) => ({ x: run.x + (run.axis === 'h' ? run.length : 0), y: run.y + (run.axis === 'v' ? run.length : 0) });
/** The centre of some of a building's allocation cells, in world units. */
function centroid(trace: BuildingTrace, cells: readonly Point[]): Point {
  const n = cells.length || 1;
  return gridPoint(cells.reduce((s, c) => s + c.x + .5, 0) / n, cells.reduce((s, c) => s + c.y + .5, 0) / n, trace.cellSize, trace.origin);
}
/** A placed opening's two ends along its run, in world units. */
function openingEnds(trace: BuildingTrace, { run, center, length }: BuildingTrace['realization']['openings'][number]): [Point, Point] {
  const along = (d: number) => gridPoint(run.x + (run.axis === 'h' ? d : 0), run.y + (run.axis === 'v' ? d : 0), trace.cellSize, trace.origin);
  return [along(center - length / 2), along(center + length / 2)];
}
function line(g: Pen, a: Point, b: Point, colour: string, width: number, dash: number[] = []): void {
  g.save(); g.setLineDash(dash); g.strokeStyle = colour; g.lineWidth = width; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.restore();
}
function label(g: Pen, px: number, p: Point, text: string, colour: string): void {
  g.font = `${11 * px}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 3 * px; g.strokeStyle = BACKING;
  g.strokeText(text, p.x, p.y); g.fillStyle = colour; g.fillText(text, p.x, p.y);
}

/** Each space's allocated cells, in its colour, with its cell count above its centre. */
export function drawAllocation(g: Pen, traces: readonly BuildingTrace[], px: number): { cells: number } {
  let cells = 0;
  for (const trace of traces) trace.allocation.spaces.forEach((space, i) => {
    g.fillStyle = `${SPACE_COLOURS[i % SPACE_COLOURS.length]}66`;
    for (const c of space.cells) { const p = gridPoint(c.x, c.y, trace.cellSize, trace.origin); g.fillRect(p.x + px, p.y + px, trace.cellSize - 2 * px, trace.cellSize - 2 * px); cells++; }
  });
  // Above the centre, where the design graph's node sits.
  for (const trace of traces) trace.allocation.spaces.forEach((space, i) => { const c = centroid(trace, space.cells); label(g, px, { x: c.x, y: c.y - trace.cellSize * .8 }, `${space.cells.length} cells`, SPACE_COLOURS[i % SPACE_COLOURS.length]!); });
  return { cells };
}
/** Each span between two owners, dashed: blue onto the outside, violet between spaces. */
export function drawSpans(g: Pen, traces: readonly BuildingTrace[], px: number): { spans: number } {
  let spans = 0;
  for (const trace of traces) for (const { boundary, span } of spansOf(trace)) {
    const colour = boundary.a === OUTSIDE || boundary.b === OUTSIDE ? '#7fb2ff' : '#d38cff', at = (x: number, y: number) => gridPoint(x, y, trace.cellSize, trace.origin);
    for (const { run } of span.steps) { const end = runEnd(run); line(g, at(run.x, run.y), at(end.x, end.y), colour, 3 * px, [6 * px, 4 * px]); }
    const { run } = span.steps[0]!, end = runEnd(run);
    // A quarter along the first run, clear of an opening centred on it.
    label(g, px, at(run.x + (end.x - run.x) / 4, run.y + (end.y - run.y) / 4), `${boundary.a} | ${boundary.b}`, colour);
    spans++;
  }
  return { spans };
}
/** Each placed opening along its run, in its kind's colour, labelled with its connection. */
export function drawOpenings(g: Pen, traces: readonly BuildingTrace[], px: number): { openings: number } {
  let openings = 0;
  for (const trace of traces) for (const opening of trace.realization.openings) {
    const [a, b] = openingEnds(trace, opening), colour = OPENING_COLOURS[opening.kind]!;
    line(g, a, b, colour, 7 * px); label(g, px, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, opening.connectionId, colour); openings++;
  }
  return { openings };
}
/** Spaces as nodes at their cells' centre; connections as edges in their kind's colour, through their opening where placed. */
export function drawDesignGraph(g: Pen, traces: readonly BuildingTrace[], px: number): { nodes: number; edges: number; warnings: number } {
  let nodes = 0, edges = 0, warnings = 0;
  for (const trace of traces) {
    const cells = new Map(trace.allocation.spaces.map(s => [s.id, s.cells])), whole = centroid(trace, trace.allocation.footprint);
    const at = (id: string) => cells.get(id)?.length ? centroid(trace, cells.get(id)!) : whole;
    const missing = new Set(unmetConnections(trace).map(c => c.id));
    for (const connection of trace.design.connections) {
      const opening = trace.realization.openings.find(o => o.connectionId === connection.id), miss = missing.has(connection.id);
      const colour = miss ? WARNING : OPENING_COLOURS[connection.kind]!, dash = miss ? [5 * px, 5 * px] : [], outside = connection.a === OUTSIDE || connection.b === OUTSIDE;
      const inner = connection.a === OUTSIDE ? connection.b : connection.a, from = at(inner);
      let mid = from, to: Point;
      if (opening) { const [a, b] = openingEnds(trace, opening); mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
      if (outside) {
        // The outside sits a cell beyond the opening, or beyond the footprint on the preferred side when there is none.
        const dir = opening ? { x: mid.x - from.x, y: mid.y - from.y } : { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 }, E: { x: 1, y: 0 } }[connection.side ?? 'N'];
        const n = Math.hypot(dir.x, dir.y) || 1, reach = opening ? trace.cellSize : trace.cellSize * 3;
        to = { x: mid.x + dir.x / n * reach, y: mid.y + dir.y / n * reach };
      } else to = at(connection.a === inner ? connection.b : connection.a);
      line(g, from, mid, colour, 2 * px, dash); line(g, mid, to, colour, 2 * px, dash);
      if (outside) label(g, px, to, miss ? `! ${connection.id}` : OUTSIDE, colour);
      else if (miss) label(g, px, mid, `! ${connection.id}`, colour);
      edges++; if (miss) warnings++;
    }
    for (const space of trace.design.spaces) {
      const centre = at(space.id); g.fillStyle = '#f1f7ee'; g.strokeStyle = BACKING; g.lineWidth = 2 * px;
      g.beginPath(); g.arc(centre.x, centre.y, 7 * px, 0, Math.PI * 2); g.fill(); g.stroke();
      label(g, px, { x: centre.x, y: centre.y + 16 * px }, space.id, '#f1f7ee'); nodes++;
    }
  }
  return { nodes, edges, warnings };
}
