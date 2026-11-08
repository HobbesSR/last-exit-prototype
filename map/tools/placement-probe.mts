#!/usr/bin/env node
/** #857 measurement only: each seed's placement attempts, open-face refusals, longest stall
 * (refusals between two new depths; the limit fires past `PLACEMENT_STALL_LIMIT`), search
 * nodes and time. Prints one JSON line a seed, then a summary line. Never writes anything.
 * node map/tools/placement-probe.mts --size 12|24|36|playground --prefix sweep --from 1 --to 120
 * Optional: --lookahead CELLS (0 turns the lookahead off; the default is `LOOKAHEAD_CELLS`).
 * Optional: --start-end-first enables the off-by-default landing/evac priority experiment.
 * `playground` is a 36 x 18 playground over the 12 x 6 library, as `tests/wfc-large`. Size
 * 24 and 36 use #688's parameters (42.37). Time a comparison under the bench lock (31, 42.39).
 */
import { performance } from 'node:perf_hooks';
import { bundledLibrary, chainParams } from './core.ts';
import { PLACEMENT_STALL_LIMIT, placer } from '../macro/src/chain/placement.ts';
import type { PlacementAttempt } from '../macro/src/chain/placement.ts';

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(name);
  if (i < 0) {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};
const size = arg('--size'), prefix = arg('--prefix'), from = Number(arg('--from')), to = Number(arg('--to', String(from)));
const lookaheadText = arg('--lookahead', ''), lookahead = lookaheadText === '' ? undefined : Number(lookaheadText);
if (!['12', '24', '36', 'playground'].includes(size)) throw new Error('--size is 12, 24, 36 or playground');
if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) throw new Error('--from and --to are seed numbers');

const larger = (width: number) => ({ zoneWidth: width, zoneHeight: width / 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 });
const params = size === '12' ? chainParams({}) : size === 'playground' ? chainParams({ ...larger(36), mode: 'playground' }) : chainParams(larger(Number(size)));
const baseLibrary = bundledLibrary(size === 'playground' ? chainParams({}) : params);
const library = process.argv.includes('--start-end-first') ? { ...baseLibrary, startEndFirst: true } : baseLibrary;

interface Row {
  seed: string; placed: boolean; attempts: number; refusals: number; mostStall: number;
  unsolved: number; setPieceMisfits: number; nodes: number; ms: number; cpuMs: number;
  outcomes: Record<string, number>;
}
const rows: Row[] = [];
for (let n = from; n <= to; n++) {
  const seed = `${prefix}-${n}`, attempts: PlacementAttempt[] = [];
  const started = performance.now(), cpu = process.cpuUsage();
  let placed = true;
  try {
    placer({ openFace: true, attempts: (attempt) => attempts.push(attempt), ...(lookahead === undefined ? {} : { lookahead }) })(seed, params, library);
  } catch {
    placed = false;
  }
  const used = process.cpuUsage(cpu);
  const row: Row = {
    seed, placed, attempts: attempts.length,
    refusals: attempts.reduce((sum, a) => sum + a.refusals, 0),
    mostStall: Math.max(0, ...attempts.map((a) => a.mostStall)),
    unsolved: attempts.filter((a) => a.outcome === 'wfc').length,
    setPieceMisfits: attempts.filter((a) => a.outcome.startsWith('set piece')).length,
    nodes: attempts.reduce((sum, a) => sum + a.nodes, 0),
    ms: Math.round(performance.now() - started), cpuMs: Math.round((used.user + used.system) / 1000),
    outcomes: Object.fromEntries([...new Set(attempts.map(a => a.outcome))].map(outcome => [outcome, attempts.filter(a => a.outcome === outcome).length])),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const sum = (key: 'refusals' | 'nodes' | 'ms' | 'cpuMs') => rows.reduce((total, row) => total + row[key], 0);
console.log(JSON.stringify({
  summary: true, seeds: rows.length, failed: rows.filter((row) => !row.placed).length,
  retried: rows.filter((row) => row.attempts > 1).length, refusals: sum('refusals'),
  worstStall: Math.max(...rows.map((row) => row.mostStall)), stallLimitFired: rows.filter((row) => row.mostStall > PLACEMENT_STALL_LIMIT).length,
  nodes: sum('nodes'), ms: sum('ms'), worstMs: Math.max(...rows.map((row) => row.ms)), cpuMs: sum('cpuMs'),
  attempts: rows.reduce((total, row) => total + row.attempts, 0),
  setPieceMisfits: rows.reduce((total, row) => total + row.setPieceMisfits, 0),
  outcomes: rows.reduce<Record<string, number>>((counts, row) => {
    for (const [outcome, count] of Object.entries(row.outcomes)) counts[outcome] = (counts[outcome] ?? 0) + count;
    return counts;
  }, {}),
}));
