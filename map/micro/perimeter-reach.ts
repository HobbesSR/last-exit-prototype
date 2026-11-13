import { createFillMask, elementShapes, shapesOverlap } from './geometry.ts';
import { ownedOf, stretchesOf, type HintedRegion } from './hints.ts';
import { LIMITS } from './limits.ts';
import { expectPlaced, placedElements } from './placeables/placeable.ts';
import { WALL_RUN } from './placeables/wall-run.ts';
import type { WallRunParams } from './placeables/wall-run.ts';
import type { AddressedArea } from './addressed.ts';
import { disjoint } from '../../shared/shape-construction.ts';
import type { Shape } from '../../shared/shape.ts';
import type { ObstacleAppearance } from '../../shared/types.ts';
import { commitEach, type SitingCanvas } from './canvas.ts';
import type { Cell, RegionBrief, RegionElement } from './types.ts';
import type { Run } from '../kernel/run.ts';
import type { ProspectiveParcels } from './prospective-parcels.ts';

/**
 * Which perimeter runs a builder selects (17.2.11: "hinted or not", #835). `hinted` is the
 * brief's hints. `unguaranteed` adds every other perimeter stretch no portal holds. A brief
 * does not say what is across an unhinted stretch, so that includes the map's edge.
 */
export type PerimeterEdges = 'hinted' | 'unguaranteed';

const segmentKey = (axis: 'h' | 'v', x: number, y: number): string => `${axis}:${x},${y}`;

/**
 * The region's perimeter runs without a passability guarantee, for `runs`: its hints in hint
 * order, then with `unguaranteed` each maximal straight unhinted stretch no portal holds, with
 * the region on one side, horizontal before vertical, each in row order. Those stop at
 * corners, hints, portals and `LIMITS.run`. Portal margins are not taken out here; the fill
 * mask does that wherever the runs are walled.
 */
export function perimeterRuns(region: HintedRegion, edges: PerimeterEdges = 'hinted'): Run[] {
  if (edges !== 'hinted' && edges !== 'unguaranteed') throw new RangeError(`Unknown perimeter edges: ${String(edges)}.`);
  const hints: Run[] = [...region.hints ?? []];
  if (edges === 'hinted') return hints;
  const owned = ownedOf(region), held = new Set<string>();
  for (const run of [...hints, ...region.portals ?? []]) for (let i = 0; i < run.length; i++)
    held.add(run.axis === 'h' ? segmentKey('h', run.x + i, run.y) : segmentKey('v', run.x, run.y + i));
  // Each free perimeter segment, filed by its line and the side the region lies on.
  const lines = new Map<string, { axis: 'h' | 'v'; line: number; side: number; at: number[] }>();
  const add = (axis: 'h' | 'v', x: number, y: number, side: number) => {
    if (held.has(segmentKey(axis, x, y))) return;
    const line = axis === 'h' ? y : x, id = `${axis}:${line}:${side}`;
    let entry = lines.get(id);
    if (!entry) lines.set(id, entry = { axis, line, side, at: [] });
    entry.at.push(axis === 'h' ? x : y);
  };
  for (const { x, y } of region.cells) {
    if (!owned.has(`${x},${y - 1}`)) add('h', x, y, 1);
    if (!owned.has(`${x},${y + 1}`)) add('h', x, y + 1, -1);
    if (!owned.has(`${x - 1},${y}`)) add('v', x, y, 1);
    if (!owned.has(`${x + 1},${y}`)) add('v', x + 1, y, -1);
  }
  const free: (Run & { side: number })[] = [];
  for (const { axis, line, side, at } of lines.values()) {
    at.sort((a, b) => a - b);
    for (let i = 0; i < at.length;) {
      let j = i + 1;
      while (j < at.length && at[j] === at[j - 1]! + 1 && j - i < LIMITS.run) j++;
      free.push(axis === 'h' ? { axis, x: at[i]!, y: line, length: j - i, side } : { axis, x: line, y: at[i]!, length: j - i, side });
      i = j;
    }
  }
  free.sort((a, b) => (a.axis === b.axis ? 0 : a.axis === 'h' ? -1 : 1) || a.y - b.y || a.x - b.x || a.side - b.side);
  return [...hints, ...free.map(({ axis, x, y, length }) => ({ axis, x, y, length }))];
}

export interface PerimeterReachOptions {
  /** Explicit perimeter runs, hinted or not (`perimeterRuns`). Defaults to the brief's hints; [] selects none. */
  runs?: readonly Run[];
  kind: WallRunParams['kind'];
  /** Cells across each wall. Default a quarter, as `hut`'s and `ruins`' walls are. */
  thickness?: number;
  /** Cells between a wall and the selected perimeter line. Default none. */
  inset?: number;
  /** Shapes no wall may overlap: the builder's protected routes and its own pieces. */
  avoid?: readonly Shape[];
  /** The builder's addressed area (20.2): addressed cells get no wall, and the walled cells are marked. */
  addressed?: AddressedArea;
  /** The fewest cells a wall may run; shorter stretches are left bare. Default 1. */
  minLength?: number;
  /** Prefixed to each wall's label. Default `perimeter-wall`. */
  label?: string;
  /** Optional obstacle appearance for the wall runs. */
  appearance?: ObstacleAppearance | undefined;
}

export interface PerimeterWalls {
  /** One `wall-run` per walled stretch, in selected run order, then along each run. */
  elements: RegionElement[];
  /** Their collision shapes in world units, in the same order. */
  shapes: Shape[];
  /** The cells the walls stand in, without repeats. */
  cells: Cell[];
}

/**
 * Plain `wall-run`s along selected perimeter runs (#837), for a builder with nothing more
 * particular planned there. Each wall stands in the region's cells beside a run, against its
 * line. A cell gets no wall outside the fill area (20.6), so portal margins stay clear; nor
 * where it is addressed, or where its wall would overlap a shape in `avoid`. Passing the
 * builder's protected routes there keeps the portal promise as it keeps it for its own pieces.
 * What is left of each run is walled in maximal stretches of `minLength` cells or more.
 *
 * Defaults to hints; explicit `runs` may include unstated edges. Selection is builder policy,
 * never a new guarantee or a margin exemption. Fill masks exclude resolved guarantees and
 * their end caps even when a selected run spans them. This plans candidates only; use
 * `reachPerimeter` to prove and commit them. Walls at a convex corner share a cell.
 */
export function perimeterWalls(brief: RegionBrief, options: PerimeterReachOptions): PerimeterWalls {
  const { runs = brief.hints ?? [], kind, thickness = 0.25, inset = 0, avoid = [], addressed, minLength = 1, label = 'perimeter-wall', appearance } = options;
  if (!Number.isInteger(minLength) || minLength < 1) throw new RangeError('A perimeter wall needs a whole positive minimum length.');
  const fill = createFillMask(brief), size = brief.cellSize, owned = ownedOf(brief);
  const result: PerimeterWalls = { elements: [], shapes: [], cells: [] }, walled = new Map<string, Cell>();
  for (const hint of runs) {
    const stretches = stretchesOf(hint, owned), { inward } = stretches[0]!;
    const shape = { turned: hint.axis === 'v', side: inward.x + inward.y > 0 ? 'start' : 'end', thickness, inset, kind, ...(appearance ? { appearance } : {}) } as const;
    const place = (cells: readonly Cell[]) => expectPlaced(WALL_RUN.build({ length: cells.length, ...shape }, size));
    let run: Cell[] = [];
    const flush = () => {
      if (run.length >= minLength) {
        const [first] = run as [Cell];
        const elements = placedElements(place(run), `${label}-${hint.axis}-${first.x}-${first.y}`, first.x, first.y, size);
        result.elements.push(...elements);
        result.shapes.push(...elements.flatMap(e => elementShapes(e)));
        for (const c of run) walled.set(`${c.x},${c.y}`, c);
      }
      run = [];
    };
    for (const { cell } of stretches) {
      const fits = fill.has(cell.x, cell.y) && !addressed?.addressed(cell.x, cell.y)
        && !elementShapes(placedElements(place([cell]), label, cell.x, cell.y, size)[0]!).some(wall => avoid.some(o => shapesOverlap(wall, o)));
      if (fits) run.push(cell);
      else flush();
    }
    flush();
  }
  result.cells = [...walled.values()];
  if (addressed && !addressed.markCells(result.cells)) throw new Error('Perimeter walls overlap an area already addressed.');
  return result;
}

/**
 * Commits `walls` through a builder canvas (20.2) as one assembly, since walls at a convex
 * corner overlap. Their addressed intent is their own shapes, each less the walls before it
 * (`disjoint`, 29), as they share cells with the builder's pieces. The walls avoided the
 * builder's pieces and routes, so a refusal is a broken placement invariant. With `passOver`,
 * as on a coordinator whose live cord may refuse them (20.10), a refused set is split into
 * smaller batches, leaving out each wall the canvas refuses (a corner wall overlapping
 * a kept one among them). Returns what was committed.
 * Use `passOver` only with a planner given no `addressed` ledger: planning marks that
 * ledger eagerly, and this committer cannot undo marks for refused candidates.
 */
export function commitPerimeterWalls(canvas: SitingCanvas, walls: PerimeterWalls, options: { passOver?: boolean } = {}): Pick<PerimeterWalls, 'elements' | 'shapes'> {
  if (!walls.elements.length || canvas.commit({ elements: walls.elements, areas: disjoint(walls.shapes), extents: walls.shapes })) return walls;
  if (!options.passOver) throw new Error('Perimeter walls failed their canvas commit.');
  // Each wall its own assembly, in hint order, committed as far as they stand together;
  // a wall the canvas refuses is left out (`commitEach`, #787).
  const shapes = walls.elements.map(element => elementShapes(element));
  const kept = commitEach(canvas, walls.elements.map((element, i) => ({ elements: [element], areas: disjoint(shapes[i]!), extents: shapes[i]! })));
  return { elements: walls.elements.filter((_, i) => kept[i]), shapes: shapes.filter((_, i) => kept[i]).flat() };
}

/**
 * Offer perimeter walls to a live-cord coordinator, keeping only accepted walls. Pass the
 * coordinator itself, not its unproved stage canvas. The planner's optional addressed ledger
 * is intentionally unavailable here: only accepted geometry may acquire committed intent.
 * Candidate order is run order, then along each run; no RNG or runtime IDs are consumed.
 */
export function reachPerimeter(canvas: ProspectiveParcels, brief: RegionBrief, options: Omit<PerimeterReachOptions, 'addressed'>): Pick<PerimeterWalls, 'elements' | 'shapes'> {
  // JS callers and structurally wider TS variables can still carry this property.
  const planning: PerimeterReachOptions = { ...options };
  delete planning.addressed;
  return commitPerimeterWalls(canvas, perimeterWalls(brief, planning), { passOver: true });
}
