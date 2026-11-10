/**
 * The open-face rule (51 stage 1, 17 M2 and M11): the proof's gate and the portal rule,
 * checked during the solve as slots are placed, so placement never returns a layout that
 * `proofViolations` or `portalViolations` would refuse. It judges placed slots
 * pessimistically and unplaced ones optimistically:
 * - **Sealed:** a component of placed cells with no open face can never be joined again,
 *   so it is refused unless it is the whole map. Cells join as the proof joins regions:
 *   the same resolved class, or a guaranteed segment between them. A face toward an
 *   unplaced slot is open while some option left for that slot could join there.
 * - **Short portal:** a portal whose every cell, and the cells just past each end, are
 *   settled can't grow, so one shorter than `MIN_PORTAL_LENGTH` is refused.
 * - **Sealed pocket (lookahead, #857):** the sealed check floods on through unplaced slots
 *   and unsettled cells, each unplaced slot as one node that joins whatever it could. An
 *   area of up to `LOOKAHEAD_CELLS` that can't reach the rest of the map is refused while
 *   it is still a hole, rather than once its last face closes, when the choices that walled
 *   it in may lie far back and the solver churns among the slots around it.
 *
 * An `any` cell is settled once a placed design beside it asks it for a class, since
 * placement keeps the asks aimed at one cell in agreement, or once every cell beside it
 * is placed. Until then it could join anything beside it.
 *
 * Each check reads only what the newly placed slots touch. A component that loses its
 * last open face, or a portal whose length becomes known, lies within two cells of one,
 * so floods start there and stop at the first open face.
 *
 * A refusal names the placed slots that settle what it refuses: each cell's class, the
 * classes beside it and the guarantees between them, and the placed neighbours of each
 * closed slot, whose propagation narrowed its options. The solver backjumps to the
 * latest of them (`solveWfc`). A sealed component is named by its cut, the faces between
 * it and the cells outside it, since every path out crosses them.
 */
import type { RefusalTraceEvent, TraceFace } from "./placement-trace.ts";
import { MIN_PORTAL_LENGTH } from "../../../kernel/scale.ts";
import type { TileOption, WfcAccept, WfcGrid } from "../wfc.ts";
import { orientedDesigns } from "./declared-grid.ts";
import type { OrientedDesign } from "./declared-grid.ts";
import { CHAIN_TILE_SIZE } from "./library.ts";
import type { ChainLibrary, SegmentPrescription } from "./library.ts";
import { DEFAULT_RESOLVED_CLASS, guaranteesPassability, resolveSettledClass } from "./resolution.ts";
import type { Orientation, SegmentKey } from "./types.ts";

const S = CHAIN_TILE_SIZE;
/** No slot of the map: off it, or outside its mask. */
const OUTSIDE = "";
/** A cell whose class isn't settled: its slot is unplaced, or it is an `any` cell nothing has asked yet. */
const UNSETTLED = "?";
const SIDES = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
/** Cells of one design that join inside it (`partsOf`), by local index, and its exits, `local * 4 + side`. */
interface Part { cells: number[]; exits: number[] }
interface Parts { of: Int16Array; parts: Part[] }
/**
 * The largest area, in cells, the lookahead floods before taking it as open (#857): 32 slots.
 * It bounds each check's cost, not which layouts are valid: a larger sealed area is still
 * refused, by the open-face rule, once its last face closes. The pockets that stalled 12 x 6
 * to 36 x 18 seeds (42.39) reached 17 slots of settled cells beside a hole; 8 slots left
 * three of them to the stall limit, and 16 slots one.
 */
export const LOOKAHEAD_CELLS = 32 * CHAIN_TILE_SIZE * CHAIN_TILE_SIZE;
/**
 * The most unplaced slots a lookahead area may hold before it is taken as open: a pocket is a
 * hole or two beside settled cells, and an area reaching many unplaced slots is the unsolved
 * map. On the stalled seeds of 42.39 eight kept every pocket and cut the flood by a fifth; four lost one.
 */
export const LOOKAHEAD_SLOTS = 8;

/**
 * The rule for one solve over `grid`, a map `columns` by `rows` slots. `refused` hears
 * why each refused branch was refused.
 */
export function openFaceRule(library: ChainLibrary, grid: WfcGrid, columns: number, rows: number,
  refused: (reason: string) => void = () => {}, lookahead = LOOKAHEAD_CELLS, trace?: (event: RefusalTraceEvent) => void): WfcAccept {
  const width = columns * S, height = rows * S;
  const slotAt = new Int32Array(columns * rows).fill(-1);
  grid.forEach((slot, i) => { slotAt[slot.y * columns + slot.x] = i; });
  const oriented = orientedDesigns(library);
  // Each option's design, turned once.
  const designs = new Map<TileOption, OrientedDesign>();
  /**
   * A design's fixed parts: its cells that join inside it whatever lies around it, the same
   * class or a guaranteed segment between them, both stated by the design alone. An `any`
   * cell's class depends on its neighbours, so it is in no part. The floods take a part as one
   * node and leave it only by its exits, the faces from its cells to cells outside it.
   */
  const partsCache = new Map<OrientedDesign, Parts>();
  /** A design's segment prescriptions by number: `h:x,y` at `y * S + x`, then `v:x,y` at `x * S + y`. */
  const segmentCache = new Map<OrientedDesign, Array<SegmentPrescription | undefined>>();
  const segmentsOf = (turnedDesign: OrientedDesign): Array<SegmentPrescription | undefined> => {
    let found = segmentCache.get(turnedDesign);
    if (found) return found;
    found = new Array(2 * (S + 1) * S);
    for (const [key, prescription] of turnedDesign.segments) {
      const [a, b] = key.slice(2).split(",").map(Number) as [number, number];
      found[key[0] === "h" ? b * S + a : (S + 1) * S + a * S + b] = prescription;
    }
    segmentCache.set(turnedDesign, found);
    return found;
  };
  const partsOf = (turnedDesign: OrientedDesign): Parts => {
    let found = partsCache.get(turnedDesign);
    if (found) return found;
    const { cells } = turnedDesign;
    const of = new Int16Array(S * S).fill(-1), parts: Part[] = [];
    const joinsInside = (local: number, k: number): number => {
      const x = local % S, y = (local - x) / S, [dx, dy] = SIDES[k]!, nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) return -1;
      const next = ny * S + nx;
      if (cells[next] === "any") return -1;
      if (cells[next] === cells[local]) return next;
      const segment = turnedDesign.segments.get((dx ? `v:${x + Math.max(dx, 0)},${y}` : `h:${x},${y + Math.max(dy, 0)}`) as SegmentKey);
      return guaranteesPassability(segment?.passability, segment?.passability) ? next : -1;
    };
    for (let first = 0; first < S * S; first++) {
      if (cells[first] === "any" || of[first]! >= 0) continue;
      const part: Part = { cells: [first], exits: [] };
      of[first] = parts.length;
      for (let i = 0; i < part.cells.length; i++) for (let k = 0; k < SIDES.length; k++) {
        const next = joinsInside(part.cells[i]!, k);
        if (next >= 0 && of[next]! < 0) { of[next] = parts.length; part.cells.push(next); }
      }
      parts.push(part);
    }
    for (const [id, part] of parts.entries()) for (const local of part.cells) for (let k = 0; k < SIDES.length; k++) {
      const next = joinsInside(local, k);
      if (next < 0 || of[next] !== id) part.exits.push(local * 4 + k);
    }
    partsCache.set(turnedDesign, found = { of, parts });
    return found;
  };
  // Flood marks, kept across checks: a mark at or above `firstFlood` belongs to this check.
  // Cells first, then one node per slot (the lookahead's unplaced slots).
  const mark = new Int32Array(width * height + grid.length);
  let flood = 0;
  // Each cell's class, found once a check: valid while its stamp is the check's.
  const classStamp = new Int32Array(width * height), classOf: string[] = new Array(width * height);
  let checks = 0;

  return (solving, placed) => {
    const turned = (option: TileOption): OrientedDesign => {
      let found = designs.get(option);
      if (!found) designs.set(option, found = oriented(option.templateId, option.orientation as Orientation));
      return found;
    };
    const design = (slot: number): OrientedDesign | undefined => {
      const domain = solving[slot]!.domain;
      return domain.length === 1 ? turned(domain[0]!) : undefined;
    };
    const slotOf = (x: number, y: number): number =>
      x < 0 || y < 0 || x >= width || y >= height ? -1 : slotAt[Math.floor(y / S) * columns + Math.floor(x / S)]!;
    /**
     * The prescription a design for the slot holding (x, y) states on a segment, by its
     * global key: the placed design, or `option`.
     */
    const stated = (x: number, y: number, axis: "h" | "v", gx: number, gy: number, option?: TileOption) => {
      const lx = gx - x + (x % S), ly = gy - y + (y % S);
      return segmentsOf(option ? turned(option) : design(slotOf(x, y))!)[axis === "h" ? ly * S + lx : (S + 1) * S + lx * S + ly];
    };
    /** The segment between (x, y) and the cell `dx, dy` from it, by its global key. */
    const between = (x: number, y: number, dx: number, dy: number): ["h" | "v", number, number] =>
      dx ? ["v", x + Math.max(dx, 0), y] : ["h", x, y + Math.max(dy, 0)];

    const faceGeometry = (x: number, y: number, dx: number, dy: number): TraceFace => {
      const [axis, gx, gy] = between(x, y, dx, dy);
      return { a: { x: gx, y: gy }, b: { x: gx + (axis === "h" ? 1 : 0), y: gy + (axis === "v" ? 1 : 0) } };
    };
    const point = (cell: number) => ({ x: cell % width, y: Math.floor(cell / width) });
    const check = ++checks;
    /** A cell's resolved class as resolution would give it, or `OUTSIDE`, or `UNSETTLED`. */
    const classAt = (x: number, y: number): string => {
      const slot = slotOf(x, y);
      if (slot < 0) return OUTSIDE;
      const cell = y * width + x;
      if (classStamp[cell] === check) return classOf[cell]!;
      const own = design(slot);
      let found = own ? own.cells[(y % S) * S + (x % S)]! : UNSETTLED;
      if (found === "any") {
        // Asked by the design holding each cell beside it, on the segment between them.
        // Placement keeps the asks aimed at one cell in agreement, so the first settles it.
        let asked: string | undefined, waiting = false;
        for (const [dx, dy] of SIDES) {
          const beside = slotOf(x + dx, y + dy);
          if (beside < 0) continue;
          if (!design(beside)) { waiting = true; continue; }
          const required = stated(x + dx, y + dy, ...between(x, y, dx, dy))?.adjacency;
          if (required !== undefined && required !== "any") { asked = required; break; }
        }
        found = resolveSettledClass(found, asked, waiting) ?? UNSETTLED;
      }
      classStamp[cell] = check;
      classOf[cell] = found;
      return found;
    };
    /**
     * The placed slots that settle `cells` and the cells beside them: each one's own slot,
     * and, for an `any` cell, the slots beside it, whose designs ask it for its class.
     * Guarantees between them are stated by the same slots.
     */
    const cause = (cells: Iterable<number>): number[] => {
      const slots = new Set<number>();
      const settles = (x: number, y: number) => {
        const slot = slotOf(x, y);
        if (slot < 0 || !design(slot)) return;
        slots.add(slot);
        if (design(slot)!.cells[(y % S) * S + (x % S)] !== "any") return;
        for (const [dx, dy] of SIDES) {
          const beside = slotOf(x + dx, y + dy);
          if (beside >= 0 && design(beside)) slots.add(beside);
        }
      };
      for (const cell of cells) {
        const x = cell % width, y = (cell - x) / width;
        settles(x, y);
        for (const [dx, dy] of SIDES) settles(x + dx, y + dy);
      }
      return [...slots];
    };
    /**
     * Whether an `any` cell (x, y) could resolve to `wanted` if `option` were placed in
     * its slot: some design beside it asks for `wanted`, or none asks and `wanted` is the
     * default. Unplaced neighbours can ask only for classes in their remaining options.
     */
    const anyCouldBe = (x: number, y: number, option: TileOption, wanted: string): boolean => {
      const slot = slotOf(x, y);
      let asked = false, couldAskWanted = false;
      for (const [dx, dy] of SIDES) {
        const beside = slotOf(x + dx, y + dy);
        if (beside < 0) continue;
        if (beside !== slot && !design(beside)) {
          const asks = solving[beside]!.domain.map((candidate) =>
            stated(x + dx, y + dy, ...between(x, y, dx, dy), candidate)?.adjacency);
          if (asks.includes(wanted)) couldAskWanted = true;
          if (asks.every((required) => required !== undefined && required !== "any")) asked = true;
          continue;
        }
        const required = stated(x + dx, y + dy, ...between(x, y, dx, dy), beside === slot ? option : undefined)?.adjacency;
        if (required === undefined || required === "any") continue;
        if (required === wanted) return true;
        asked = true;
      }
      return couldAskWanted || (!asked && wanted === DEFAULT_RESOLVED_CLASS);
    };
    /**
     * Whether the settled cell (x, y), of class `own`, could still join the cell beside it
     * in an unplaced slot: some option left for that slot puts `own` there, or an `any`
     * cell that could resolve to it, or the paired prescriptions guarantee passage. Domains
     * only narrow, so a face that can't join now never will.
     */
    // Both passes ask about the same faces, so each answer is kept for the check.
    const joinable = new Map<number, boolean>();
    const couldJoin = (x: number, y: number, dx: number, dy: number, own: string): boolean => {
      const face = (y * width + x) * 4 + (dx ? 1 + dx : 2 + dy);
      let found = joinable.get(face);
      if (found !== undefined) return found;
      const key = between(x, y, dx, dy);
      const nx = x + dx, ny = y + dy, local = (ny % S) * S + (nx % S);
      found = stated(x, y, ...key)?.passability === "passable" || solving[slotOf(nx, ny)]!.domain.some((option) => {
        const across = turned(option).cells[local];
        return across === own || (across === "any" && anyCouldBe(nx, ny, option, own))
          || guaranteesPassability(stated(x, y, ...key)?.passability, stated(nx, ny, ...key, option)?.passability);
      });
      joinable.set(face, found);
      return found;
    };
    /** Derived guarantee after both segment prescriptions are known. Both slots are placed. */
    const guaranteed = (x: number, y: number, dx: number, dy: number): boolean => {
      const key = between(x, y, dx, dy);
      // Called only between two settled cells of different classes.
      const passLower = stated(x, y, ...key)?.passability;
      const passUpper = stated(x + dx, y + dy, ...key)?.passability;
      if (!guaranteesPassability(passLower, passUpper)) return false;
      if (passLower !== "passable" && passUpper !== "passable") {
        // Emergent guarantee between different classes (#893).
        // If fully bounded to length < MIN_PORTAL_LENGTH, resolution demotes it to "none".
        const [ax, ay] = [dy, dx];
        const lower = classAt(x, y), upper = classAt(x + dx, y + dy);
        let canExtend = false;
        for (const step of [-1, 1] as const) {
          const px = x + ax * step, py = y + ay * step;
          const [l, u] = [classAt(px, py), classAt(px + dx, py + dy)];
          if (l === UNSETTLED || u === UNSETTLED) { canExtend = true; break; }
          if (l === lower && u === upper) {
            const nKey = between(px, py, dx, dy);
            if (guaranteesPassability(stated(px, py, ...nKey)?.passability, stated(px + dx, py + dy, ...nKey)?.passability)) {
              canExtend = true; break;
            }
          }
        }
        if (!canExtend) return false;
      }
      return true;
    };

    // Cells within `margin` of a placed slot, each once.
    const near = (margin: number): number[] => {
      const seen = new Set<number>();
      for (const slot of placed) {
        const { x: col, y: row } = solving[slot]!;
        for (let y = Math.max(row * S - margin, 0); y < Math.min((row + 1) * S + margin, height); y++)
          for (let x = Math.max(col * S - margin, 0); x < Math.min((col + 1) * S + margin, width); x++) seen.add(y * width + x);
      }
      return [...seen].sort((a, b) => a - b);
    };

    // ── Short portals ──
    const walked = new Set<string>();
    for (const cell of near(2)) {
      const x = cell % width, y = (cell - x) / width;
      const lower = classAt(x, y);
      if (lower === OUTSIDE || lower === UNSETTLED) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const upper = classAt(x + dx, y + dy);
        if (upper === OUTSIDE || upper === UNSETTLED || upper === lower || !guaranteed(x, y, dx, dy)) continue;
        // Walk the portal along its line, both ways, while each side keeps its class. Two
        // cells of one class in a row are one region, so this never runs past the portal
        // regions.ts derives, and can only stop short of it where the classes swap sides.
        const [ax, ay] = [dy, dx];
        const reach = (step: number): number | undefined => {
          for (let k = 1; ; k++) {
            const px = x + ax * step * k, py = y + ay * step * k;
            const [l, u] = [classAt(px, py), classAt(px + dx, py + dy)];
            if (l === UNSETTLED || u === UNSETTLED) return undefined;
            if (l !== lower || u !== upper || !guaranteed(px, py, dx, dy)) return k - 1;
          }
        };
        const back = reach(-1), ahead = back === undefined ? undefined : reach(1);
        if (back === undefined || ahead === undefined) continue;
        const sx = x - ax * back, sy = y - ay * back, length = back + ahead + 1;
        const key = `${dx ? "v" : "h"}:${sx + dx},${sy + dy}`;
        if (walked.has(key)) continue;
        walked.add(key);
        if (length < MIN_PORTAL_LENGTH) {
          let hasAuthored = false;
          for (let k = 0; k < length; k++) {
            const px = sx + ax * k, py = sy + ay * k;
            const [axis, gx, gy] = between(px, py, dx, dy);
            const p1 = stated(px, py, axis, gx, gy)?.passability;
            const p2 = stated(px + dx, py + dy, axis, gx, gy)?.passability;
            if (p1 === "passable" || p2 === "passable") { hasAuthored = true; break; }
          }
          // An emergent portal this short is demoted by resolution (#893), so only an authored one is refused.
          if (!hasAuthored) continue;
          const reason = `portal between ${lower} and ${upper} at ${key} is ${length} segment${length === 1 ? "" : "s"} long, shorter than a hunter's ${MIN_PORTAL_LENGTH}`;
          refused(reason);
          // The portal's cells, and those just past each end.
          const cells: number[] = [];
          for (let k = -1; k <= length; k++) {
            const px = sx + ax * k, py = sy + ay * k;
            for (const [cx, cy] of [[px, py], [px + dx, py + dy]] as const)
              if (cx >= 0 && cy >= 0 && cx < width && cy < height) cells.push(cy * width + cx);
          }
          const causeSlots = cause(cells);
          if (trace) trace({ type: "refusal", kind: "portal", reason, cells: cells.map(point),
            faces: Array.from({ length }, (_, k) => faceGeometry(sx + ax * k, sy + ay * k, dx, dy)), causeSlots: [...causeSlots] });
          return causeSlots;
        }
      }
    }

    // ── Sealed areas ──
    // Flood nodes: a placed design's part, numbered by its first cell, or an `any` cell of a
    // placed slot, or an unplaced slot, numbered after the cells. Nothing yet decides how an
    // unplaced slot's cells connect, so it joins all of its faces, and two unplaced slots, or
    // cells whose class isn't settled, always join.
    const cellCount = width * height;
    /** The part of a placed slot's design holding (x, y), with the slot's origin, or undefined for an `any` cell. */
    const partAt = (x: number, y: number, placedDesign: OrientedDesign) => {
      const ox = x - (x % S), oy = y - (y % S), { of, parts } = partsOf(placedDesign);
      const id = of[(y % S) * S + (x % S)]!;
      return id < 0 ? undefined : { part: parts[id]!, ox, oy };
    };
    const nodeOf = (x: number, y: number): number => {
      const slot = slotOf(x, y);
      if (slot < 0) return -1;
      const placedDesign = design(slot);
      if (!placedDesign) return cellCount + slot;
      const found = partAt(x, y, placedDesign);
      if (!found) return y * width + x;
      const first = found.part.cells[0]!;
      return (found.oy + Math.floor(first / S)) * width + found.ox + (first % S);
    };
    /** Every cell of a node. */
    const cellsOf = (node: number): number[] => {
      if (node >= cellCount) {
        const { x: col, y: row } = solving[node - cellCount]!;
        return Array.from({ length: S * S }, (_, local) => (row * S + Math.floor(local / S)) * width + col * S + (local % S));
      }
      const x = node % width, y = (node - x) / width, found = partAt(x, y, design(slotOf(x, y))!);
      return found ? found.part.cells.map((local) => (found.oy + Math.floor(local / S)) * width + found.ox + (local % S)) : [node];
    };
    /**
     * Each face of `node` toward a cell of another node: from (x, y) to `dx, dy`. A part
     * faces out by its exits, an unplaced slot from each of its perimeter cells.
     */
    const partSize = (node: number): number => {
      const x = node % width, y = (node - x) / width;
      return partAt(x, y, design(slotOf(x, y))!)?.part.cells.length ?? 1;
    };
    const facesOf = (node: number, visit: (x: number, y: number, dx: number, dy: number) => boolean): void => {
      if (node < cellCount) {
        const x = node % width, y = (node - x) / width, found = partAt(x, y, design(slotOf(x, y))!);
        if (!found) {
          for (const [dx, dy] of SIDES) if (visit(x, y, dx, dy)) return;
          return;
        }
        for (const exit of found.part.exits) {
          const local = exit >> 2, [dx, dy] = SIDES[exit & 3]!;
          if (visit(found.ox + (local % S), found.oy + Math.floor(local / S), dx, dy)) return;
        }
        return;
      }
      const { x: col, y: row } = solving[node - cellCount]!;
      for (const [dx, dy] of SIDES) {
        // The side's first cell, and the step along it.
        const x0 = dx > 0 ? col * S + S - 1 : col * S, y0 = dy > 0 ? row * S + S - 1 : row * S;
        const beside = slotOf(x0 + dx, y0 + dy);
        if (beside < 0) continue;
        // Two unplaced slots join along their whole seam, so one face stands for it.
        const cellsAlong = design(beside) ? S : 1;
        for (let i = 0; i < cellsAlong; i++) if (visit(x0 + i * dy * dy, y0 + i * dx * dx, dx, dy)) return;
      }
    };

    /**
     * Refuses an area that can't reach the rest of the map: the open-face rule and its
     * lookahead (#857), by `through`.
     * - Without `through`, areas of settled cells, each stopping at its first face that an
     *   unsettled cell could still join. One with none is sealed, whatever its size.
     * - With `through`, it floods on past those faces, through unplaced slots and unsettled
     *   cells, so a hole whose sides are all closed toward it is refused while it is still
     *   a hole, not once the last of it is placed. A flood larger than `budget` cells is
     *   taken as open: the lookahead is for pockets, and the first pass still proves the map.
     */
    const sealed = (through: boolean, budget: number): number[] | undefined => {
      const firstFlood = ++flood;
      // Breadth first, so an open flood marks the cells around the placed slots before it
      // runs far, and the floods after it in this check meet its marks soon.
      const queue: number[] = [];
      // A component's last open face was a placed slot's cell, or an `any` cell beside one
      // that has now settled, so it has a cell within two of a placed slot; a hole that has
      // just closed lies beside one.
      for (const startCell of near(2)) {
        const sx = startCell % width, sy = (startCell - sx) / width;
        const start = nodeOf(sx, sy);
        if (start < 0 || mark[start]! >= firstFlood) continue;
        if (!through && classAt(sx, sy) === UNSETTLED) continue;
        const id = flood++;
        mark[start] = id;
        queue.length = 0;
        queue.push(start);
        let head = 0;
        let open = false, size = 0, lowest = start, holes = 0;
        const component: number[] = [];
        // Each closed face as [settled cell, slot of the unsettled cell across or -1, node across].
        // Those whose node across lies outside the component are its cut.
        const faces: number[] = [];
        const geometry: TraceFace[] | undefined = trace ? [] : undefined;
        while (head < queue.length && !open) {
          const node = queue[head++]!;
          component.push(node);
          if (node < lowest) lowest = node;
          size += node < cellCount ? partSize(node) : S * S;
          if (node >= cellCount) holes++;
          if (size > budget || holes > LOOKAHEAD_SLOTS) { open = true; break; }
          facesOf(node, (x, y, dx, dy) => {
            const ax = x + dx, ay = y + dy;
            const across = classAt(ax, ay);
            if (across === OUTSIDE) return false;
            const next = nodeOf(ax, ay), own = classAt(x, y);
            // Even a placed `any` cell can join only through a possible class or a derived
            // guarantee. A hint doesn't turn an unsettled class into passage.
            const joins = own !== UNSETTLED
              ? across !== UNSETTLED ? across === own || guaranteed(x, y, dx, dy) : couldJoin(x, y, dx, dy, own)
              : across !== UNSETTLED ? couldJoin(ax, ay, -dx, -dy, across) : true;
            if (!joins) {
              geometry?.push(faceGeometry(x, y, dx, dy));
              if (own === UNSETTLED) faces.push(ay * width + ax, slotOf(x, y), next);
              else faces.push(y * width + x, across === UNSETTLED ? slotOf(ax, ay) : -1, next);
              return false;
            }
            if (!through && across === UNSETTLED) return open = true;
            if (mark[next] === id) return false;
            // An earlier flood of this check was open, so whatever it reached is open.
            if (mark[next]! >= firstFlood) return open = true;
            mark[next] = id;
            queue.push(next);
            return false;
          });
        }
        if (open || size === grid.length * S * S) continue;
        const cut = new Set<number>();
        // Unsettled cells' slots the area faces, but that have no option left to join it.
        const closed = new Set<number>();
        for (let f = 0; f < faces.length; f += 3) if (mark[faces[f + 2]!] !== id) {
          cut.add(faces[f]!);
          if (faces[f + 1]! >= 0) closed.add(faces[f + 1]!);
        }
        const at = lowest < cellCount ? lowest : (() => {
          const { x, y } = solving[lowest - cellCount]!;
          return y * S * width + x * S;
        })();
        const lx = at % width, ly = (at - lx) / width;
        // An area of holes alone starts in an unplaced slot, whose class isn't settled.
        const found = classAt(lx, ly), label = found === UNSETTLED ? "unsettled" : found;
        const reason = through
          ? `the area from ${label}@${lx},${ly} (${size} cells, ${holes} unplaced slot${holes === 1 ? "" : "s"}) can't reach the rest of the map`
          : `the component from ${label}@${lx},${ly} (${size} cells) has no portal path out`;
        refused(reason);
        // Every path out crosses the cut, so the slots that settle its faces seal the component
        // whatever lies inside it: they are the cause, not the component's every slot. A sealed
        // map-sized component named nearly every slot, and the solver then backtracked one slot
        // at a time to its iteration cap (#849). A closed slot's domain was narrowed by its
        // placed neighbours' propagation.
        const slots = new Set(cause(cut.size ? cut : component.filter((node) => node < cellCount).flatMap(cellsOf)));
        for (const slot of closed) for (const { cell } of solving[slot]!.links) if (design(cell)) slots.add(cell);
        const causeSlots = [...slots];
        if (trace) trace({ type: "refusal", kind: through ? "pocket" : "sealed", reason,
          cells: component.flatMap(cellsOf).map(point),
          faces: geometry!.filter((_, i) => mark[faces[i * 3 + 2]!] !== id), causeSlots: [...causeSlots] });
        return causeSlots;
      }
      return undefined;
    };
    return sealed(false, Infinity) ?? sealed(true, lookahead) ?? true;
  };
}
