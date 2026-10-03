/**
 * The chain's seed sweep (53, "Proving a change: the sweep"): each map is reduced to one
 * content hash per object and view, so a change says which stage it moved.
 *
 * A map holds two objects, the Layout and the region results, and every other stage
 * output is a view of them (51). Each is hashed whole, through `mapViews`, the one
 * accessor the tools read, so a view can't leave coverage by moving. `MAP_FIELDS` names
 * where each of the map's own fields is pinned, and hashing refuses a field it doesn't
 * name.
 *
 * - **A behaviour-preserving change** leaves every hash unchanged. A moved hash is a
 *   stop-and-escalate.
 * - **A deliberate content change** says so in its PR, and recaptures the baseline last,
 *   after the report shows no defects and maps play acceptably.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { mapViews } from '../macro/src/chain/map.ts';
import { generate } from './core.ts';
import type { ToolMap } from './core.ts';
import { GAME_ENGINES } from './engines.ts';

/** The objects first, then the views in stage order. */
export const VIEWS = ['layout', 'results', 'declaredGrid', 'resolved', 'regions', 'proof', 'zones', 'briefs', 'built', 'report'] as const;
export type View = (typeof VIEWS)[number];
export type ViewHashes = Record<View, string>;
/** A seed the chain refused is pinned by its message. */
export type SweepEntry = ViewHashes | { error: string };
export type SweepEntries = Record<string, SweepEntry>;

/**
 * Where each of the map's own fields is pinned. The library is pinned by the fingerprint
 * the Layout records, so a library change moves `layout`.
 */
const MAP_FIELDS: Record<Exclude<keyof ToolMap, symbol>,'layout' | 'results' | 'fingerprint'> = {
  layout: 'layout', results: 'results', cellSize: 'results', build: 'results', library: 'fingerprint',
};

export interface SweepCase {
  id: string;
  params: Record<string, unknown>;
  seedPrefix: string;
  count: number;
}
export interface SweepBaseline {
  provenance: { commit: string; capturedAt: string; node: string; cases: SweepCase[] };
  entries: SweepEntries;
}
export interface Drift {
  key: string;
  views: string[];
}

const playground = (zoneWidth: number, zoneHeight: number) => ({ mode: 'playground', zoneWidth, zoneHeight });

/** Cheap enough for `npm test`, which pins it against the committed baseline. */
export const QUICK_CASES: SweepCase[] = [
  { id: 'playground-2x1', params: playground(2, 1), seedPrefix: 'quick', count: 3 },
  { id: 'game', params: {}, seedPrefix: 'quick', count: 1 },
];

/**
 * A command-line count as a positive integer. Anything else is refused, so a typo can't
 * capture a sparse baseline and report success.
 */
export function positiveInteger(name: string, raw: unknown): number {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return value;
}

/**
 * The full sweep: `count` game maps, plus smaller spreads over the spawn and exit counts
 * and playground sizes. Game mode takes only its own zone size.
 */
export function sweepCases(requested: unknown = 120): SweepCase[] {
  const count = positiveInteger('count', requested);
  const spread = Math.max(1, Math.round(count / 6));
  return [
    { id: 'game', params: {}, seedPrefix: 'sweep', count },
    { id: 'game-crowded', params: { exitCount: 3, contestantCount: 24, hunterCount: 6 }, seedPrefix: 'sweep', count: spread },
    { id: 'game-sparse', params: { exitCount: 1, contestantCount: 2, hunterCount: 1 }, seedPrefix: 'sweep', count: spread },
    { id: 'playground', params: { mode: 'playground' }, seedPrefix: 'sweep', count: spread },
    { id: 'playground-4x2', params: playground(4, 2), seedPrefix: 'sweep', count: spread },
    { id: 'playground-6x3', params: playground(6, 3), seedPrefix: 'sweep', count: spread },
    ...QUICK_CASES,
  ];
}

/**
 * JSON with sorted keys, typed arrays as arrays, and non-finite numbers spelled out:
 * plain JSON writes Infinity as null, which would hide a metric going from unavailable
 * to zero. A Map or Set is refused, since its content wouldn't be hashed.
 */
export function stableStringify(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : `"#${value}"`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Map || value instanceof Set) throw new Error(`a ${value.constructor.name} can't be hashed by content`);
  if (ArrayBuffer.isView(value)) return stableStringify(Array.from(value as unknown as ArrayLike<number>));
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Each object and view of a map, hashed by content. */
export function viewContent(map: ToolMap): Record<View, unknown> {
  const loose = Object.keys(map).filter((key) => !(key in MAP_FIELDS));
  if (loose.length) throw new Error(`map fields the sweep doesn't pin: ${loose.join(', ')}`);
  const views = mapViews(map, GAME_ENGINES.compose);
  return {
    layout: map.layout,
    results: { build: map.build, cellSize: map.cellSize, results: map.results },
    declaredGrid: views.declaredGrid, resolved: views.resolved, regions: views.regions, proof: views.proof,
    zones: views.zones, briefs: views.briefs, built: views.built, report: views.report,
  };
}

export function viewHashes(map: ToolMap): ViewHashes {
  const content = viewContent(map);
  return Object.fromEntries(VIEWS.map((view) => [view, digest(stableStringify(content[view]))])) as ViewHashes;
}

function sweepEntry(sweepCase: SweepCase, seed: string): SweepEntry {
  try {
    return viewHashes(generate(seed, sweepCase.params));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function runCase(sweepCase: SweepCase): SweepEntries {
  const entries: SweepEntries = {};
  for (let i = 1; i <= sweepCase.count; i += 1) {
    const seed = `${sweepCase.seedPrefix}-${i}`;
    entries[`${sweepCase.id}/${seed}`] = sweepEntry(sweepCase, seed);
  }
  return entries;
}

type SweepUnit = SweepCase & { offset: number };
/** A unit's entry key. Two cases may share an id across seed prefixes, so the seed is in it. */
const unitKey = (unit: SweepUnit) => `${unit.id}/${unit.seedPrefix}-${unit.offset}`;

/**
 * Every case, split seed by seed across worker threads. Entries come back in case and
 * seed order whatever order the workers finish in.
 */
export async function runSweep(cases: SweepCase[], jobs = defaultJobs()): Promise<SweepEntries> {
  jobs = positiveInteger('jobs', jobs);
  const units: SweepUnit[] = cases.flatMap((c) => Array.from({ length: c.count }, (_, i) => ({ ...c, count: 1, offset: i + 1 })));
  const results = new Map<string, SweepEntries>();
  let next = 0;
  const work = async () => {
    const worker = new Worker(new URL(import.meta.url));
    let pending: { resolve: (e: SweepEntries) => void; reject: (e: unknown) => void } | undefined;
    worker.on('message', (entries: SweepEntries) => pending?.resolve(entries));
    worker.on('error', (error) => pending?.reject(error));
    try {
      while (next < units.length) {
        const unit = units[next++]!;
        const done = new Promise<SweepEntries>((resolve, reject) => { pending = { resolve, reject }; });
        worker.postMessage(unit);
        results.set(unitKey(unit), await done);
      }
    } finally {
      await worker.terminate();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, units.length) }, work));
  return Object.assign({}, ...units.map((u) => results.get(unitKey(u))));
}

/** Half the cores, at most eight: other agents share this machine. */
export function defaultJobs(): number {
  return Math.max(1, Math.min(8, Math.floor(os.availableParallelism() / 2)));
}

/** What a chain map is made from: macro's stages and library, the game's strategies, and the kernel and core they share. */
const INPUTS = ['map/macro/src', 'map/macro/content', 'map/micro', 'map/kernel', 'map/chain.ts', 'map/engines.ts', 'shared'];

/**
 * Entries plus where they came from. The commit is the last one to touch the chain's
 * inputs, so tooling-only commits after it don't hide what was measured. Inputs with
 * uncommitted changes are refused: a baseline must name the code it pins.
 */
export function captureBaseline(cases: SweepCase[], entries: SweepEntries): SweepBaseline {
  const root = new URL('../..', import.meta.url);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain', '--', ...INPUTS))
    throw new Error(`the chain's inputs have uncommitted changes; commit them before capturing a baseline (${INPUTS.join(', ')})`);
  return {
    provenance: { commit: git('log', '-1', '--format=%H', '--', ...INPUTS), capturedAt: new Date().toISOString(), node: process.version, cases },
    entries,
  };
}

export function compareSweep(baseline: SweepBaseline, current: SweepEntries): Drift[] {
  const drift: Drift[] = [];
  for (const key of [...new Set([...Object.keys(baseline.entries), ...Object.keys(current)])].sort()) {
    const was = baseline.entries[key], now = current[key];
    if (!now) drift.push({ key, views: ['missing'] });
    else if (!was) drift.push({ key, views: ['unexpected'] });
    else if ('error' in was || 'error' in now) {
      if (stableStringify(was) !== stableStringify(now)) drift.push({ key, views: ['error'] });
    } else {
      const views = VIEWS.filter((view) => was[view] !== now[view]);
      if (views.length) drift.push({ key, views });
    }
  }
  return drift;
}

// A worker generates one seed of one case at a time, as `runSweep` hands them out.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (unit: SweepUnit) => {
    const seed = `${unit.seedPrefix}-${unit.offset}`;
    port.postMessage({ [`${unit.id}/${seed}`]: sweepEntry(unit, seed) });
  });
}
