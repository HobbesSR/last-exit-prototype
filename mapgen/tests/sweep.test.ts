/**
 * The seed-sweep baseline that pins generated content across the map-layer
 * refactor (#47, tracking #52).
 *
 * The refactor moves fields between containers without changing what the
 * generator makes, so the hashes must follow content, not shape: they ignore
 * key order and how a grid happens to be run-length coded, and a change to one
 * layer's content moves that layer's hash and no other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGrid, encodeGrid } from "../src/coding.ts";
import type { CodedGrid } from "../src/coding.ts";
import type { GeneratedMap } from "../src/types.ts";
import {
  LAYERS,
  LAYER_FIELDS,
  positiveInteger,
  sweepCases,
  QUICK_CASES,
  compareSweep,
  layerContent,
  layerHashes,
  runCase,
  sweepMap,
} from "../tools/sweep.mts";
import type { SweepBaseline } from "../tools/sweep.mts";

const small = QUICK_CASES.find((c) => c.generator === "v2")!;
const map = sweepMap(small, `${small.seedPrefix}-1`) as GeneratedMap;
const base = layerHashes(map);

/** Changed layers between two hash sets, in LAYERS order. */
function changed(
  a: Record<string, string>,
  b: Record<string, string>,
): string[] {
  return LAYERS.filter((layer) => a[layer] !== b[layer]);
}
function withGrid<T>(
  grid: CodedGrid<T>,
  index: number,
  value: T,
): CodedGrid<T> {
  const values = decodeGrid(grid);
  values[index] = value;
  return encodeGrid(values);
}

test("the sweep is deterministic within one process", () => {
  for (const sweepCase of QUICK_CASES)
    assert.deepEqual(runCase(sweepCase), runCase(sweepCase), sweepCase.id);
});

test("a change to one layer's content moves that layer's hash and no other", () => {
  const edits: Array<[string, (m: GeneratedMap) => void]> = [
    [
      "layout",
      (m) => {
        const cells = m.grid.cells;
        cells.originalClass = withGrid(cells.originalClass!, 0, "sweep-test");
      },
    ],
    ["structure", (m) => (m.tiles[0]!.anchor.x += 0.5)],
    ["interiors", (m) => m.grid.cells.spawns.pop()],
    [
      "composed",
      (m) =>
        (m.grid.cells.class = withGrid(m.grid.cells.class, 0, "sweep-test")),
    ],
    ["composed", (m) => (m.edges[0]!.width += 1)],
    ["report", (m) => (m.metrics.lootCount += 1)],
  ];
  for (const [layer, edit] of edits) {
    const copy = structuredClone(map);
    edit(copy);
    assert.deepEqual(changed(base, layerHashes(copy)), [layer], layer);
  }
});

test("layout and structure don't depend on which micro builders run", () => {
  // Same seed and size, the shipped bindings against the geometry builders.
  // If this fails, a field in one of these buckets is really micro output.
  const bound = QUICK_CASES.find((c) => c.builders)!;
  const other = layerHashes(
    sweepMap(bound, `${bound.seedPrefix}-1`) as GeneratedMap,
  );
  assert.equal(other.layout, base.layout);
  assert.equal(other.structure, base.structure);
  assert.notEqual(other.interiors, base.interiors);
});

test("hashes ignore key order and how a grid is run-length coded", () => {
  const copy = structuredClone(map);
  // Same values, different coding: a reversed palette and a split run.
  const coded = copy.grid.segments.open;
  const palette = [...coded.palette].reverse();
  const runs: number[] = [];
  for (let i = 0; i < coded.runs.length; i += 2) {
    const length = coded.runs[i]!,
      code = palette.length - 1 - coded.runs[i + 1]!;
    if (length > 1) runs.push(1, code, length - 1, code);
    else runs.push(length, code);
  }
  copy.grid.segments.open = { palette, runs, count: coded.count };
  assert.deepEqual(decodeGrid(copy.grid.segments.open), decodeGrid(coded));
  // Same records, keys in the opposite order.
  const reversed = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reversed)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([k, v]) => [k, reversed(v)]),
          )
        : value;
  copy.tiles = reversed(copy.tiles) as GeneratedMap["tiles"];
  copy.metrics = reversed(copy.metrics) as GeneratedMap["metrics"];
  assert.deepEqual(layerHashes(copy), base);
});

test("a route metric that is unavailable hashes apart from zero", () => {
  const unavailable = structuredClone(map);
  unavailable.metrics.contestantDistance = Infinity;
  const zero = structuredClone(map);
  zero.metrics.contestantDistance = 0;
  assert.notEqual(layerHashes(unavailable).report, layerHashes(zero).report);
});

test("the comparison names each drifted seed and layer", () => {
  const baseline: SweepBaseline = {
    provenance: { commit: "test", capturedAt: "test", node: "test", cases: [] },
    entries: { "a/1": base, "a/2": base, "a/3": { error: "boom" } },
  };
  const moved = { ...base, interiors: "0" };
  const drift = compareSweep(baseline, {
    "a/1": base,
    "a/2": moved,
    "a/4": base,
  });
  assert.deepEqual(drift, [
    { key: "a/2", layers: ["interiors"] },
    { key: "a/3", layers: ["missing"] },
    { key: "a/4", layers: ["unexpected"] },
  ]);
});

test("the committed baseline still matches its quick cases", () => {
  const baseline = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/layer-baseline.json", import.meta.url),
      "utf8",
    ),
  ) as SweepBaseline;
  const current = Object.assign({}, ...QUICK_CASES.map((c) => runCase(c)));
  const pinned = Object.fromEntries(
    Object.keys(current).map((key) => [key, baseline.entries[key]]),
  );
  assert.deepEqual(
    compareSweep(
      { ...baseline, entries: pinned as SweepBaseline["entries"] },
      current,
    ),
    [],
  );
});

test("a field moved to a new container fails loudly until its entry follows it", () => {
  // What a later stage does: #49 moves the constraint grid into structure.
  const moved = structuredClone(map) as GeneratedMap & {
    structure?: { constraints: unknown };
  };
  moved.structure = { constraints: moved.grid.cells.constraints };
  delete moved.grid.cells.constraints;
  // Left alone, the table can't hash the new location: it's refused, not
  // silently read as absent.
  assert.throws(
    () => layerHashes(moved),
    /not assigned to a layer: structure\.constraints/,
  );
  // Updating the entry's path in the same change restores every hash.
  const followed = LAYER_FIELDS.map((field) =>
    field.name === "constraints"
      ? { ...field, path: "structure.constraints" }
      : field,
  );
  assert.deepEqual(layerHashes(moved, followed), base);
});

test("a new field is refused until it is assigned to a layer", () => {
  const extra = structuredClone(map) as GeneratedMap & { extra?: number };
  extra.extra = 1;
  assert.throws(() => layerHashes(extra), /not assigned to a layer: extra/);
  const tile = structuredClone(map);
  (tile.tiles[0] as unknown as Record<string, unknown>).note = "x";
  assert.throws(
    () => layerHashes(tile),
    /not assigned to a layer: tiles\[\]\.note/,
  );
});

test("a required field that disappears is refused, not hashed as absent", () => {
  const copy = structuredClone(map) as Partial<GeneratedMap>;
  delete copy.walls;
  assert.throws(
    () => layerContent(copy as GeneratedMap),
    /map field missing: walls/,
  );
});

test("counts and jobs must be positive integers", () => {
  for (const bad of ["0", "-3", "1.5", "nope", "", "Infinity", 0, NaN])
    assert.throws(
      () => positiveInteger("count", bad),
      /positive integer/,
      String(bad),
    );
  assert.equal(positiveInteger("count", "12"), 12);
  assert.throws(() => sweepCases("0"), /count must be a positive integer/);
});

test("the CLI refuses a bad count or jobs before writing anything", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
  const cli = new URL("../tools/cli.mts", import.meta.url);
  try {
    for (const args of [
      ["--count", "0"],
      ["--count", "nope"],
      ["--count", "3", "--jobs", "0"],
    ]) {
      const out = path.join(dir, "baseline.json");
      const run = spawnSync(
        process.execPath,
        [fileURLToPath(cli), "sweep", "--out", out, ...args],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 1, args.join(" "));
      assert.match(run.stderr, /must be a positive integer/);
      assert.equal(fs.existsSync(out), false, args.join(" "));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
