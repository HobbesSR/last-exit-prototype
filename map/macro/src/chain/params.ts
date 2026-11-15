/** Caller overrides for macro's default game parameters (51.3). */
import { DEFAULT_CHAIN_PARAMS } from './placement.ts';
import type { ChainParams } from './types.ts';

function assertParamsObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params must be an object');
}

type NumericParam = Exclude<keyof ChainParams, 'mode'>;
const INTEGRAL: readonly NumericParam[] = ['zoneWidth', 'zoneHeight', 'exitCount', 'contestantCount', 'hunterCount'];
const FRACTIONAL: readonly NumericParam[] = ['lootChance', 'lootTierStep'];
/** Shorter names the CLI has always taken. */
const ALIASES: Record<string, NumericParam> = { exits: 'exitCount', contestants: 'contestantCount', hunters: 'hunterCount' };

/** Defaults with caller overrides, rejecting values placement cannot take. */
export function chainParams(input: object = {}): ChainParams {
  assertParamsObject(input);
  const params: ChainParams = { ...DEFAULT_CHAIN_PARAMS };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === 'mode') {
      if (value !== 'game' && value !== 'playground') throw new Error('params.mode must be game or playground');
      params.mode = value;
      continue;
    }
    const target = ALIASES[key] ?? (key as NumericParam);
    const integral = INTEGRAL.includes(target);
    if (!integral && !FRACTIONAL.includes(target)) throw new Error(`params.${key} is not a map param`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || (integral && !Number.isInteger(n)))
      throw new Error(`params.${key} must be ${integral ? 'a whole number' : 'a number'} of at least 0`);
    params[target] = n;
  }
  return params;
}

