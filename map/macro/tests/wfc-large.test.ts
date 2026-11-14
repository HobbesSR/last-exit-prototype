/**
 * The WFC solver is iterative and narrows one grid in place, so a large map neither
 * overflows the call stack (one frame per collapsed cell) nor holds a grid clone per
 * level. This pins both: a bare 1 x N chain here, and a 36 x 18 zone playground placement in
 * tests/slow/wfc-large.test.ts (#1071).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { solveWfc, wfcIterationCap } from "../src/wfc.ts";
import type { TileOption, WfcGrid } from "../src/wfc.ts";

test("a 20,000-cell chain solves without exhausting the stack", () => {
  const cells = 20000;
  const option = (templateId: string): TileOption => ({ templateId, orientation: 0, difficulty: 0, weight: 1 });
  const options = [option("a"), option("b")];
  const grid: WfcGrid = Array.from({ length: cells }, (_, i) => ({
    x: i, y: 0, domain: options,
    links: [...(i > 0 ? [{ cell: i - 1, relation: "r" }] : []), ...(i < cells - 1 ? [{ cell: i + 1, relation: "r" }] : [])],
  }));
  let n = 0;
  const solved = solveWfc(grid, () => true, () => (n = (n * 7 + 3) % 11) / 11, { state: { iterations: 0, maxIterations: 1e9 } });
  assert.ok(solved);
  assert.equal(solved.length, cells);
  assert.ok(solved.every((cell) => cell.domain.length === 1));
});

test("the search cap scales with the grid, and 12 x 6 zones keep the 10,000 they had", () => {
  assert.equal(wfcIterationCap(936), 10_000);
  assert.equal(wfcIterationCap(3744), 37_440);
  assert.equal(wfcIterationCap(8424), 84_240);
});

test("options of one kind share an id and a table, however many fixed slots carry them", () => {
  // Every pre-assigned set piece slot is its own option object; a table per object grew
  // with the square of them (#171).
  const cells = 5000;
  const fixed = (): TileOption => ({ templateId: "ground", orientation: 0, difficulty: 0, weight: 1 });
  const grid: WfcGrid = Array.from({ length: cells }, (_, i) => ({
    x: i, y: 0, domain: [fixed()],
    links: [...(i > 0 ? [{ cell: i - 1, relation: "W" }] : []), ...(i < cells - 1 ? [{ cell: i + 1, relation: "E" }] : [])],
  }));
  const solved = solveWfc(grid, () => true, () => 0.5);
  assert.ok(solved);
  assert.equal(new Set(solved.map((cell) => cell.domain[0]!.id)).size, 1);
  assert.equal(new Set(solved.map((cell) => cell.domain[0]!.valid)).size, 1);
});
