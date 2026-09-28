/**
 * The planned path's layers (docs/DESIGN_DECISIONS.md "Map layers"). Its
 * layout is the plan laid down, and its interiors are what the builders stated
 * over it. Tiles, anchors and where the planned features stand are measured on
 * layout plus interiors, when generating and when reading an artifact, and
 * aren't stored.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeGrid, encodeGrid } from "../src/coding.ts";
import {
  artifactFromBson,
  artifactToBson,
  artifactToJson,
  decodeArtifact,
  encodeArtifact,
} from "../src/artifact.ts";
import { gridViews, validateMap } from "../src/core.ts";
import { composeMap, layPlan, planMap } from "../src/plan/compose.ts";
import type { GeneratedMap } from "../src/types.ts";

const SMALL = { zoneWidth: 4, zoneHeight: 2 };
const plan = planMap("planned-layers", SMALL);
const map = composeMap(plan);

function layersOf(m: GeneratedMap) {
  assert.ok(m.plannedLayout, "a planned map has a layout");
  assert.ok(m.interiors, "a planned map has interiors");
  return { layout: m.plannedLayout, interiors: m.interiors };
}

test("a planned map's layout is the plan laid down", () => {
  const { layout } = layersOf(map);
  const laid = layPlan(planMap("planned-layers", SMALL));
  assert.deepStrictEqual(layout.grid.cells.class, encodeGrid(laid.cellClass));
  assert.deepStrictEqual(layout.grid.segments.open, encodeGrid(laid.segmentOpen));
  const regionOf = decodeGrid(layout.regions);
  for (const region of plan.regions)
    for (const cell of region.cells) assert.equal(regionOf[cell], region.id);
  assert.deepStrictEqual(
    layout.features,
    plan.features.map((f) => ({ kind: f.kind, region: f.regionId })),
  );
  assert.equal(map.layout, undefined, "a planned map has no V2 layout");
  assert.equal(map.structure, undefined);
});

test("a planned map's material is visible only through its interiors", () => {
  const { layout, interiors } = layersOf(map);
  const laid = decodeGrid(layout.grid.cells.class);
  assert.ok(!laid.includes("solid"), "no layout cell is solid");
  const stated = decodeGrid(interiors.cells.class);
  const views = gridViews(map);
  stated.forEach((cellClass, i) =>
    assert.equal(views.cellClass(i), cellClass === "any" ? laid[i] : cellClass, `cell ${i}`),
  );
  assert.ok(stated.some((c) => c !== "any"), "the builders laid something on this seed");
});

test("a planned map stores its layers, not its tiles or anchors", () => {
  const wire = encodeArtifact(map) as unknown as Record<string, unknown>;
  for (const derived of ["tiles", "grid", "regions", "features", "layout"])
    assert.equal(wire[derived], undefined, `${derived} is stored`);
  assert.ok(wire.plannedLayout);
  assert.ok(wire.interiors);
  const keys = new Set<string>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      walk(inner);
    }
  };
  walk(wire);
  for (const derived of ["anchor", "anchors", "cells", "cellOffsets", "area"])
    assert.ok(!keys.has(derived), `${derived} is stored`);
});

test("a planned map's tiles, anchors and features are measured again on read", () => {
  const viaBson = artifactFromBson(artifactToBson(map));
  assert.deepStrictEqual(viaBson.tiles, map.tiles);
  assert.deepStrictEqual(viaBson.features, map.features);
  assert.deepStrictEqual(viaBson.regions, map.regions);
  assert.deepStrictEqual(viaBson.walls, map.walls);
  assert.deepStrictEqual(viaBson, map);
  // Route metrics may be Infinity, which survives BSON but not JSON.
  const viaJson = decodeArtifact(JSON.parse(artifactToJson(map)));
  assert.deepStrictEqual(viaJson, { ...map, metrics: JSON.parse(JSON.stringify(map.metrics)) });
});

test("a planned tile is named for the planned region at its corner", () => {
  const { layout } = layersOf(map);
  const regionOf = decodeGrid(layout.regions);
  assert.ok(map.tiles.length > 0);
  for (const tile of map.tiles)
    assert.equal(tile.templateId, `planned:${regionOf[tile.y * map.width + tile.x]}`);
});

test("a planned map validates against its interiors", () => {
  const { interiors } = layersOf(map);
  assert.deepEqual(validateMap(map).errors, []);
  assert.equal(interiors.regions.length, map.regions.length);
  interiors.regions.forEach((entry, i) => assert.equal(entry.region, map.regions[i]!.id));
});
