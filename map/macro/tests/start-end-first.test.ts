import assert from "node:assert/strict";
import test from "node:test";
import { libraryFingerprint } from "../src/coding.ts";
import { declaredGrid, layoutViolations } from "../src/chain/declared-grid.ts";
import { resolveLibrary, validateLibrary } from "../src/chain/library.ts";
import type { ChainLibrary } from "../src/chain/library.ts";
import { placer } from "../src/chain/placement.ts";
import type { PlacementTraceEvent } from "../src/chain/placement-trace.ts";

const tiles = (count: number) => Array.from({ length: count }, (_, dx) => ({ dx, dy: 0, tileSetId: "field" }));
const library: ChainLibrary = {
  version: 3, name: "priority", zonePlan: "diamond", zoneWidth: 4, zoneHeight: 2,
  cellClasses: { open: { regionType: "open" } },
  tiles: [{ id: "field", defaultCellClass: "open", orientations: [0, 90] }],
  tileSets: [{ id: "field", members: ["field"] }],
  setPieces: [
    { id: "edge", tiles: tiles(1) }, { id: "large-a", tiles: tiles(3) },
    { id: "large-b", tiles: tiles(3) }, { id: "pair", tiles: tiles(2) },
  ],
  // IDs deliberately differ from rules: priority belongs to the rule.
  setPieceClasses: [
    { id: "arrival", placementRule: "start", quota: 1, setPieces: ["edge"] },
    { id: "departure", placementRule: "end", quota: 1, setPieces: ["edge"] },
    { id: "big", placementRule: "enormous", quota: 1, setPieces: ["large-a", "large-b"] },
    { id: "middle", placementRule: "medium", quota: 2, setPieces: ["pair"] },
    { id: "little", placementRule: "small", quota: 1, setPieces: ["edge"] },
  ],
};
const params = { zoneWidth: 4, zoneHeight: 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0, lootTierStep: 0 };
const types = new Set(["open"]);
function run(seed: string, authored: ChainLibrary) {
  const trace: PlacementTraceEvent[] = [];
  const layout = placer({ openFace: true, trace: (event) => trace.push(event) })(seed, params, authored);
  return { layout, trace };
}

test("start/end priority validates and resolves only when authored", () => {
  const absent = resolveLibrary(library, {});
  assert.equal(Object.hasOwn(absent, "startEndFirst"), false);
  assert.equal(libraryFingerprint(absent), libraryFingerprint(library));
  for (const value of [true, false]) {
    const authored = { ...library, startEndFirst: value };
    assert.deepEqual(validateLibrary(authored, types), { valid: true, errors: [] });
    assert.equal(resolveLibrary(authored, {}).startEndFirst, value);
  }
  for (const value of [0, 1, "true", null, {}]) {
    const authored = { ...library, startEndFirst: value };
    assert.ok(validateLibrary(authored, types).errors.includes("library: startEndFirst must be a boolean"));
    assert.throws(() => resolveLibrary(authored, {}), /startEndFirst must be a boolean/);
  }
});

test("absent and false preserve choices, ordering and complete diagnostic trace", () => {
  for (const seed of ["edge-order-1", "edge-order-2"]) {
    const original = run(seed, library), disabled = run(seed, { ...library, startEndFirst: false });
    // An explicitly authored property changes the fingerprint, never the layout choices.
    assert.deepEqual({ ...disabled.layout, library: original.layout.library }, original.layout);
    assert.deepEqual(disabled.trace, original.trace);
    assert.deepEqual(original.layout.setPieces.map((piece) => piece.setPieceClass),
      ["big", "middle", "middle", "arrival", "departure", "little"]);
  }
});

test("start then end precede larger pieces, preserving picks, quotas, stable ties and placement filters", () => {
  for (const seed of ["edge-order-1", "edge-order-2"]) {
    const original = run(seed, library), enabled = run(seed, { ...library, startEndFirst: true });
    const instances = enabled.layout.setPieces;
    assert.deepEqual(instances.map((piece) => piece.setPieceClass),
      ["arrival", "departure", "big", "middle", "middle", "little"]);
    const firstInstances = [...new Set(enabled.trace.filter((event) => event.type === "set-piece-slot")
      .map((event) => event.instance))];
    assert.deepEqual(firstInstances, instances.map((piece) => piece.id));
    const choices = (result: typeof original) => result.layout.setPieces
      .map(({ setPieceClass, setPiece }) => `${setPieceClass}:${setPiece}`).sort();
    assert.deepEqual(choices(enabled), choices(original));
    assert.equal(instances[0]!.slots[0]!.col, 0);
    assert.equal(instances[1]!.slots[0]!.col, 19);
    const occupied = instances.flatMap((piece) => piece.slots.map(({ col, row }) => `${col},${row}`));
    assert.equal(new Set(occupied).size, occupied.length);
    assert.deepEqual(layoutViolations(declaredGrid(enabled.layout, library)), []);
  }
});
