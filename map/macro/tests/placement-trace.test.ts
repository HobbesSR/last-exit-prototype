import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { solveWfc } from "../src/wfc.ts";
import type { TileOption, WfcGrid, WfcOptions } from "../src/wfc.ts";
import { openFaceRule } from "../src/chain/open-face.ts";
import { adjacencyLinks, placer } from "../src/chain/placement.ts";
import type { ChainLibrary } from "../src/chain/library.ts";
import type { PlacementTraceEvent, RefusalTraceEvent, WfcTraceEvent } from "../src/chain/placement-trace.ts";

const library = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const option = (templateId: string): TileOption => ({ templateId, orientation: 0, difficulty: 0, weight: 1 });
const grid = (count: number): WfcGrid => Array.from({ length: count }, (_, x) => ({ x, y: 0, domain: [option("a"), option("b")], links: [] }));

function run(trace?: WfcOptions["trace"]) {
  const cells = grid(4), state = { iterations: 0, maxIterations: 100 }, stall = { most: 0 };
  let draws = 0;
  const solved = solveWfc(cells, () => true, () => { draws++; return 0.5; }, {
    trace, state, stall,
    accept: (solving) => solving.every((cell) => cell.domain.length === 1) && solving[0]!.domain[0]!.templateId === "a" ? [0] : true,
  });
  return { solved: solved?.map((cell) => cell.domain[0]!.templateId), draws, state, stall };
}

test("tracing preserves draws, iterations and backjumps; deltas replay the final assignment", () => {
  const events: WfcTraceEvent[] = [];
  const traced = run((event) => events.push(event));
  assert.deepEqual(traced, run());
  assert.deepEqual(events, JSON.parse(JSON.stringify(events)));
  const shown = new Map<number, string>();
  for (const event of events) {
    if (event.type === "collapse") for (const slot of event.slots) shown.set(slot.slot, slot.design);
    if (event.type === "undo") for (const slot of event.slots) shown.delete(slot);
  }
  assert.deepEqual([...shown].sort(([a], [b]) => a - b).map(([, design]) => design), traced.solved);
  assert.ok(events.some((event) => event.type === "conflict" && event.depth === 4 && event.backjump === 1));
  assert.ok(events.some((event) => event.type === "backtrack" && event.fromDepth === 3 && event.toDepth === 2));
  assert.deepEqual(events, (() => { const again: WfcTraceEvent[] = []; run((event) => again.push(event)); return again; })());
});

test("fixed assignments survive a root propagation contradiction in the diagnostic", () => {
  const cells = grid(2);
  cells.forEach((cell, i) => { cell.domain = [option(String(i))]; cell.links = [{ cell: 1 - i, relation: "r" }]; });
  const events: WfcTraceEvent[] = [];
  assert.equal(solveWfc(cells, () => false, () => { throw new Error("unexpected draw"); }, { trace: (event) => events.push(event) }), null);
  assert.equal(events[0]!.type, "collapse");
  assert.ok(events.some((event) => event.type === "node" && event.depth === 0));
  assert.equal(events.filter((event) => event.type === "collapse").flatMap((event) => event.slots).length, 2);
  assert.ok(events.some((event) => event.type === "contradiction" && event.depth === 0 && event.slots.length > 0));
});

test("stall and iteration give-up events retain the existing limits", () => {
  for (const settings of [{ stallLimit: 0 }, { state: { iterations: 0, maxIterations: -1 } }]) {
    const execute = (trace?: WfcOptions["trace"]) => {
      const state = { iterations: 0, maxIterations: 100, ...settings.state }, stall = { most: 0 };
      let draws = 0;
      const result = solveWfc(grid(1), () => true, () => { draws++; return 0.5; }, {
        ...settings, state, stall, trace, accept: () => [0],
      });
      return { result, state, stall, draws };
    };
    const events: WfcTraceEvent[] = [];
    assert.deepEqual(execute((event) => events.push(event)), execute());
    assert.ok(events.some((event) => event.type === "give-up" && event.reason === ("stallLimit" in settings ? "stall" : "iterations")));
  }
});

test("refusal geometry uses world cells and explicit unit face endpoints", () => {
  const custom: ChainLibrary = { ...library, tiles: [{ id: "island", defaultCellClass: "open", orientations: [0],
    cells: ["......", "......", "..h...", "......", "......", "......"], legend: { h: "hut" } }], tileSets: [], setPieces: [], setPieceClasses: [] };
  // An offset slot makes local-cell coordinates visibly wrong.
  const cells: WfcGrid = [{ x: 2, y: 1, domain: [option("island")], links: [] }];
  const events: RefusalTraceEvent[] = [];
  const check = openFaceRule(custom, cells, 4, 3, () => {}, undefined, (event) => events.push(event));
  const cause = check(cells, [0]);
  assert.notEqual(cause, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "sealed");
  assert.deepEqual(events[0]!.causeSlots, cause);
  assert.ok(events[0]!.cells.every(({ x, y }) => x >= 12 && x < 18 && y >= 6 && y < 12));
  assert.ok(events[0]!.faces.length > 0);
  for (const { a, b } of events[0]!.faces) assert.equal(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1);
  assert.deepEqual(events, JSON.parse(JSON.stringify(events)));
});

const params = { mode: "playground" as const, zoneWidth: 1, zoneHeight: 1, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0, lootTierStep: 0 };
test("placer traces attempts and keeps its returned layout identical", () => {
  const custom: ChainLibrary = { ...library, tiles: [{ id: "field", defaultCellClass: "open", orientations: [0, 90] }], tileSets: [], setPieces: [], setPieceClasses: [] };
  const events: PlacementTraceEvent[] = [];
  const traced = placer({ openFace: true, trace: (event) => events.push(event) })("trace", params, custom);
  assert.deepEqual(traced, placer({ openFace: true })("trace", params, custom));
  assert.equal(events[0]!.type, "attempt-start");
  assert.equal(events.at(-1)!.type, "attempt-end");
  assert.ok(events.every((event) => event.attempt === 0));
});

test("set-piece failure preserves partial assignments before any WFC choices", () => {
  const custom: ChainLibrary = { ...library, zoneWidth: 2, zoneHeight: 1, fitPlacedSetPieces: true,
    tiles: [{ id: "bad", defaultCellClass: "open", orientations: [0], segments: { "v:6,0": { adjacency: "hut" } } }],
    tileSets: [{ id: "bad-set", members: ["bad"] }],
    setPieces: [{ id: "bad-piece", tiles: [{ dx: 0, dy: 0, tileSetId: "bad-set", orientation: 0 }, { dx: 1, dy: 0, tileSetId: "bad-set", orientation: 0 }] }],
    setPieceClasses: [{ id: "bad-class", placementRule: "small", quota: 1, setPieces: ["bad-piece"] }],
  };
  const events: PlacementTraceEvent[] = [];
  assert.throws(() => placer({ openFace: true, trace: (event) => events.push(event) })("partial", { ...params, mode: "game", zoneWidth: 2 }, custom), /set piece bad-piece/);
  assert.equal(events.filter((event) => event.type === "set-piece-slot").length, 50);
  assert.equal(events.filter((event) => event.type === "set-piece-failed").length, 50);
  assert.equal(events.filter((event) => event.type === "node").length, 0);
  assert.equal(events.at(-1)!.attempt, 49);
  assert.deepEqual(events, JSON.parse(JSON.stringify(events)));
});

test("short portals and lookahead pockets retain their exact refusal geometry", () => {
  const custom: ChainLibrary = { ...library, tiles: [
    { id: "field", defaultCellClass: "open", orientations: [0, 180] },
    { id: "hut", defaultCellClass: "hut", orientations: [0, 180] },
    { id: "portal", defaultCellClass: "open", orientations: [0],
      cells: ["......", "......", "..h...", "......", "......", "......"], legend: { h: "hut" },
      segments: { "v:2,2": { passability: "passable" } } },
  ], tileSets: [], setPieces: [], setPieceClasses: [] };
  const portal: WfcGrid = [{ x: 2, y: 1, domain: [option("portal")], links: [] }];
  const events: RefusalTraceEvent[] = [];
  const traced = openFaceRule(custom, portal, 4, 3, () => {}, undefined, (event) => events.push(event))(portal, [0]);
  assert.deepEqual(traced, openFaceRule(custom, portal, 4, 3)(portal, [0]));
  assert.equal(events[0]!.kind, "portal");
  assert.deepEqual(events[0]!.faces, [{ a: { x: 14, y: 8 }, b: { x: 14, y: 9 } }]);
  const turns = (design: string) => [option(design), { ...option(design), orientation: 180 as const }];
  const pocket: WfcGrid = [[option("hut")], turns("hut"), [option("field")], [...turns("field"), option("hut")]]
    .map((domain, x) => ({ x, y: 0, domain, links: [] }));
  adjacencyLinks(pocket);
  events.length = 0;
  const cause = openFaceRule(custom, pocket, 4, 1, () => {}, undefined, (event) => events.push(event))(pocket, [0, 2]);
  assert.deepEqual(cause === true ? cause : [...cause].sort(), [0, 2]);
  assert.deepEqual(cause, openFaceRule(custom, pocket, 4, 1)(pocket, [0, 2]));
  assert.equal(events[0]!.kind, "pocket");
  assert.equal(events[0]!.cells.length, 72);
  assert.equal(events[0]!.faces.length, 6);
  assert.ok(events[0]!.faces.every(({ a, b }) => a.x === 12 && b.x === 12));
});

test("contradictory propagation undoes chosen and propagated slots before the next choice", () => {
  const execute = (trace?: WfcOptions["trace"]) => {
    const cells = grid(4), state = { iterations: 0, maxIterations: 100 };
    cells[0]!.links = [{ cell: 1, relation: "same" }, { cell: 2, relation: "different" }, { cell: 3, relation: "same" }];
    cells[1]!.links = [{ cell: 0, relation: "same" }, { cell: 2, relation: "same" }];
    cells[2]!.links = [{ cell: 0, relation: "different" }, { cell: 1, relation: "same" }];
    cells[3]!.links = [{ cell: 0, relation: "same" }];
    let draws = 0;
    const result = solveWfc(cells, (a, relation, b) => (a.templateId === b.templateId) === (relation === "same"),
      () => { draws++; return 0.5; }, { state, trace });
    return { result, state, draws };
  };
  const events: WfcTraceEvent[] = [];
  assert.deepEqual(execute((event) => events.push(event)), execute());
  const shown = new Map<number, string>();
  for (const event of events) {
    if (event.type === "collapse") for (const slot of event.slots) shown.set(slot.slot, slot.design);
    if (event.type === "undo") for (const slot of event.slots) shown.delete(slot);
  }
  assert.equal(shown.size, 0);
  assert.equal(events.filter((event) => event.type === "contradiction").length, 2);
  assert.ok(events.some((event) => event.type === "undo" && event.slots.includes(0) && event.slots.some((slot) => slot !== 0)));
});
