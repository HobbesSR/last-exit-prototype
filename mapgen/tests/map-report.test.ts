/**
 * The report layer of docs/DESIGN_DECISIONS.md "Map layers" (#51). Metrics and
 * validation are functions of layout, structure and interiors, so the artifact
 * doesn't store them: `reportMap` computes them when a map is generated and
 * again when it's read. The metrics that count what the generator run did
 * (`RUN_METRICS`) can't be measured on a map, so only a fresh map has them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  artifactFromBson,
  artifactToBson,
  artifactToJson,
  decodeArtifact,
  encodeArtifact,
} from "../src/artifact.ts";
import { DEFAULT_LIBRARY, RUN_METRICS, generateMap } from "../src/core.ts";
import { generatePlannedMap } from "../src/plan/compose.ts";
import type { GeneratedMap, Library } from "../src/types.ts";
import { asRead } from "./read-back.ts";
import { SEALED_PARAMS, sealedLibrary } from "./sealed-library.ts";

const SMALL = { mode: "playground" as const, zoneWidth: 4, zoneHeight: 2 };

/** The class bindings sweep.mts uses, so builders declare blocks, cells and segments. */
const builders = structuredClone(DEFAULT_LIBRARY);
for (const [cellClass, generator] of Object.entries({
  market: "compound",
  depot: "pillar-hall",
  landing: "rubble",
  evac: "compound",
  park: "courtyard",
}))
  builders.cellClasses![cellClass] = { generator };

interface Case {
  name: string;
  map: GeneratedMap;
  library: Library;
}
const cases: Case[] = [
  ...["alpha", "five", "wire"].map((seed) => ({
    name: `v2 ${seed}`,
    map: generateMap(seed, seed === "five" ? { exitCount: 5 } : {}),
    library: DEFAULT_LIBRARY,
  })),
  { name: "v2 with builders", map: generateMap("micro-pipeline", {}, builders), library: builders },
  // "wire" has no tile-graph route, so its route metrics are Infinity.
  ...["wire", "planned-report"].map((seed) => ({
    name: `planned ${seed}`,
    map: generatePlannedMap(seed, SMALL),
    library: DEFAULT_LIBRARY,
  })),
];

const readBoth = ({ map, library }: Case) => ({
  BSON: artifactFromBson(artifactToBson(map), library),
  JSON: decodeArtifact(JSON.parse(artifactToJson(map)), library),
});

test("the wire document stores no report", () => {
  for (const { name, map } of cases) {
    const wire = encodeArtifact(map) as unknown as Record<string, unknown>;
    assert.equal(wire.metrics, undefined, `${name} stores metrics`);
    assert.equal(wire.validation, undefined, `${name} stores validation`);
    // The artifact is the layers: the layout, whose seed, params and size sit
    // at the top, and the interiors, with the string table they share.
    assert.deepEqual(
      Object.keys(wire).sort(),
      [
        "format",
        "height",
        map.layout ? "layout" : "plannedLayout",
        "interiors",
        "params",
        "seed",
        "strings",
        "width",
        "wire",
      ].sort(),
      name,
    );
  }
});

test("a decoded map reports the metrics and validation it was generated with", () => {
  for (const c of cases)
    for (const [encoding, back] of Object.entries(readBoth(c))) {
      assert.deepStrictEqual(back.metrics, asRead(c.map).metrics, `${c.name} metrics through ${encoding}`);
      assert.deepStrictEqual(back.validation, c.map.validation, `${c.name} validation through ${encoding}`);
    }
});

test("the metrics that count the generator run are on a fresh map only", () => {
  const v2 = cases.find((c) => c.name === "v2 with builders")!;
  const planned = cases.find((c) => c.name === "planned planned-report")!;
  for (const name of ["microBlocks", "microCells", "microSegments"])
    assert.equal(typeof v2.map.metrics[name], "number", `v2 has ${name}`);
  for (const name of ["microCells", "microSegments", "conformedRegions", "portsCorrected", "portCount"])
    assert.equal(typeof planned.map.metrics[name], "number", `planned has ${name}`);
  for (const c of [v2, planned]) {
    const present = RUN_METRICS.filter((name) => name in c.map.metrics);
    assert.ok(present.length, `${c.name} has run metrics`);
    for (const [encoding, back] of Object.entries(readBoth(c)))
      for (const name of RUN_METRICS)
        assert.ok(!(name in back.metrics), `${c.name} kept ${name} through ${encoding}`);
  }
});

test("an invalid map is still invalid on read", () => {
  const library = sealedLibrary();
  const map = generateMap("sealed", SEALED_PARAMS, library);
  assert.equal(map.validation.valid, false, "the sealed design is placed and fails validation");
  assert.ok(map.validation.errors.length);
  for (const [encoding, back] of Object.entries(readBoth({ name: "sealed", map, library }))) {
    assert.equal(back.validation.valid, false, `valid through ${encoding}`);
    assert.deepStrictEqual(back.validation.errors, map.validation.errors, `errors through ${encoding}`);
  }
});
