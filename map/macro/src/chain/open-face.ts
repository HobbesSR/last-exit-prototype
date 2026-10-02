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
 * latest of them (`solveWfc`).
 */
import { MIN_PORTAL_LENGTH } from "../../../kernel/scale.ts";
import type { TileOption, WfcAccept, WfcGrid } from "../wfc.ts";
import { orientedDesigns } from "./declared-grid.ts";
import type { OrientedDesign } from "./declared-grid.ts";
import { CHAIN_TILE_SIZE } from "./library.ts";
import type { ChainLibrary } from "./library.ts";
import { DEFAULT_RESOLVED_CLASS } from "./resolution.ts";
import type { Orientation, SegmentKey } from "./types.ts";

const S = CHAIN_TILE_SIZE;
/** No slot of the map: off it, or outside its mask. */
const OUTSIDE = "";
/** A cell whose class isn't settled: its slot is unplaced, or it is an `any` cell nothing has asked yet. */
const UNSETTLED = "?";
const SIDES = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

/**
 * The rule for one solve over `grid`, a map `columns` by `rows` slots. `refused` hears
 * why each refused branch was refused.
 */
export function openFaceRule(library: ChainLibrary, grid: WfcGrid, columns: number, rows: number,
  refused: (reason: string) => void = () => {}): WfcAccept {
  const width = columns * S, height = rows * S;
  const slotAt = new Int32Array(columns * rows).fill(-1);
  grid.forEach((slot, i) => { slotAt[slot.y * columns + slot.x] = i; });
  const oriented = orientedDesigns(library);
  // Each option's design, turned once.
  const designs = new Map<TileOption, OrientedDesign>();
  // Flood marks, kept across checks: a mark at or above `firstFlood` belongs to this check.
  const mark = new Int32Array(width * height);
  let flood = 0;

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
      const ox = Math.floor(x / S) * S, oy = Math.floor(y / S) * S;
      return (option ? turned(option) : design(slotOf(x, y))!).segments.get(`${axis}:${gx - ox},${gy - oy}` as SegmentKey);
    };
    /** The segment between (x, y) and the cell `dx, dy` from it, by its global key. */
    const between = (x: number, y: number, dx: number, dy: number): ["h" | "v", number, number] =>
      dx ? ["v", x + Math.max(dx, 0), y] : ["h", x, y + Math.max(dy, 0)];

    const classes = new Map<number, string>();
    /** A cell's resolved class as resolution would give it, or `OUTSIDE`, or `UNSETTLED`. */
    const classAt = (x: number, y: number): string => {
      const slot = slotOf(x, y);
      if (slot < 0) return OUTSIDE;
      const cell = y * width + x;
      const known = classes.get(cell);
      if (known !== undefined) return known;
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
        found = asked ?? (waiting ? UNSETTLED : DEFAULT_RESOLVED_CLASS);
      }
      classes.set(cell, found);
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
     * default. A design beside it that isn't placed yet might ask for anything.
     */
    const anyCouldBe = (x: number, y: number, option: TileOption, wanted: string): boolean => {
      const slot = slotOf(x, y);
      let asked = false;
      for (const [dx, dy] of SIDES) {
        const beside = slotOf(x + dx, y + dy);
        if (beside < 0) continue;
        if (beside !== slot && !design(beside)) return true;
        const required = stated(x + dx, y + dy, ...between(x, y, dx, dy), beside === slot ? option : undefined)?.adjacency;
        if (required === undefined || required === "any") continue;
        if (required === wanted) return true;
        asked = true;
      }
      return !asked && wanted === DEFAULT_RESOLVED_CLASS;
    };
    /**
     * Whether the settled cell (x, y), of class `own`, could still join the cell beside it
     * in an unplaced slot: some option left for that slot puts `own` there, or an `any`
     * cell that could resolve to it, or either side states the segment passable. Domains
     * only narrow, so a face that can't join now never will.
     */
    const couldJoin = (x: number, y: number, dx: number, dy: number, own: string): boolean => {
      const key = between(x, y, dx, dy);
      if (stated(x, y, ...key)?.passability === "passable") return true;
      const nx = x + dx, ny = y + dy, local = (ny % S) * S + (nx % S);
      return solving[slotOf(nx, ny)]!.domain.some((option) => {
        const across = turned(option).cells[local];
        return across === own || (across === "any" && anyCouldBe(nx, ny, option, own))
          || stated(nx, ny, ...key, option)?.passability === "passable";
      });
    };
    /** Either side prescribes the segment passable. Both cells must be in placed slots. */
    const guaranteed = (x: number, y: number, dx: number, dy: number): boolean => {
      const key = between(x, y, dx, dy);
      return stated(x, y, ...key)?.passability === "passable" || stated(x + dx, y + dy, ...key)?.passability === "passable";
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
          refused(`portal between ${lower} and ${upper} at ${key} is ${length} segment${length === 1 ? "" : "s"} long, shorter than a hunter's ${MIN_PORTAL_LENGTH}`);
          // The portal's cells, and those just past each end.
          const cells: number[] = [];
          for (let k = -1; k <= length; k++) {
            const px = sx + ax * k, py = sy + ay * k;
            for (const [cx, cy] of [[px, py], [px + dx, py + dy]] as const)
              if (cx >= 0 && cy >= 0 && cx < width && cy < height) cells.push(cy * width + cx);
          }
          return cause(cells);
        }
      }
    }

    // ── Sealed components ──
    let unplaced = 0;
    for (const slot of solving) if (slot.domain.length !== 1) unplaced++;
    const firstFlood = ++flood;
    const stack: number[] = [];
    // A component's last open face was a placed slot's cell, or an `any` cell beside one
    // that has now settled, so it has a cell within two of a placed slot.
    for (const start of near(2)) {
      if (mark[start]! >= firstFlood) continue;
      const sx = start % width, sy = (start - sx) / width;
      const startClass = classAt(sx, sy);
      if (startClass === OUTSIDE || startClass === UNSETTLED) continue;
      const id = flood++;
      mark[start] = id;
      stack.length = 0;
      stack.push(start);
      let open = false, lowest = start;
      const component: number[] = [];
      // Unplaced slots the component faces, but that have no option left to join it.
      const closed = new Set<number>();
      while (stack.length && !open) {
        const cell = stack.pop()!;
        component.push(cell);
        if (cell < lowest) lowest = cell;
        const x = cell % width, y = (cell - x) / width, own = classAt(x, y);
        for (const [dx, dy] of SIDES) {
          const across = classAt(x + dx, y + dy);
          if (across === OUTSIDE) continue;
          if (across === UNSETTLED) {
            const beside = slotOf(x + dx, y + dy);
            // An unsettled `any` cell in a placed slot could still take any class.
            if (design(beside) || couldJoin(x, y, dx, dy, own)) { open = true; break; }
            closed.add(beside);
            continue;
          }
          if (across !== own && !guaranteed(x, y, dx, dy)) continue;
          const next = (y + dy) * width + x + dx;
          if (mark[next] === id) continue;
          // An earlier flood of this check stopped at an open face, so its cells are open.
          if (mark[next]! >= firstFlood) { open = true; break; }
          mark[next] = id;
          stack.push(next);
        }
      }
      if (open || (unplaced === 0 && component.length === grid.length * S * S)) continue;
      const lx = lowest % width, ly = (lowest - lx) / width;
      refused(`the component from ${classAt(lx, ly)}@${lx},${ly} (${component.length} cells) has no portal path out`);
      // A closed slot's domain was narrowed by its placed neighbours' propagation.
      const slots = new Set(cause(component));
      for (const slot of closed) for (const { cell } of solving[slot]!.links) if (design(cell)) slots.add(cell);
      return [...slots];
    }
    return true;
  };
}
