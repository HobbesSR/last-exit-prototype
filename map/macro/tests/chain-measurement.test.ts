/**
 * 51 step 8: Measurement. Macro can't build regions (50), so a stub builder here sites
 * exactly what each brief asks, at cell centres, and the fixture's maps built that way
 * report no defect. Each test then breaks one link: an author's merged instances, a
 * stray site, a builder that sites other than its brief asked, and a proof that doesn't
 * cover what was built.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { RegionBrief, RegionResult } from "../../kernel/contract.ts";
import { briefs, chainZones } from "../src/chain/briefs.ts";
import type { ChainLibrary, ChainTileDesign } from "../src/chain/library.ts";
import { measurement } from "../src/chain/measurement.ts";
import { placement } from "../src/chain/placement.ts";
import { proof } from "../src/chain/proof.ts";
import { regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import type { ChainParams, Layout, LayoutRegions, PlacedSlot, Report, SetPieceInstance } from "../src/chain/types.ts";
import { assertDeterministic, assertPure, assertRecomputable } from "./chain-harness.ts";
import { stubBuild, stubCompose } from "./chain-stub.ts";

const LIBRARY = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, lootChance: 0.04, lootTierStep: 0.09 };
const SEEDS = ["placement-1", "placement-2", "placement-3", "placement-4"];
const CELL_SIZE = 4;
const layouts = new Map(SEEDS.map((seed) => [seed, placement(seed, GAME, LIBRARY)]));
const derive = (layout: Layout, library: ChainLibrary): LayoutRegions => regions(resolution(layout, library), layout.seed);

function measure(layout: Layout, library: ChainLibrary, build: (brief: RegionBrief) => RegionResult = stubBuild): Report {
  const found = derive(layout, library);
  const built = stubCompose(briefs(layout, found, chainZones(layout.params), library, CELL_SIZE).map(build));
  return measurement(built, proof(found), layout, library);
}
const kinds = (report: Report): string[] => report.defects.map((defect) => defect.kind);

test("measurement is pure, deterministic and recomputable from the Layout and the results", () => {
  const layout = layouts.get(SEEDS[0]!)!;
  const found = derive(layout, LIBRARY);
  const results = briefs(layout, found, chainZones(layout.params), LIBRARY, CELL_SIZE).map(stubBuild);
  const built = stubCompose(results), reachability = proof(found);
  const report = assertPure("measurement", measurement, built, reachability, layout, LIBRARY);
  assert.deepEqual(assertDeterministic("measurement", measurement, built, reachability, layout, LIBRARY), report);
  assertRecomputable("measurement", report, (saved: Layout, list: RegionResult[]) =>
    measurement(stubCompose(list), proof(derive(saved, LIBRARY)), saved, LIBRARY), layout, results);
});

test("the fixture's maps, built as their briefs ask, keep every promise", () => {
  for (const [seed, layout] of layouts) {
    const report = measure(layout, LIBRARY);
    assert.deepEqual(report.defects, [], seed);
    // One count per core element of each instance whose class owns any: start, end and charger.
    const owning = layout.setPieces.filter((instance) => ["start", "end", "charger"].includes(instance.setPieceClass));
    assert.deepEqual([...new Set(report.coreElements.map((count) => count.instance))], owning.map((instance) => instance.id), seed);
    const end = owning.find((instance) => instance.setPieceClass === "end")!;
    assert.deepEqual(report.coreElements.filter((count) => count.instance === end.id),
      [{ instance: end.id, element: "hunter-spawn", promised: 1, found: 1 }, { instance: end.id, element: "exit", promised: GAME.exitCount, found: GAME.exitCount }], seed);
    assert.ok(report.coreElements.every((count) => count.found === count.promised), seed);
    assert.equal(report.metrics.coreElementSites, 1 + 1 + GAME.exitCount + 1, seed);
    const found = derive(layout, LIBRARY);
    assert.equal(report.metrics.regions, found.regions.length, seed);
    assert.equal(report.metrics.cells, found.regions.reduce((n, region) => n + region.cells.length, 0), seed);
    assert.equal(report.metrics.portals, found.portals.length, seed);
  }
});

// ── Hand-placed layouts ─────────────────────────────────────────────────────

const column = (mark: string) => Array.from({ length: 6 }, () => `.....${mark}`);
const passable = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, { passability: "passable" as const }]));
const HAND: ChainLibrary = {
  ...LIBRARY,
  tiles: [
    { id: "field", defaultCellClass: "open", orientations: [0] },
    { id: "pod", defaultCellClass: "charging", orientations: [0] },
    // An arrival column on the tile's east side, with a passable stretch onto the open ground west of it.
    { id: "arrival-west", defaultCellClass: "open", cells: column("a"), legend: { a: "arrival" }, orientations: [0],
      segments: passable("v:5,2", "v:5,3") },
  ] satisfies ChainTileDesign[],
};
const PLAYGROUND: ChainParams = { ...GAME, mode: "playground", zoneWidth: 1, zoneHeight: 1 };
const instance = (id: string, setPieceClass: string, ...slots: [number, number][]): SetPieceInstance =>
  ({ id, setPiece: `${setPieceClass}-piece`, setPieceClass, slots: slots.map(([col, row]) => ({ col, row })) });

function hand(slots: Record<string, string>, setPieces: SetPieceInstance[]): Layout {
  const placed: PlacedSlot[] = Object.entries(slots).map(([at, design]) => {
    const [col, row] = at.split(",").map(Number) as [number, number];
    return { col, row, design, orientation: 0 };
  });
  return { seed: "hand", params: PLAYGROUND, library: "hand", slots: placed, setPieces };
}

test("two adjacent instances whose core element regions merged: the one left without is reported", () => {
  // Two charger pods side by side form one charging region, so its builder sites one charger, in the first pod.
  const layout = hand({ "1,1": "pod", "2,1": "pod" }, [instance("pod-a", "charger", [1, 1]), instance("pod-b", "charger", [2, 1])]);
  assert.equal(derive(layout, HAND).regions.length, 1);
  const report = measure(layout, HAND);
  assert.deepEqual(report.coreElements, [
    { instance: "pod-a", element: "charger", promised: 1, found: 1 },
    { instance: "pod-b", element: "charger", promised: 1, found: 0 },
  ]);
  // The builder kept its brief, so the defect is the authors', and names only the instance.
  assert.deepEqual(report.defects, [{ kind: "missing-core-element", instance: "pod-b",
    message: "instance pod-b of class charger has 0 charger where its class promises 1" }]);
});

test("a stray site is reported: in no instance, or in one whose class doesn't own it", () => {
  // The second pod isn't an instance, so a charger sited there lies in none.
  const layout = hand({ "1,1": "pod", "2,1": "pod" }, [instance("pod-a", "charger", [1, 1])]);
  const second = (brief: RegionBrief): RegionResult =>
    ({ ...stubBuild(brief), coreElements: [{ kind: "charger", x: 13.5 * CELL_SIZE, y: 6.5 * CELL_SIZE }] });
  const report = measure(layout, HAND, second);
  assert.deepEqual(kinds(report), ["stray-site", "missing-core-element"]);
  assert.match(report.defects[0]!.message, /a charger at 54,26, in region charging@6,6, lies in no set piece instance/);

  // A medium instance owns no core elements, so a charger in its slot is a stray too.
  const owned = hand({ "1,1": "pod", "2,1": "pod" }, [instance("pod-a", "charger", [1, 1]), instance("huts", "medium", [2, 1])]);
  const stray = measure(owned, HAND, second).defects[0]!;
  assert.equal(stray.kind, "stray-site");
  assert.equal(stray.instance, "huts");
  assert.match(stray.message, /lies in instance huts, whose class medium doesn't own it/);
});

test("a builder that sites other than its brief asks broke its promise, and the instance is short too", () => {
  const layout = hand({ "1,1": "pod" }, [instance("pod-a", "charger", [1, 1])]);
  const none = (brief: RegionBrief): RegionResult => ({ ...stubBuild(brief), coreElements: [] });
  const report = measure(layout, HAND, none);
  assert.deepEqual(report.defects.map(({ kind, regions: ids, instance: id }) => ({ kind, ids, id })), [
    { kind: "broken-promise", ids: ["charging@6,6"], id: undefined },
    { kind: "missing-core-element", ids: undefined, id: "pod-a" },
  ]);
  assert.match(report.defects[0]!.message, /region charging@6,6 sited 0 charger where its brief asked for 1/);

  // A site outside the builder's own cells breaks its promise, whichever instance it lands in.
  const outside = (brief: RegionBrief): RegionResult =>
    ({ ...stubBuild(brief), coreElements: [{ kind: "charger", x: 11.5 * CELL_SIZE, y: 13 * CELL_SIZE }] });
  const moved = measure(layout, HAND, outside);
  assert.deepEqual(kinds(moved), ["broken-promise", "stray-site", "missing-core-element"]);
  assert.match(moved.defects[0]!.message, /region charging@6,6 sited a charger at 46,52, outside its own cells/);
});

test("the proof is checked against what was built: unconnected, unbuilt and unproven regions are reported", () => {
  // An arrival column (the spawn region) joined to the open ground beside it; then a field
  // and a pod beyond, with no passable side between any of them.
  const layout = hand({ "1,1": "arrival-west", "2,1": "field", "3,1": "pod" },
    [instance("entry", "start", [1, 1]), instance("pod-a", "charger", [3, 1])]);
  const report = measure(layout, HAND);
  assert.deepEqual(report.defects.map(({ kind, regions: ids }) => ({ kind, ids })), [
    { kind: "unproven-region", ids: ["open@12,6"] },
    { kind: "unproven-region", ids: ["charging@18,6"] },
  ]);
  assert.match(report.defects[1]!.message, /region charging@18,6 has no portal path to spawn region arrival@11,6/);

  // A built map that lost a region, or holds one the proof doesn't know.
  const found = derive(layout, HAND), reachability = proof(found);
  const built = stubCompose(briefs(layout, found, chainZones(layout.params), HAND, CELL_SIZE).map(stubBuild));
  const lost = measurement({ ...built, regions: built.regions.filter((r) => r.brief.id !== "charging@18,6") }, reachability, layout, HAND);
  assert.deepEqual(lost.defects.filter((d) => d.kind === "unbuilt-region").map((d) => d.message),
    ["the proof names region charging@18,6, which the built map doesn't hold"]);
  const unknown = { ...built.regions[0]!, brief: { ...built.regions[0]!.brief, id: "elsewhere", cells: [{ x: 60, y: 60 }] } };
  const extra = measurement({ ...built, regions: [...built.regions, unknown] }, reachability, layout, HAND);
  assert.ok(extra.defects.some((d) => d.kind === "unproven-region" && d.message === "region elsewhere was built, but the proof doesn't name it"));
});

test("metrics are counted from the built map", () => {
  const layout = hand({ "1,1": "arrival-west" }, [instance("entry", "start", [1, 1])]);
  const found = derive(layout, HAND);
  const results = briefs(layout, found, chainZones(layout.params), HAND, CELL_SIZE).map((brief) =>
    ({ ...stubBuild(brief), elements: [1, 2, 3], loot: [{ x: 0, y: 0, tier: 1 }] }));
  const report = measurement(stubCompose(results), proof(found), layout, HAND);
  assert.deepEqual(report.defects, []);
  assert.deepEqual(report.metrics, { regions: 2, cells: 36, portals: 1, elements: 6, coreElementSites: 1, loot: 2 });
});
