import {
  DEFAULT_LIBRARY,
  DEFAULT_PARAMS,
  generateMap,
  validateLibrary,
  validateMap,
} from "../src/core.ts";
import type { GeneratedMap, Library, MapParams } from "../src/types.ts";

export interface BatchReport {
  count: number;
  seedPrefix: string;
  valid: boolean;
  metrics: Record<string, Distribution>;
  failures: Array<{ seed: string; error: string }>;
}
export interface Distribution {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

export const MAX_BATCH_COUNT = 1000;
export const MAX_JSON_BYTES = 32 * 1024 * 1024;

export function assertObject(
  value: unknown,
  name = "value",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseJson(text: unknown, name = "JSON"): unknown {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_JSON_BYTES)
    throw new Error(`${name} is too large`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

export function makeParams(input: Record<string, unknown> = {}): MapParams {
  assertObject(input, "params");
  const params: MapParams = { ...DEFAULT_PARAMS };
  if (input.mode !== undefined) {
    if (input.mode !== "game" && input.mode !== "playground")
      throw new Error("params.mode must be game or playground");
    params.mode = input.mode;
  }
  type NumericMapParam = Exclude<keyof MapParams, "mode">;
  const aliases: Record<string, NumericMapParam> = {
    exits: "exitCount",
  };
  const integral = new Set<NumericMapParam>([
    "zoneWidth",
    "zoneHeight",
    "exitCount",
  ]);
  for (const key of [
    "zoneWidth",
    "zoneHeight",
    "exitCount",
    "contestantRadius",
    "hunterRadius",
    "exits",
  ]) {
    if (input[key] !== undefined) {
      const n = Number(input[key]);
      const target = aliases[key] || (key as NumericMapParam);
      if (
        !Number.isFinite(n) ||
        (integral.has(target) && !Number.isInteger(n)) ||
        ((target === "contestantRadius" || target === "hunterRadius") && n <= 0)
      )
        throw new Error(
          `params.${key} must be ${integral.has(target) ? "an integer" : "a positive number"}`,
        );
      params[target] = n;
    }
  }
  return params;
}

export function generate(
  seed: unknown,
  params: Record<string, unknown> = {},
  library: Library = DEFAULT_LIBRARY,
): GeneratedMap {
  if (typeof seed !== "string" && typeof seed !== "number")
    throw new Error("seed must be a string or number");
  const checkedLibrary = validateLibrary(library);
  if (!checkedLibrary.valid)
    throw new Error(`invalid library: ${checkedLibrary.errors.join("; ")}`);
  const map = generateMap(String(seed), makeParams(params), library);
  const checkedMap = validateMap(map);
  if (!checkedMap.valid)
    throw new Error(`generated invalid map: ${checkedMap.errors.join("; ")}`);
  return map;
}

function distribution(values: number[]): Distribution {
  const ordered = values.slice().sort((a, b) => a - b);
  const percentile = (p: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(p * ordered.length) - 1)]!;
  return {
    min: ordered[0]!,
    max: ordered.at(-1)!,
    mean: ordered.reduce((sum, value) => sum + value, 0) / ordered.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

export function batch(
  seedPrefix: string | number = "batch",
  count: unknown = 100,
  params: Record<string, unknown> = {},
  library: Library = DEFAULT_LIBRARY,
): BatchReport {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_COUNT)
    throw new Error(`count must be an integer from 1 to ${MAX_BATCH_COUNT}`);
  const metricSamples: Record<string, number[]> = {};
  const failures: Array<{ seed: string; error: string }> = [];
  for (let i = 0; i < n; i += 1) {
    const seed = `${seedPrefix}-${i + 1}`;
    try {
      const map = generate(seed, params, library);
      for (const [key, value] of Object.entries(map.metrics || {})) {
        if (typeof value === "number" && Number.isFinite(value))
          (metricSamples[key] ||= []).push(value);
      }
    } catch (error) {
      failures.push({
        seed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    count: n,
    seedPrefix: String(seedPrefix),
    valid: failures.length === 0,
    metrics: Object.fromEntries(
      Object.entries(metricSamples).map(([key, values]) => [
        key,
        distribution(values),
      ]),
    ),
    failures,
  };
}

export { DEFAULT_LIBRARY, DEFAULT_PARAMS, validateLibrary, validateMap };
