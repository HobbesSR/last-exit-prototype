/**
 * 51 step 3: the chain's types and the harnesses every stage is held to. The stages
 * here are fakes; the real ones arrive from step 4 on and use the same harnesses.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHAIN_TILE_SIZE } from "../src/chain/library.ts";
import type { ChainLibrary } from "../src/chain/library.ts";
import type { ChainParams, DeclaredGrid, Layout, MacroStages, Orientation, ResolvedLayout, StageMark } from "../src/chain/types.ts";
import { assertDeterministic, assertPure, assertRecomputable } from "./chain-harness.ts";

const LIBRARY = JSON.parse(readFileSync(new URL("./fixtures/chain-library.json", import.meta.url), "utf8")) as ChainLibrary;
const PARAMS: ChainParams = { zoneWidth: 2, zoneHeight: 1, exitCount: 2, lootChance: 0.1, lootTierStep: 0.05 };
const ORIENTATIONS: Orientation[] = [0, 90, 180, 270];

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** Draws from the seed alone: each slot's design and orientation hash the seed and the slot. */
const fakePlacement: MacroStages["placement"] = (seed, params, library) => ({
  seed,
  params,
  library: `fixture-${library.version}`,
  slots: Array.from({ length: params.zoneWidth * params.zoneHeight }, (_, i) => {
    const col = i % params.zoneWidth, row = Math.floor(i / params.zoneWidth), draw = hash(`${seed}:${col},${row}`);
    return { col, row, design: library.tiles[draw % library.tiles.length]!.id, orientation: ORIENTATIONS[draw % 4]! };
  }),
  setPieces: [],
});

/** Every cell takes its design's default class, ignoring orientation. */
const fakeDeclaredGrid: MacroStages["declaredGrid"] = (layout, library) => {
  const width = layout.params.zoneWidth * CHAIN_TILE_SIZE, height = layout.params.zoneHeight * CHAIN_TILE_SIZE;
  const cells: (string | null)[] = Array(width * height).fill(null);
  for (const slot of layout.slots) {
    const design = library.tiles.find((tile) => tile.id === slot.design)!;
    for (let y = 0; y < CHAIN_TILE_SIZE; y++) for (let x = 0; x < CHAIN_TILE_SIZE; x++)
      cells[(slot.row * CHAIN_TILE_SIZE + y) * width + slot.col * CHAIN_TILE_SIZE + x] = design.defaultCellClass;
  }
  return { width, height, cells, segments: {} };
};

test("a fake placement is pure and deterministic", () => {
  const layout = assertPure("placement", fakePlacement, "seed-1", PARAMS, LIBRARY);
  assert.deepEqual(assertDeterministic("placement", fakePlacement, "seed-1", PARAMS, LIBRARY), layout);
  assert.notDeepEqual(fakePlacement("seed-2", PARAMS, LIBRARY), layout);
});

test("a fake declared grid is pure, deterministic and recomputable from its objects", () => {
  const layout = fakePlacement("seed-1", PARAMS, LIBRARY);
  const grid = assertPure("declared grid", fakeDeclaredGrid, layout, LIBRARY);
  assertDeterministic("declared grid", fakeDeclaredGrid, layout, LIBRARY);
  assertRecomputable("declared grid", grid, fakeDeclaredGrid, layout, LIBRARY);
  assert.equal(grid.cells.length, 12 * 6);
  assert.ok(grid.cells.every((cell) => cell !== null));
});

test("the purity harness catches a stage that changes its inputs", () => {
  const layout = fakePlacement("seed-1", PARAMS, LIBRARY);
  const sorting = (input: Layout): number => input.slots.sort((p, q) => q.col - p.col).length;
  assert.throws(() => assertPure("sorting", sorting, layout), /sorting changed its inputs/);
});

test("the determinism harness catches hidden randomness and identity caches", () => {
  assert.throws(() => assertDeterministic("random", (n: number) => n + Math.random(), 1), /random gave different outputs/);
  const seen = new WeakSet<object>();
  const cached = (input: { n: number }) => {
    const fresh = !seen.has(input);
    seen.add(input);
    return fresh ? input.n : 0;
  };
  const input = { n: 3 };
  cached(input);
  assert.equal(assertDeterministic("cached", cached, input), 3);
});

test("the view harness catches a view that leans on unsaved state", () => {
  let calls = 0;
  const counting = (layout: Layout) => ({ slots: layout.slots.length, calls: calls++ });
  const layout = fakePlacement("seed-1", PARAMS, LIBRARY);
  assert.throws(() => assertRecomputable("counting", counting(layout), counting, layout), /isn't recomputable/);
  const withMap = { ...layout, extra: new Map([["a", 1]]) };
  assert.throws(() => assertRecomputable("map", 1, (_: object) => 1, withMap), /don't survive saving/);
  const withUndefined = { ...layout, extra: undefined };
  assert.throws(() => assertRecomputable("undefined", 1, (_: object) => 1, withUndefined), /don't survive saving/);
});

test("stage outputs with matching shapes stay distinct types", () => {
  interface Declared extends StageMark<"declared"> { width: number }
  interface Resolved extends StageMark<"resolved"> { width: number }
  const declared: Declared = { width: 1 };
  // @ts-expect-error One stage's output is never another's, even with the same shape (51 principle 4).
  const resolved: Resolved = declared;
  assert.equal(resolved.width, 1);
  const grid: DeclaredGrid = { width: 1, height: 1, cells: ["open"], segments: {} };
  // @ts-expect-error A declared grid is not a resolved layout.
  const layout: ResolvedLayout = grid;
  assert.equal(layout.height, 1);
});
