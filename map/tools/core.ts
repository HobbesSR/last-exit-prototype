/**
 * What the Map Lab, CLI and MCP share (53, "Tools"): generate, validate, read and batch
 * chain maps with the game's engines. Every surface calls these, so they agree on seed,
 * params, library, validation and saved output. It runs in Node and the browser alike.
 */
import { checkedLibrary, chainParams, generate, seedText } from '../chain.ts';
import type { GameChainMap } from '../chain.ts';
import { mapViews } from '../macro/src/chain/map.ts';
import { decodeChainMap, readChainMap } from '../macro/src/chain/saving.ts';
import type { Defect, Report } from '../macro/src/chain/types.ts';
import { diagnoseBuiltMap } from '../micro/diagnose.ts';
import type { BrokenPromise } from '../micro/diagnose.ts';
import { GAME_ENGINES } from './engines.ts';

export { CHAIN_LIBRARY, chainParams, generate, validateLibrary } from '../chain.ts';
export type ToolMap = GameChainMap;


export const MAX_BATCH_COUNT = 1000;
export const MAX_JSON_BYTES = 32 * 1024 * 1024;

export function assertObject(value: unknown, name = 'value'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function parseJson(text: unknown, name = 'JSON'): unknown {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_JSON_BYTES) throw new Error(`${name} is too large`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

/**
 * A saved map, as bytes in either encoding or as parsed wire JSON, with the library it was
 * made from. A save of the Layout alone is rebuilt by the game's strategies, refused by name
 * if they aren't the version it records.
 */
export function readMap(saved: Uint8Array | object, library?: unknown): ToolMap {
  const checked = library === undefined ? undefined : checkedLibrary(library);
  const map = saved instanceof Uint8Array ? readChainMap(saved, checked, GAME_ENGINES) : decodeChainMap(saved, checked, GAME_ENGINES);
  checkedLibrary(map.library);
  return map;
}

export interface MapCheck {
  seed: string;
  /** No defect in the report, and none from the diagnostic when it ran. */
  valid: boolean;
  defects: Defect[];
  coreElements: Report['coreElements'];
  metrics: Report['metrics'];
  /** The game's per-region portal check, present only when asked for: it takes about a minute on a game map. */
  brokenPromises?: BrokenPromise[];
}

/**
 * The report (51 step 8) and, on request, the game's `diagnoseBuiltMap` beside it. Both
 * locate defects; neither repairs the map, so `valid` only says whether any was found.
 */
export function checkMap(map: ToolMap, { diagnose = false } = {}): MapCheck {
  const views = mapViews(map, GAME_ENGINES.compose);
  const { defects, coreElements, metrics } = views.report;
  const check: MapCheck = { seed: map.layout.seed, valid: !defects.length, defects, coreElements, metrics };
  if (diagnose) {
    check.brokenPromises = diagnoseBuiltMap(views.built);
    check.valid &&= !check.brokenPromises.length;
  }
  return check;
}

/**
 * One metric across the maps that measured it. The statistics are null when none did.
 */
export interface Distribution {
  samples: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
}

function distribution(values: number[]): Distribution {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return { samples: 0, min: null, max: null, mean: null, p50: null, p95: null };
  const percentile = (p: number) => ordered[Math.min(ordered.length - 1, Math.ceil(p * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    max: ordered.at(-1)!,
    mean: ordered.reduce((sum, value) => sum + value, 0) / ordered.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

/** Summarise each numeric metric across maps. */
export function summarizeMetrics(records: Array<Record<string, number>>): Record<string, Distribution> {
  const samples: Record<string, number[]> = {};
  for (const record of records)
    for (const [key, value] of Object.entries(record)) (samples[key] ||= []).push(value);
  return Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, distribution(values)]));
}

export interface BatchReport {
  seedPrefix: string;
  /** Seeds asked for. */
  count: number;
  /** Maps generated and checked: the sample size behind `metrics`. */
  generated: number;
  /** No seed failed, and no map has a defect. */
  valid: boolean;
  diagnosed: boolean;
  /** Each map's report metrics, plus `generateMs` and `defects`. */
  metrics: Record<string, Distribution>;
  /** Seeds whose map was found with defects, and what they were. */
  defective: Array<{ seed: string; defects: string[] }>;
  /** Seeds that threw, such as placement finding no valid layout. */
  failures: Array<{ seed: string; error: string }>;
}

/** Generate and check `count` maps, seeds `prefix-1` onwards. */
export function batch(seedPrefix: unknown = 'batch', count: unknown = 20, params: object = {},
  library?: unknown, { diagnose = false } = {}): BatchReport {
  const prefix = seedText(seedPrefix), n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_COUNT) throw new Error(`count must be an integer from 1 to ${MAX_BATCH_COUNT}`);
  // Both are checked once, before any map is made.
  const checked = checkedLibrary(library), resolved = chainParams(params);
  const measured: Array<Record<string, number>> = [];
  const defective: BatchReport['defective'] = [];
  const failures: BatchReport['failures'] = [];
  for (let i = 1; i <= n; i++) {
    const seed = `${prefix}-${i}`;
    try {
      const started = performance.now();
      const map = generate(seed, resolved, checked);
      const generateMs = performance.now() - started;
      const check = checkMap(map, { diagnose });
      measured.push({ ...check.metrics, generateMs, defects: check.defects.length + (check.brokenPromises?.length ?? 0) });
      if (!check.valid) defective.push({ seed, defects: [
        ...check.defects.map(defect => `${defect.kind}: ${defect.message}`),
        ...(check.brokenPromises ?? []).map(broken => `broken-promise (diagnostic): ${broken.region}: ${broken.errors.join('; ')}`),
      ] });
    } catch (error) {
      failures.push({ seed, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    seedPrefix: prefix, count: n, generated: measured.length, valid: !failures.length && !defective.length, diagnosed: diagnose,
    metrics: summarizeMetrics(measured), defective, failures,
  };
}
