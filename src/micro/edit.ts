/**
 * The region canvas.
 *
 * A builder should not hand-assemble a `RegionEdit` and hope it is legal. It
 * declares over a canvas, which enforces the containment contract at the moment
 * each declaration is made, counts what it refused, and emits the edit. Per
 * docs/VOCABULARY.md nothing here is a physical object: a wall on a segment
 * states that something impassable occupies that edge, and what it is made of
 * is resolved much later.
 *
 * Containment is enforced here rather than checked afterwards because a builder
 * that has already drawn half a structure outside its area has no good way to
 * back out. Refusal is cheap and countable; repair is not. What containment
 * cannot decide -- whether the surviving geometry still leaves the region
 * usable -- belongs to `clearance.ts`, which is the judge of record.
 */
import { SIDES, SOLID_CLASS } from "../primitives.ts";
import { PASSAGE, centeredSpan } from "./scale.ts";
import type { Box, RegionSpawn, Side, Span, Wall } from "../types.ts";
import type {
  CellEdit,
  FeatureEdit,
  RegionContext,
  RegionEdit,
  RegionOpening,
  Rng,
  SegmentEdit,
  SegmentRef,
  VertexEdit,
} from "./types.ts";

/** Below this a span is not an opening and two spans are the same span. */
const SPAN_EPS = 1e-9;

export interface RoomOptions {
  /** Openings in the outline a body may pass. */
  doors?: number;
  doorWidth?: number;
  /** Apertures too narrow to pass: stated geometry, not passage. */
  windows?: number;
  windowWidth?: number;
  /** Class painted on the cells strictly inside the outline. */
  interiorClass?: string;
  /** Restrict which sides may take a door or window. */
  sides?: Side[];
  /** Stream used to choose placement, so two builders never interfere. */
  rng?: Rng;
}
export interface RoomResult {
  placed: boolean;
  box: Box;
  /** Every outline segment carrying part of a door; empty when refused. */
  doors: SegmentRef[];
}

export interface RegionCanvas {
  readonly context: RegionContext;
  readonly rejected: number;
  /** Mark a cell as taken by a structure, so a later pass does not reuse it. */
  claim(x: number, y: number): boolean;
  isClaimed(x: number, y: number): boolean;
  cell(
    x: number,
    y: number,
    edit: { class?: string; height?: number },
  ): boolean;
  vertex(
    x: number,
    y: number,
    meta: { class?: string; height?: number },
  ): boolean;
  /** The segment on one side of a cell. Pure addressing; declares nothing. */
  edgeOf(x: number, y: number, side: Side): SegmentRef;
  wall(ref: SegmentRef): boolean;
  open(ref: SegmentRef): boolean;
  /** A centered aperture of `width` segments; see scale.centeredSpan. */
  aperture(ref: SegmentRef, width: number): boolean;
  /** The segment between two orthogonally adjacent cells, or undefined. */
  between(
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): SegmentRef | undefined;
  /** Every segment forming the outline of an inclusive cell box. */
  outline(box: Box): SegmentRef[];
  /** Wall a box's outline, punch doors and windows, paint the interior. */
  room(box: Box, options?: RoomOptions): RoomResult;
  /** Off-lattice collidable detail. Refused unless it stays in one region cell. */
  prop(wall: Wall): boolean;
  /** A prop of `length` at `angle` radians about a cell centre. */
  propInCell(x: number, y: number, length: number, angle: number): boolean;
  spawn(cellIndex: number, kind: string): boolean;
  feature(kind: string, x: number, y: number): boolean;
  /** Increment a free-form counter surfaced in the manifest. */
  note(key: string, delta?: number): void;
  finish(generator: string): RegionEdit;
}

/**
 * The index a segment occupies in the map segment grid, which is what makes the
 * emitted order deterministic. This is the formula `core.makeGrids` and
 * `macro.ts` each build a closure from; it wants lifting into one shared
 * helper, which is a change to files this module does not own.
 */
export function segmentGridIndex(
  width: number,
  height: number,
  ref: SegmentRef,
): number {
  const verticals = (width + 1) * height;
  return ref.vertical
    ? ref.offset * (width + 1) + ref.line
    : verticals + ref.line * width + ref.offset;
}

/** The two cells a segment separates, in map cell coordinates. */
export function segmentCells(
  ref: SegmentRef,
): [{ x: number; y: number }, { x: number; y: number }] {
  return ref.vertical
    ? [
        { x: ref.line - 1, y: ref.offset },
        { x: ref.line, y: ref.offset },
      ]
    : [
        { x: ref.offset, y: ref.line - 1 },
        { x: ref.offset, y: ref.line },
      ];
}

/** Human-readable segment name, for diagnostics that have to be actionable. */
export function describeSegment(ref: SegmentRef): string {
  return `${ref.vertical ? "v" : "h"}:${ref.line},${ref.offset}`;
}

function spanWidth(span: Span): number {
  return span ? Math.max(0, span[1] - span[0]) : 0;
}

/**
 * The cell a prop lives in, or null when it does not live in exactly one.
 *
 * This is `core.cellsCrossed(...).length === 1` stated directly, and is exactly
 * equivalent to it: that walk starts at the cell of its first endpoint and
 * stops immediately only when the second endpoint floors to the same cell, so
 * one cell is one cell precisely when both floors agree. A prop merely touching
 * a cell boundary therefore counts as leaving, which is the invariant
 * `validateMap` enforces and `tests/micro.test.ts` pins. It is restated here
 * rather than imported because micro generation is a layer `core.ts` consumes,
 * and reaching back up for one predicate would make that a cycle.
 */
function soleCellOf(wall: Wall): [number, number] | null {
  const x = Math.floor(wall.x1),
    y = Math.floor(wall.y1);
  if (Math.floor(wall.x2) !== x || Math.floor(wall.y2) !== y) return null;
  return [x, y];
}

/**
 * The spans of a run of `count` collinear segments sharing one centered
 * aperture `width` segments across. A door wider than one segment is the
 * ordinary case -- `PASSAGE.door` is two -- and a single segment cannot be more
 * than fully open, so a door is a run rather than a segment.
 */
function runSpans(count: number, width: number): Span[] {
  const open = Math.min(Math.max(width, 0), count);
  const lo = (count - open) / 2,
    hi = (count + open) / 2;
  const spans: Span[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = Math.min(1, Math.max(0, lo - i)),
      b = Math.min(1, Math.max(0, hi - i));
    spans.push(b - a <= SPAN_EPS ? null : [a, b]);
  }
  return spans;
}

/** The four sides of an inclusive cell box, west to east and north to south. */
function outlineSides(box: Box): Array<{ side: Side; refs: SegmentRef[] }> {
  const [x0, y0, x1, y1] = box;
  const north: SegmentRef[] = [],
    south: SegmentRef[] = [],
    west: SegmentRef[] = [],
    east: SegmentRef[] = [];
  for (let x = x0; x <= x1; x += 1) {
    north.push({ vertical: false, line: y0, offset: x });
    south.push({ vertical: false, line: y1 + 1, offset: x });
  }
  for (let y = y0; y <= y1; y += 1) {
    west.push({ vertical: true, line: x0, offset: y });
    east.push({ vertical: true, line: x1 + 1, offset: y });
  }
  return [
    { side: "N", refs: north },
    { side: "E", refs: east },
    { side: "S", refs: south },
    { side: "W", refs: west },
  ];
}

export function createCanvas(context: RegionContext): RegionCanvas {
  const { mask } = context;
  const cells = new Map<number, CellEdit>();
  const segments = new Map<number, SegmentEdit>();
  const vertices = new Map<number, VertexEdit>();
  const spawns = new Map<number, RegionSpawn>();
  const features = new Map<string, FeatureEdit>();
  const obstacles: Wall[] = [];
  const claimed = new Set<number>();
  const notes: Record<string, number> = {};
  const openings = new Map<number, RegionOpening>();
  for (const opening of context.openings)
    openings.set(segmentGridIndex(mask.width, mask.height, opening), opening);

  let rejected = 0;
  /** Every refusal is counted, so what a builder lost is visible downstream. */
  const refuse = (): false => {
    rejected += 1;
    return false;
  };
  const note = (key: string, delta = 1) => {
    notes[key] = (notes[key] ?? 0) + delta;
  };

  /** The region owns a cell only while no other pass has been given it. */
  const owns = (x: number, y: number) =>
    mask.has(x, y) && !context.isReserved(x, y);
  /** Widest body in force, as a diameter: what an opening has to admit. */
  const widestBody =
    2 * Math.max(context.clearance.contestant, context.clearance.hunter);

  const setSpan = (ref: SegmentRef, span: Span): boolean => {
    const [a, b] = segmentCells(ref);
    // A region legitimately owns the segments on its own boundary -- that is
    // how a compound gets a perimeter wall -- but it must not reach past them
    // into a neighbour interior.
    if (!owns(a.x, a.y) && !owns(b.x, b.y)) return refuse();
    // Nothing may be stated on the edge of standing room. A wall there sits
    // half a cell from a point another pass requires a body to be able to
    // occupy -- a tile anchor, the room behind an opening -- and the map is
    // invalid. Only narrowing is refused: a builder may still open such a
    // segment, which can only help.
    //
    // This belongs here rather than in each builder. Containment already lets a
    // builder state a segment when just one of its two cells is its own, so a
    // builder minding its own cells still reaches the edge of an anchor's, and
    // every builder would have to remember the same rule. One did not, and the
    // map it produced was rejected for an anchor inside geometry.
    if (
      spanWidth(span) < 1 - SPAN_EPS &&
      (context.isStandingRoom(a.x, a.y) || context.isStandingRoom(b.x, b.y))
    )
      return refuse();
    const index = segmentGridIndex(mask.width, mask.height, ref);
    const opening = openings.get(index);
    if (opening) {
      // An opening is at most as open as the one segment carrying it.
      const was = Math.min(1, opening.width);
      const now = spanWidth(span);
      if (now < was - SPAN_EPS) {
        // A required opening is not the builder to close, at any width.
        if (opening.required) return refuse();
        // Otherwise the clearance pass is the judge and this is allowed; the
        // canvas only records that the edit left an opening too tight for the
        // widest body in force.
        if (now < widestBody) note("narrowed");
      }
    }
    segments.set(index, { ref: { ...ref }, open: span });
    return true;
  };

  const canvas: RegionCanvas = {
    context,
    get rejected() {
      return rejected;
    },

    claim(x, y) {
      if (!owns(x, y)) return refuse();
      const index = mask.indexOf(x, y);
      // Losing a race for a cell is an ordinary outcome rather than a breach of
      // containment, so it reports false without counting against the builder.
      if (claimed.has(index)) return false;
      claimed.add(index);
      return true;
    },
    isClaimed(x, y) {
      return mask.has(x, y) && claimed.has(mask.indexOf(x, y));
    },

    cell(x, y, edit) {
      if (!owns(x, y)) return refuse();
      const cellIndex = mask.indexOf(x, y);
      cells.set(cellIndex, { cellIndex, ...edit });
      return true;
    },

    vertex(x, y, meta) {
      // A vertex is a corner of up to four cells; owning any one of them is
      // enough, by the same argument that lets a region wall its own boundary.
      const touches: Array<[number, number]> = [
        [x - 1, y - 1],
        [x, y - 1],
        [x - 1, y],
        [x, y],
      ];
      if (!touches.some(([cx, cy]) => owns(cx, cy))) return refuse();
      vertices.set(y * (mask.width + 1) + x, { x, y, ...meta });
      return true;
    },

    edgeOf(x, y, side) {
      switch (side) {
        case "N":
          return { vertical: false, line: y, offset: x };
        case "S":
          return { vertical: false, line: y + 1, offset: x };
        case "W":
          return { vertical: true, line: x, offset: y };
        default:
          return { vertical: true, line: x + 1, offset: y };
      }
    },

    wall(ref) {
      return setSpan(ref, null);
    },
    open(ref) {
      return setSpan(ref, [0, 1]);
    },
    aperture(ref, width) {
      return setSpan(ref, centeredSpan(width));
    },

    between(ax, ay, bx, by) {
      const dx = bx - ax,
        dy = by - ay;
      if (Math.abs(dx) + Math.abs(dy) !== 1) return undefined;
      if (dx !== 0)
        return { vertical: true, line: dx > 0 ? bx : ax, offset: ay };
      return { vertical: false, line: dy > 0 ? by : ay, offset: ax };
    },

    outline(box) {
      return outlineSides(box).flatMap((side) => side.refs);
    },

    room(box, options = {}) {
      const [x0, y0, x1, y1] = box;
      const doorCount = options.doors ?? 1;
      const doorWidth = options.doorWidth ?? PASSAGE.door;
      const windowCount = options.windows ?? 0;
      const windowWidth = options.windowWidth ?? 0.6;
      const rng = options.rng ?? context.rng.stream("room");
      const refused: RoomResult = { placed: false, box, doors: [] };
      if (x1 < x0 || y1 < y0) {
        refuse();
        return refused;
      }
      for (let y = y0; y <= y1; y += 1)
        for (let x = x0; x <= x1; x += 1)
          if (!owns(x, y)) {
            refuse();
            return refused;
          }

      const allowed = options.sides;
      const sides = outlineSides(box).filter(
        (side) => !allowed || allowed.includes(side.side),
      );
      const available = sides.reduce(
        (total, side) => total + side.refs.length,
        0,
      );
      if (doorCount > available) {
        refuse();
        return refused;
      }

      // Nothing is declared until every door has a home: a half-built room is
      // worse than none, and the caller is told plainly that it was refused.
      const taken = new Set<string>();
      const runs: Array<{ refs: SegmentRef[]; width: number }> = [];
      const place = (width: number): boolean => {
        const length = Math.max(1, Math.ceil(width - SPAN_EPS));
        const choices: Array<{ refs: SegmentRef[]; weight: number }> = [];
        for (const { refs } of sides) {
          const last = refs.length - length;
          for (let start = 0; start <= last; start += 1) {
            const run = refs.slice(start, start + length);
            if (run.some((ref) => taken.has(describeSegment(ref)))) continue;
            // Weighted toward the middle of a side: a door in a corner reads as
            // a mistake, and a wide one does not fit there at all.
            choices.push({
              refs: run,
              weight: 1 + Math.min(start, last - start),
            });
          }
        }
        if (!choices.length) return false;
        const total = choices.reduce((sum, choice) => sum + choice.weight, 0);
        let roll = rng.next() * total;
        let chosen = choices[choices.length - 1]!;
        for (const choice of choices) {
          roll -= choice.weight;
          if (roll < 0) {
            chosen = choice;
            break;
          }
        }
        for (const ref of chosen.refs) taken.add(describeSegment(ref));
        runs.push({ refs: chosen.refs, width });
        return true;
      };

      for (let i = 0; i < doorCount; i += 1)
        if (!place(doorWidth)) {
          refuse();
          return refused;
        }
      const doorRuns = runs.length;
      for (let i = 0; i < windowCount; i += 1)
        // A window is stated geometry rather than passage, so failing to site
        // one costs the room nothing beyond a note.
        if (!place(windowWidth)) note("window-skipped");

      for (const ref of canvas.outline(box)) canvas.wall(ref);
      const doors: SegmentRef[] = [];
      runs.forEach((run, index) => {
        const spans = runSpans(run.refs.length, run.width);
        run.refs.forEach((ref, i) => {
          setSpan(ref, spans[i]!);
          if (index < doorRuns) doors.push(ref);
        });
      });

      if (options.interiorClass !== undefined)
        for (let y = y0 + 1; y <= y1 - 1; y += 1)
          for (let x = x0 + 1; x <= x1 - 1; x += 1)
            canvas.cell(x, y, { class: options.interiorClass });
      for (let y = y0; y <= y1; y += 1)
        for (let x = x0; x <= x1; x += 1) canvas.claim(x, y);
      return { placed: true, box, doors };
    },

    prop(wall) {
      // A prop never leaves the cell that produced it, so it can never leave
      // the region either -- the invariant validation already enforces.
      const cell = soleCellOf(wall);
      if (!cell) return refuse();
      if (!owns(cell[0], cell[1])) return refuse();
      obstacles.push({ ...wall });
      return true;
    },

    propInCell(x, y, length, angle) {
      const half = length / 2;
      const cx = x + 0.5,
        cy = y + 0.5;
      return canvas.prop({
        x1: cx - Math.cos(angle) * half,
        y1: cy - Math.sin(angle) * half,
        x2: cx + Math.cos(angle) * half,
        y2: cy + Math.sin(angle) * half,
      });
    },

    spawn(cellIndex, kind) {
      const x = cellIndex % mask.width,
        y = Math.floor(cellIndex / mask.width);
      if (!owns(x, y)) return refuse();
      // A slot is claimed once. Overwriting it would hide the budget, which is
      // the one number a zone allocation will eventually have to trust.
      if (spawns.has(cellIndex)) return refuse();
      if (spawns.size >= context.budget) return refuse();
      spawns.set(cellIndex, { cellIndex, kind });
      return true;
    },

    feature(kind, x, y) {
      if (!owns(x, y)) return refuse();
      features.set(`${kind}:${x},${y}`, { kind, x, y });
      return true;
    },

    note,

    finish(generator) {
      // Material states a wall on each boundary against a non-material
      // neighbour. That rule is in docs/VOCABULARY.md and it has to be applied
      // here, because nothing downstream applies it: `wallsFromLattice` reads
      // segments and treats every cell inside the mask alike, and
      // `clearance.ts` does not read cell class at all. A builder that paints a
      // pillar and stops has painted a label, not an obstacle -- which is
      // exactly what `pillar-hall` was doing, silently, for a whole checkpoint.
      //
      // It happens in `finish` rather than in `cell` so a builder may paint a
      // 2 x 2 block in any order without walling its own inside, and it goes
      // through `setSpan`, so the containment contract still applies and the
      // clearance guard still sees every wall it produced.
      const material = new Set<number>();
      for (const edit of cells.values())
        if (edit.class === SOLID_CLASS) material.add(edit.cellIndex);
      for (const index of [...material].sort((a, b) => a - b)) {
        const x = index % context.mask.width,
          y = (index - x) / context.mask.width;
        for (const side of SIDES) {
          const ref = canvas.edgeOf(x, y, side);
          const [a, b] = segmentCells(ref);
          const other = a.x === x && a.y === y ? b : a;
          const at = other.y * context.mask.width + other.x;
          if (material.has(at)) continue;
          canvas.wall(ref);
        }
      }
      const byIndex = <T>(entries: Map<number, T>): T[] =>
        [...entries.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, value]) => value);
      return {
        // Ascending grid index throughout, so the same declarations made in any
        // order produce byte-identical output and a seed sweep stays comparable.
        spawns: byIndex(spawns),
        obstacles: obstacles.map((obstacle) => ({ ...obstacle })),
        cells: byIndex(cells),
        segments: byIndex(segments),
        vertices: byIndex(vertices),
        features: [...features.values()],
        manifest: {
          generator,
          spawnsPlaced: spawns.size,
          obstaclesPlaced: obstacles.length,
          // The canvas cannot see a severed route; clearance.ts decides this.
          corridorsHonored: true,
          rejected,
          ...(Object.keys(notes).length ? { notes: { ...notes } } : {}),
        },
      };
    },
  };
  return canvas;
}
