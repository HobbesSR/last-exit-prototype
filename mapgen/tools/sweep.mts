/**
 * A seed sweep that pins generated content, layer by layer (#47, tracking #52).
 *
 * The map-layer refactor (docs/DESIGN_DECISIONS.md, "Map layers") moves fields
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
 * `layerContent` is the only code that knows where each field lives. A stage
 * that moves a field updates it in the same change, and the hashes must not
 * move. A change in any hash is a stop-and-escalate, never a re-baseline.
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
const BUILDERS = {
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

/** The full sweep: `count` seeds per generator at default size, plus smaller spreads. */
export function sweepCases(count = 120): SweepCase[] {
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

function libraryFor(sweepCase: SweepCase): Library {
  if (!sweepCase.builders) return DEFAULT_LIBRARY;
  const library = structuredClone(DEFAULT_LIBRARY);
  for (const [cellClass, generator] of Object.entries(sweepCase.builders))
    library.cellClasses![cellClass] = { generator };
  return library;
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

const isMicroFeature = (id: string) => id.startsWith("micro-");

export function layerContent(map: GeneratedMap): Record<Layer, unknown> {
  const cells = map.grid.cells;
  return {
    layout: {
      seed: map.seed,
      version: map.version,
      params: map.params,
      size: [map.width, map.height],
      tiles: map.tiles.map(({ anchor, ...placement }) => placement),
      declaredClass: canonicalGrid(cells.originalClass),
      features: map.features.filter((f) => !isMicroFeature(f.id)),
    },
    structure: {
      constraints: canonicalGrid(cells.constraints),
      zones: map.zones,
      anchors: map.tiles.map((t) => t.anchor),
    },
    interiors: {
      spawns: cells.spawns,
      level: canonicalGrid(cells.level),
      features: map.features.filter((f) => isMicroFeature(f.id)),
      regions: map.regions.map((r) => ({
        obstacles: r.obstacles,
        manifest: r.manifest,
      })),
    },
    composed: {
      size: [map.grid.width, map.grid.height],
      class: canonicalGrid(cells.class),
      segments: canonicalGrid(map.grid.segments.open),
      vertices: map.grid.vertices,
      edges: map.edges,
      walls: map.walls,
      regions: map.regions.map(({ id, cellClass, area, cells, seed }) => ({
        id,
        cellClass,
        area,
        cells,
        seed,
      })),
    },
    report: { metrics: map.metrics, validation: map.validation },
  };
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

export function layerHashes(map: GeneratedMap): LayerHashes {
  const content = layerContent(map);
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
