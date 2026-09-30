/**
 * A seed sweep that pins generated content, layer by layer (#47, tracking #52).
 *
 * The map-layer refactor (docs/archive/pre-integration/DESIGN_DECISIONS.md, "Map layers") moves fields
 * between containers and must not change what the generator makes. So each map
 * is reduced to canonical content per layer and hashed. Canonical means key
 * order and run-length coding don't matter, and a non-finite number is not
 * confused with zero.
 *
 * Today's `GeneratedMap` fuses layers, so the grouping is by what can be told
 * apart now:
 * - layout: params, placements, the classes tiles declare, macro features
 * - structure: seam constraints, zones, anchors
 * - interiors: spawns, levels, micro features, props, manifests
 * - composed: the final primitives (class, segments, vertices), the seams,
 *   the full wall list and the final region partition. Seams are here because
 *   `deriveEdges` reads the final segment grid, which micro builders write to. These fuse layout, structure and
 *   interiors today, and every later stage must still reproduce them.
 * - report: metrics and validation
 *
 * `LAYER_FIELDS` is the only code that knows where each field lives, and
 * hashing refuses any field it doesn't account for. A stage that moves a field
 * updates its entry in the same change, and the hashes must not move. A change in any hash is a stop-and-escalate, never a re-baseline.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { decodeGrid } from "../src/coding.ts";
import type { CodedGrid } from "../src/coding.ts";
import { DEFAULT_LIBRARY, generateMap } from "../src/core.ts";
import { generatePlannedMap } from "../src/plan/compose.ts";
import type { GeneratedMap, Library } from "../src/types.ts";
import { makeParams } from "./shared.mts";

export const LAYERS = [
  "layout",
  "structure",
  "interiors",
  "composed",
  "report",
] as const;
export type Layer = (typeof LAYERS)[number];
export type LayerHashes = Record<Layer, string>;
/** A seed the generator rejected is pinned by its message. */
export type SweepEntry = LayerHashes | { error: string };
export type SweepEntries = Record<string, SweepEntry>;

export interface SweepCase {
  id: string;
  generator: "v2" | "planned";
  params: Record<string, unknown>;
  /** Class-to-builder bindings over the shipped library, as micro-pipeline.test.ts uses. */
  builders?: Record<string, string>;
  seedPrefix: string;
  count: number;
}
export interface SweepBaseline {
  provenance: {
    commit: string;
    capturedAt: string;
    node: string;
    cases: SweepCase[];
  };
  entries: SweepEntries;
}
export interface Drift {
  key: string;
  layers: string[];
}

/** The class bindings the shipped library had before interiors became a black box. */
export const BUILDERS: Record<string, string> = {
  market: "compound",
  depot: "pillar-hall",
  landing: "rubble",
  evac: "compound",
  park: "courtyard",
};
const small = { mode: "playground", zoneWidth: 2, zoneHeight: 1 };

/** Cheap enough for `npm test`: pinned there against the committed baseline. */
export const QUICK_CASES: SweepCase[] = [
  {
    id: "v2-2x1",
    generator: "v2",
    params: small,
    seedPrefix: "quick",
    count: 3,
  },
  {
    id: "planned-2x1",
    generator: "planned",
    params: small,
    seedPrefix: "quick",
    count: 3,
  },
  {
    id: "v2-builders-2x1",
    generator: "v2",
    params: small,
    builders: BUILDERS,
    seedPrefix: "quick",
    count: 3,
  },
];

/**
 * A command-line count as a positive integer. Anything else is refused, so a
 * typo can't capture a sparse baseline and report success.
 */
export function positiveInteger(name: string, raw: unknown): number {
  const value =
    typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Error(
      `${name} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  return value;
}

/** The full sweep: `count` seeds per generator at default size, plus smaller spreads. */
export function sweepCases(requested: unknown = 120): SweepCase[] {
  const count = positiveInteger("count", requested);
  const spread = Math.max(1, Math.round(count / 6));
  const playground = (w: number, h: number) => ({
    mode: "playground",
    zoneWidth: w,
    zoneHeight: h,
  });
  return [
    {
      id: "v2-default",
      generator: "v2",
      params: {},
      seedPrefix: "sweep",
      count,
    },
    {
      id: "planned-default",
      generator: "planned",
      params: {},
      seedPrefix: "sweep",
      count,
    },
    {
      id: "v2-builders-default",
      generator: "v2",
      params: {},
      builders: BUILDERS,
      seedPrefix: "sweep",
      count: spread,
    },
    {
      id: "v2-4x2",
      generator: "v2",
      params: playground(4, 2),
      seedPrefix: "sweep",
      count: spread,
    },
    {
      id: "v2-6x3",
      generator: "v2",
      params: playground(6, 3),
      seedPrefix: "sweep",
      count: spread,
    },
    {
      id: "planned-4x2",
      generator: "planned",
      params: playground(4, 2),
      seedPrefix: "sweep",
      count: spread,
    },
    ...QUICK_CASES,
  ];
}

/** The shipped library with each class bound to a builder; tests share it. */
export function builderLibrary(bindings: Record<string, string> = BUILDERS): Library {
  const library = structuredClone(DEFAULT_LIBRARY);
  for (const [cellClass, generator] of Object.entries(bindings))
    library.cellClasses![cellClass] = { generator };
  return library;
}

function libraryFor(sweepCase: SweepCase): Library {
  return sweepCase.builders ? builderLibrary(sweepCase.builders) : DEFAULT_LIBRARY;
}

/** One map, or the generator's error message. Retry warnings are silenced. */
export function sweepMap(
  sweepCase: SweepCase,
  seed: string,
): GeneratedMap | { error: string } {
  const warn = console.warn;
  console.warn = () => {};
  try {
    if (sweepCase.generator === "planned")
      return generatePlannedMap(
        seed,
        sweepCase.params as Parameters<typeof generatePlannedMap>[1],
      );
    return generateMap(
      seed,
      makeParams(sweepCase.params),
      libraryFor(sweepCase),
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    console.warn = warn;
  }
}

/** A grid's values as merged `[length, value]` runs, whatever its palette order. */
function canonicalGrid(grid: CodedGrid | undefined): unknown {
  if (!grid) return null;
  const runs: Array<[number, unknown]> = [];
  let last = "";
  for (const value of decodeGrid(grid)) {
    const key = stableStringify(value);
    if (runs.length && key === last) runs.at(-1)![0] += 1;
    else runs.push([1, value]);
    last = key;
  }
  return { count: grid.count, runs };
}

const isMicroFeature = (feature: unknown) =>
  String((feature as { id?: unknown }).id).startsWith("micro-");

/**
 * Where each field of a map lives, and which layer it belongs to. This table is
 * the only code that knows the map's shape. A stage that moves a field changes
 * its `path` here in the same commit, and the hashes must not move.
 *
 * `path` is dotted; `[]` steps into every element of an array. `keys` takes
 * only those keys from each element, so one array can be split across layers.
 * `filter` takes only some elements. `grid` marks a run-length coded grid.
 * `optional` fields may be absent (a V2 map has no planned layout and a planned
 * map no V2 layout or structure, and a flat map has no levels). Every other
 * field must be present.
 *
 * `unpinned` fields are claimed but not hashed, and say why. A field that only
 * repeats pinned content in another shape, such as the layout's placements
 * beside the `tiles` view, is pinned through that view. A field that holds
 * content no stage had before can't be in a baseline captured before it, and is
 * pinned when the baseline is next deliberately recaptured; tests pin it until
 * then.
 */
export interface LayerField {
  layer: Layer;
  name: string;
  path: string;
  keys?: string[];
  filter?: (element: unknown) => boolean;
  grid?: boolean;
  optional?: boolean;
  unpinned?: string;
}
const SAME_AS_VIEW = "repeats content pinned through the tiles and features views";
const NEW_IN_49 = "new content in #49, pinned by tests/map-layers.test.ts until the next recapture";
const SAME_AS_FINAL = "repeats content pinned through the final grid, regions and features views";
const NEW_IN_50 = "new content in #50, pinned by tests/map-interiors.test.ts and planned-layers.test.ts until the next recapture";
export const LAYER_FIELDS: LayerField[] = [
  { layer: "layout", name: "seed", path: "seed" },
  { layer: "layout", name: "version", path: "version" },
  { layer: "layout", name: "params", path: "params" },
  { layer: "layout", name: "width", path: "width" },
  { layer: "layout", name: "height", path: "height" },
  {
    layer: "layout",
    name: "placements",
    path: "tiles[]",
    keys: [
      "id",
      "col",
      "row",
      "x",
      "y",
      "zoneId",
      "templateId",
      "orientation",
      "setPieceId",
    ],
  },
  {
    layer: "layout",
    name: "declaredClass",
    path: "layout.grid.cells.class",
    grid: true,
    optional: true,
  },
  { layer: "layout", name: "layoutSeed", path: "layout.seed", optional: true, unpinned: SAME_AS_VIEW },
  { layer: "layout", name: "layoutParams", path: "layout.params", optional: true, unpinned: SAME_AS_VIEW },
  { layer: "layout", name: "layoutPlacements", path: "layout.placements", optional: true, unpinned: SAME_AS_VIEW },
  { layer: "layout", name: "layoutFeatures", path: "layout.features", optional: true, unpinned: SAME_AS_VIEW },
  { layer: "layout", name: "layoutWidth", path: "layout.grid.width", optional: true, unpinned: SAME_AS_VIEW },
  { layer: "layout", name: "layoutHeight", path: "layout.grid.height", optional: true, unpinned: SAME_AS_VIEW },
  // A fingerprint of the library differs whenever builder bindings do, and
  // layout content must not.
  {
    layer: "layout",
    name: "library",
    path: "layout.library",
    optional: true,
    unpinned: "names the library, not the map; differs with builder bindings",
  },
  {
    layer: "layout",
    name: "layoutSegments",
    path: "layout.grid.segments.open",
    grid: true,
    optional: true,
    unpinned: NEW_IN_49,
  },
  // A planned map's layout. The plan laid down is new content; which region
  // each feature stands in is pinned through where the features stand.
  { layer: "layout", name: "plannedSeed", path: "plannedLayout.seed", optional: true, unpinned: SAME_AS_VIEW },
  { layer: "layout", name: "plannedParams", path: "plannedLayout.params", optional: true, unpinned: SAME_AS_VIEW },
  { layer: "layout", name: "plannedWidth", path: "plannedLayout.grid.width", optional: true, unpinned: SAME_AS_VIEW },
  { layer: "layout", name: "plannedHeight", path: "plannedLayout.grid.height", optional: true, unpinned: SAME_AS_VIEW },
  {
    layer: "layout",
    name: "plannedClass",
    path: "plannedLayout.grid.cells.class",
    grid: true,
    optional: true,
    unpinned: NEW_IN_50,
  },
  {
    layer: "layout",
    name: "plannedSegments",
    path: "plannedLayout.grid.segments.open",
    grid: true,
    optional: true,
    unpinned: NEW_IN_50,
  },
  {
    layer: "layout",
    name: "plannedRegions",
    path: "plannedLayout.regions",
    grid: true,
    optional: true,
    unpinned: NEW_IN_50,
  },
  { layer: "layout", name: "plannedFeatures", path: "plannedLayout.features", optional: true, unpinned: NEW_IN_50 },
  {
    layer: "layout",
    name: "features",
    path: "features[]",
    filter: (f) => !isMicroFeature(f),
  },
  {
    layer: "structure",
    name: "constraints",
    path: "structure.segments.constraints",
    grid: true,
    optional: true,
  },
  {
    layer: "structure",
    name: "filledClass",
    path: "structure.cells.class",
    grid: true,
    optional: true,
    unpinned: NEW_IN_49,
  },
  { layer: "structure", name: "structureAnchors", path: "structure.anchors", optional: true, unpinned: SAME_AS_VIEW },
  { layer: "structure", name: "zones", path: "zones" },
  { layer: "structure", name: "anchors", path: "tiles[]", keys: ["anchor"] },
  { layer: "interiors", name: "spawns", path: "grid.cells.spawns" },
  // The stored interiors layer. Its content is pinned through the final views
  // it's joined into, except the deltas it states over layout and structure.
  {
    layer: "interiors",
    name: "statedClass",
    path: "interiors.cells.class",
    grid: true,
    optional: true,
    unpinned: NEW_IN_50,
  },
  {
    layer: "interiors",
    name: "statedSegments",
    path: "interiors.segments.open",
    grid: true,
    optional: true,
    unpinned: NEW_IN_50,
  },
  { layer: "interiors", name: "interiorLevel", path: "interiors.cells.level", optional: true, unpinned: SAME_AS_FINAL },
  { layer: "interiors", name: "interiorSpawns", path: "interiors.cells.spawns", optional: true, unpinned: SAME_AS_FINAL },
  { layer: "interiors", name: "interiorVertices", path: "interiors.vertices", optional: true, unpinned: SAME_AS_FINAL },
  { layer: "interiors", name: "interiorFeatures", path: "interiors.features", optional: true, unpinned: SAME_AS_FINAL },
  {
    layer: "interiors",
    name: "interiorRegions",
    path: "interiors.regions[]",
    keys: ["region", "manifest", "props"],
    optional: true,
    unpinned: SAME_AS_FINAL,
  },
  {
    layer: "interiors",
    name: "level",
    path: "grid.cells.level",
    grid: true,
    optional: true,
  },
  {
    layer: "interiors",
    name: "features",
    path: "features[]",
    filter: isMicroFeature,
  },
  {
    layer: "interiors",
    name: "regions",
    path: "regions[]",
    keys: ["obstacles", "manifest"],
  },
  { layer: "composed", name: "gridWidth", path: "grid.width" },
  { layer: "composed", name: "gridHeight", path: "grid.height" },
  { layer: "composed", name: "class", path: "grid.cells.class", grid: true },
  {
    layer: "composed",
    name: "segments",
    path: "grid.segments.open",
    grid: true,
  },
  { layer: "composed", name: "vertices", path: "grid.vertices" },
  { layer: "composed", name: "edges", path: "edges" },
  { layer: "composed", name: "walls", path: "walls" },
  {
    layer: "composed",
    name: "regions",
    path: "regions[]",
    keys: ["id", "cellClass", "area", "cells", "seed"],
  },
  { layer: "report", name: "metrics", path: "metrics" },
  { layer: "report", name: "validation", path: "validation" },
];

/** The value at a dotted path, or undefined. `[]` maps over an array. */
function read(value: unknown, steps: string[]): unknown {
  if (!steps.length || value === undefined || value === null) return value;
  const [step, ...rest] = steps;
  if (step!.endsWith("[]")) {
    const list = (value as Record<string, unknown>)[step!.slice(0, -2)];
    return Array.isArray(list)
      ? list.map((item) => read(item, rest))
      : undefined;
  }
  return read((value as Record<string, unknown>)[step!], rest);
}

/** Paths a field accounts for: its own, or one per picked key. */
function claims(field: LayerField): string[] {
  return field.keys
    ? field.keys.map((key) => `${field.path}.${key}`)
    : [field.path];
}

/**
 * Every leaf of the map that no field accounts for. A field moved to a new
 * container shows up here until its entry follows it, so nothing can leave
 * hash coverage silently.
 */
function unassigned(map: unknown, fields: LayerField[]): string[] {
  const claimed = new Set(fields.flatMap(claims));
  const found = new Set<string>();
  const walk = (value: unknown, path: string) => {
    if (claimed.has(path)) return;
    if (Array.isArray(value)) value.forEach((item) => walk(item, `${path}[]`));
    else if (
      value !== null &&
      typeof value === "object" &&
      !ArrayBuffer.isView(value)
    )
      for (const [key, child] of Object.entries(value))
        walk(child, path ? `${path}.${key}` : key);
    else if (value !== undefined) found.add(path);
  };
  walk(map, "");
  return [...found].sort();
}

export function layerContent(
  map: GeneratedMap,
  fields: LayerField[] = LAYER_FIELDS,
): Record<Layer, Record<string, unknown>> {
  const loose = unassigned(map, fields);
  if (loose.length)
    throw new Error(`map fields not assigned to a layer: ${loose.join(", ")}`);
  const content = Object.fromEntries(
    LAYERS.map((layer) => [layer, {}]),
  ) as Record<Layer, Record<string, unknown>>;
  for (const field of fields) {
    if (field.unpinned) continue;
    const steps = field.path.split(".");
    let value = read(map, steps);
    if (value === undefined) {
      if (!field.optional) throw new Error(`map field missing: ${field.path}`);
      content[field.layer][field.name] = null;
      continue;
    }
    if (field.filter && Array.isArray(value))
      value = value.filter(field.filter);
    if (field.keys && Array.isArray(value))
      value = value.map((item) =>
        Object.fromEntries(
          field.keys!.map((key) => [
            key,
            (item as Record<string, unknown>)[key],
          ]),
        ),
      );
    content[field.layer][field.name] = field.grid
      ? canonicalGrid(value as CodedGrid)
      : value;
  }
  return content;
}

/**
 * JSON with sorted keys, typed arrays as arrays, and non-finite numbers
 * spelled out: plain JSON writes Infinity as null, which would hide a route
 * metric going from unavailable to zero.
 */
export function stableStringify(value: unknown): string {
  if (typeof value === "number")
    return Number.isFinite(value) ? JSON.stringify(value) : `"#${value}"`;
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (ArrayBuffer.isView(value))
    return stableStringify(Array.from(value as unknown as ArrayLike<number>));
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

export function layerHashes(
  map: GeneratedMap,
  fields: LayerField[] = LAYER_FIELDS,
): LayerHashes {
  const content = layerContent(map, fields);
  return Object.fromEntries(
    LAYERS.map((layer) => [layer, digest(stableStringify(content[layer]))]),
  ) as LayerHashes;
}

export function runCase(sweepCase: SweepCase): SweepEntries {
  const entries: SweepEntries = {};
  for (let i = 1; i <= sweepCase.count; i += 1) {
    const seed = `${sweepCase.seedPrefix}-${i}`;
    const map = sweepMap(sweepCase, seed);
    entries[`${sweepCase.id}/${seed}`] =
      "error" in map ? { error: map.error } : layerHashes(map);
  }
  return entries;
}

/**
 * Every case, split seed by seed across worker threads. Entries come back in
 * case and seed order whatever order the workers finish in.
 */
export async function runSweep(
  cases: SweepCase[],
  jobs = defaultJobs(),
): Promise<SweepEntries> {
  jobs = positiveInteger("jobs", jobs);
  const units = cases.flatMap((c) =>
    Array.from({ length: c.count }, (_, i) => ({
      ...c,
      count: 1,
      offset: i + 1,
    })),
  );
  const results = new Map<string, SweepEntries>();
  let next = 0;
  const work = async () => {
    const worker = new Worker(new URL(import.meta.url));
    let pending:
      | { resolve: (e: SweepEntries) => void; reject: (e: unknown) => void }
      | undefined;
    worker.on("message", (entries: SweepEntries) => pending?.resolve(entries));
    worker.on("error", (error) => pending?.reject(error));
    try {
      while (next < units.length) {
        const unit = units[next++]!;
        const done = new Promise<SweepEntries>((resolve, reject) => {
          pending = { resolve, reject };
        });
        worker.postMessage(unit);
        results.set(`${unit.id}/${unit.offset}`, await done);
      }
    } finally {
      await worker.terminate();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, units.length) }, work));
  return Object.assign(
    {},
    ...units.map((u) => results.get(`${u.id}/${u.offset}`)),
  );
}

/** Half the cores, at most eight: other agents share this machine (#16). */
export function defaultJobs(): number {
  return Math.max(1, Math.min(8, Math.floor(os.availableParallelism() / 2)));
}

/**
 * Entries plus where they came from. The commit is the last one to touch the
 * generator's inputs, so tooling-only commits after it don't hide what was
 * measured. A generator with uncommitted changes is refused: a baseline must
 * name the code it pins.
 */
export function captureBaseline(
  cases: SweepCase[],
  entries: SweepEntries,
): SweepBaseline {
  const root = new URL("..", import.meta.url);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--", "src", "content"))
    throw new Error(
      "src/ or content/ has uncommitted changes; commit them before capturing a baseline",
    );
  return {
    provenance: {
      commit: git("log", "-1", "--format=%H", "--", "src", "content"),
      capturedAt: new Date().toISOString(),
      node: process.version,
      cases,
    },
    entries,
  };
}

export function compareSweep(
  baseline: SweepBaseline,
  current: SweepEntries,
): Drift[] {
  const drift: Drift[] = [];
  const keys = [
    ...new Set([...Object.keys(baseline.entries), ...Object.keys(current)]),
  ];
  for (const key of keys.sort()) {
    const was = baseline.entries[key],
      now = current[key];
    if (!now) drift.push({ key, layers: ["missing"] });
    else if (!was) drift.push({ key, layers: ["unexpected"] });
    else if ("error" in was || "error" in now) {
      if (stableStringify(was) !== stableStringify(now))
        drift.push({ key, layers: ["error"] });
    } else {
      const layers = LAYERS.filter((layer) => was[layer] !== now[layer]);
      if (layers.length) drift.push({ key, layers });
    }
  }
  return drift;
}

// A worker generates one seed of one case at a time, as `runSweep` hands them out.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on("message", (unit: SweepCase & { offset: number }) => {
    const seed = `${unit.seedPrefix}-${unit.offset}`;
    const map = sweepMap(unit, seed);
    port.postMessage({
      [`${unit.id}/${seed}`]:
        "error" in map ? { error: map.error } : layerHashes(map),
    });
  });
}
