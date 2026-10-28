/**
 * Replaying one region type's real briefs (53, "Replaying one region type"): the inner check
 * before the full sweep, for a change to a builder.
 *
 * A builder can't move anything upstream of the briefs, so regenerating a map to see it is
 * mostly wasted work. `captureBriefs` writes every sweep map's briefs, bucketed by region
 * type, to a local cache beside what the baseline's builders made of each (a result hash and
 * its manifest). `replayBriefs` rebuilds only the named types' briefs and compares.
 *
 * The cache decomposes the committed baseline, so it is valid exactly while the baseline's
 * `briefs` and `results` hashes for each map are the ones it was captured against (the chain
 * is pure, 51). Capture refuses a tree that doesn't reproduce the baseline, and replay a
 * cache the baseline has moved past. The full sweep stays the integration check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { RegionBrief } from '../kernel/contract.ts';
import { mapViews } from '../macro/src/chain/map.ts';
import { diagnoseRegion } from '../micro/diagnose.ts';
import { REGION_TYPES, REGION_TYPES_VERSION } from '../micro/region-types.ts';
import { SHARED_MANIFEST } from '../micro/result.ts';
import { GAME_ENGINES } from './engines.ts';
import { compareSweep, contentHash, defaultJobs, runPool, sweepMap, sweepUnits, unitKey, unitSeed } from './sweep.mts';
import type { SweepBaseline, SweepEntry, SweepUnit } from './sweep.mts';

const FORMAT = 1;
const INDEX = 'index.json';
const REGIONS = 'regions';
/** Where a capture writes until it is known to reproduce the baseline. */
const STAGING = 'regions.new';
/** Beside the other generated output, which is not committed, in whichever worktree runs it. */
export const DEFAULT_CACHE = fileURLToPath(new URL('../../test-results/sweep-briefs', import.meta.url));

/**
 * Which rebuilt regions get the portal check (`diagnoseRegion`), which costs seconds a region
 * for the largest types. A region whose result matches the baseline's can't have a finding the
 * change caused, so `drifted` is the default; `all` audits the whole corpus.
 */
export const REACH_MODES = ['drifted', 'all', 'none'] as const;
export type Reach = (typeof REACH_MODES)[number];

type Manifest = Record<string, number>;
/** A region as the baseline's builders left it: the brief they were given, and what they made. */
interface RegionRecord { brief: RegionBrief; hash: string; manifest: Manifest }
/** What a cached map was captured against, and how many regions of each type it holds. */
interface CachedMap { briefs: string; results: string; types: Record<string, number> }
interface CacheIndex {
  format: number;
  baseline: { commit: string; capturedAt: string };
  /** The strategies' version at capture. The hashes decide validity; this says what made them. */
  build: string;
  maps: Record<string, CachedMap>;
}

const regionFile = (regions: string, type: string, key: string) => path.join(regions, type, `${key}.json.gz`);
const readRecords = (file: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as RegionRecord[];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `regions` is the directory a unit writes or reads its type directories in. */
interface CaptureUnit { task: 'capture'; unit: SweepUnit; regions: string }
interface CaptureReply { key: string; entry: SweepEntry; types: Record<string, number> }
interface ReplayUnit { task: 'replay'; type: string; key: string; regions: string; reach: Reach }
export interface RegionAt { map: string; region: string; type: string }
export interface FeatureCount { total: number; regions: number }
interface ReplayReply {
  regions: number;
  reachChecked: number;
  /** The type's own manifest counts over these regions. */
  features: Record<string, FeatureCount>;
  drift: Array<RegionAt & { manifest: Record<string, [was: number, now: number]> }>;
  threw: Array<RegionAt & { error: string }>;
  brokenPromises: Array<RegionAt & { errors: string[] }>;
}

/** Runs in a worker: one seed's map, written to the cache as its briefs and what built them. */
function captureMap({ unit, regions }: CaptureUnit): CaptureReply {
  const key = unitKey(unit), made = sweepMap(unit, unitSeed(unit));
  if (!made.map) return { key, entry: made.entry, types: {} };
  const { map, entry } = made;
  const briefs = mapViews(map).briefs;
  // A cached brief must hash as the baseline's did, or a replay would build something else.
  if (contentHash(JSON.parse(JSON.stringify(briefs))) !== entry.briefs) throw new Error(`${key}: its briefs don't survive JSON`);
  const byType = new Map<string, RegionRecord[]>();
  briefs.forEach((brief, i) => {
    const result = map.results[i]!;
    byType.set(brief.type, [...byType.get(brief.type) ?? [], { brief, hash: contentHash(result), manifest: result.manifest }]);
  });
  for (const [type, records] of byType) {
    const file = regionFile(regions, type, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(records)));
  }
  return { key, entry, types: Object.fromEntries([...byType].map(([type, records]) => [type, records.length])) };
}

/** Runs in a worker: one map's regions of one type, rebuilt from their cached briefs. */
function replayMap({ type, key, regions, reach }: ReplayUnit): ReplayReply {
  const records = readRecords(regionFile(regions, type, key));
  const reply: ReplayReply = { regions: records.length, reachChecked: 0, features: {}, drift: [], threw: [], brokenPromises: [] };
  for (const { brief, hash, manifest } of records) {
    const at = { map: key, region: brief.id, type };
    let result;
    try {
      result = GAME_ENGINES.build(brief);
    } catch (error) {
      reply.threw.push({ ...at, error: message(error) });
      continue;
    }
    for (const [feature, count] of Object.entries(result.manifest)) {
      if ((SHARED_MANIFEST as readonly string[]).includes(feature)) continue;
      const seen = (reply.features[feature] ??= { total: 0, regions: 0 });
      seen.total += count;
      if (count) seen.regions += 1;
    }
    const moved = contentHash(result) !== hash;
    if (moved) {
      const changed = [...new Set([...Object.keys(manifest), ...Object.keys(result.manifest)])]
        .filter((feature) => manifest[feature] !== result.manifest[feature]);
      reply.drift.push({ ...at, manifest: Object.fromEntries(changed.map((f) => [f, [manifest[f] ?? 0, result.manifest[f] ?? 0]])) });
    }
    if (reach === 'all' || (reach === 'drifted' && moved)) {
      reply.reachChecked += 1;
      const errors = diagnoseRegion(result);
      if (errors.length) reply.brokenPromises.push({ ...at, errors });
    }
  }
  return reply;
}

const RECAPTURE = 'recapture it with `sweep --capture-briefs <baseline>`';

/**
 * Writes every map's briefs and builders' results to `dir`, for the baseline's cases. The
 * tree must reproduce the baseline's hashes: a cache of any other builders would pin their
 * results, not the baseline's. A capture writes to a staging directory and replaces the
 * cache only once the hashes match, so a failed one leaves the previous cache as it was. The
 * index goes last, so an interruption in the swap leaves no usable cache. The directory is
 * ours to write only if it holds nothing but a cache.
 */
export async function captureBriefs(baseline: SweepBaseline, dir = DEFAULT_CACHE, jobs = defaultJobs()): Promise<{ maps: number; regions: number }> {
  if (fs.existsSync(dir) && fs.readdirSync(dir).some((name) => ![INDEX, REGIONS, STAGING].includes(name)))
    throw new Error(`${dir} holds files that aren't a briefs cache; name another --cache directory`);
  const staging = path.join(dir, STAGING), regions = path.join(dir, REGIONS);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    const units = sweepUnits(baseline.provenance.cases);
    const replies = await runPool<CaptureUnit, CaptureReply>(new URL(import.meta.url), units.map((unit) => ({ task: 'capture', unit, regions: staging })), jobs);
    const drift = compareSweep(baseline, Object.fromEntries(replies.map((reply) => [reply.key, reply.entry])));
    if (drift.length) {
      const named = drift.slice(0, 5).map((d) => `${d.key} (${d.views.join(', ')})`).join('; ');
      throw new Error(`this tree doesn't reproduce the baseline: ${drift.length} of ${replies.length} maps moved, ${named}. `
        + 'Capture from a tree whose sweep check shows no drift, such as the baseline\'s own commit.');
    }
    const maps: Record<string, CachedMap> = {};
    for (const { key, entry, types } of replies) {
      if ('error' in entry) continue;
      maps[key] = { briefs: entry.briefs, results: entry.results, types };
    }
    const index: CacheIndex = { format: FORMAT, baseline: { commit: baseline.provenance.commit, capturedAt: baseline.provenance.capturedAt }, build: REGION_TYPES_VERSION, maps };
    fs.rmSync(path.join(dir, INDEX), { force: true });
    fs.rmSync(regions, { recursive: true, force: true });
    fs.renameSync(staging, regions);
    fs.writeFileSync(path.join(dir, INDEX), `${JSON.stringify(index)}\n`);
    return { maps: Object.keys(maps).length, regions: Object.values(maps).reduce((n, m) => n + Object.values(m.types).reduce((a, b) => a + b, 0), 0) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** The cache's index, refused unless the baseline still pins exactly what it was captured against. */
function readIndex(baseline: SweepBaseline, dir: string): CacheIndex {
  const file = path.join(dir, INDEX);
  if (!fs.existsSync(file)) throw new Error(`no briefs cache at ${dir}; capture one with \`sweep --capture-briefs <baseline>\``);
  const index = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheIndex;
  if (index.format !== FORMAT) throw new Error(`the briefs cache at ${dir} is format ${index.format}, not ${FORMAT}; ${RECAPTURE}`);
  const stale: string[] = [];
  for (const key of new Set([...Object.keys(baseline.entries), ...Object.keys(index.maps)])) {
    const pinned = baseline.entries[key], cached = index.maps[key];
    if (!pinned) stale.push(key);
    else if ('error' in pinned) { if (cached) stale.push(key); }
    else if (!cached || cached.briefs !== pinned.briefs || cached.results !== pinned.results) stale.push(key);
  }
  if (stale.length) {
    throw new Error(`the briefs cache is stale: the baseline's briefs or results moved for ${stale.length} of ${Object.keys(baseline.entries).length} maps `
      + `(${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', ...' : ''}); ${RECAPTURE}`);
  }
  return index;
}

/** The strategies by type name, so two types bound to one builder compare equal. */
const registry: Record<string, unknown> = REGION_TYPES;

/**
 * The types a `--type` list replays: those named, and any bound to the same strategy (in
 * `REGION_TYPES`), since one builder change moves them together.
 */
export function typesToReplay(requested: string): string[] {
  const names = requested.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !Object.hasOwn(registry, name));
  if (!names.length || unknown.length)
    throw new Error(`${unknown.length ? `unknown region type ${unknown.join(', ')}` : '--type names no region type'}; the types are ${Object.keys(registry).join(', ')}`);
  return Object.keys(registry).filter((type) => names.some((name) => registry[name] === registry[type]));
}

export interface ReplayReport {
  /** The types replayed. */
  types: string[];
  /** Maps holding a region of these types, and the regions, which is how much the corpus tests them. */
  maps: number;
  regions: number;
  /** Own manifest counts over the rebuilt regions, per type: a thin corpus is visible here. */
  features: Record<string, Record<string, FeatureCount>>;
  /** Regions whose result differs from the baseline's, with the manifest counts that moved. */
  drift: ReplayReply['drift'];
  threw: ReplayReply['threw'];
  reach: Reach;
  reachChecked: number;
  brokenPromises: ReplayReply['brokenPromises'];
}

/** True if the replay found anything to stop on. */
export const replayFailed = (report: ReplayReport) => !!(report.drift.length || report.threw.length || report.brokenPromises.length);

/**
 * Rebuilds the named types' cached briefs, in parallel, and reports against the baseline's
 * builders per region: which drifted, which threw, which broke the portal promise.
 */
export async function replayBriefs(baseline: SweepBaseline, types: string[], { dir = DEFAULT_CACHE, reach = 'drifted', jobs = defaultJobs() }:
  { dir?: string; reach?: Reach; jobs?: number } = {}): Promise<ReplayReport> {
  if (!types.length) throw new Error('no region type to replay');
  const index = readIndex(baseline, dir);
  const units = types.flatMap((type) => Object.entries(index.maps).filter(([, cached]) => cached.types[type])
    .map(([key]): ReplayUnit => ({ task: 'replay', type, key, regions: path.join(dir, REGIONS), reach })));
  // Each strategy needs a region of its own: types bound to one count together,
  // but a request for several builders can't pass because one of them was exercised.
  const strategies = new Map<unknown, string[]>();
  for (const type of types) strategies.set(registry[type], [...strategies.get(registry[type]) ?? [], type]);
  const unexercised = [...strategies.values()].filter((group) => !units.some((unit) => group.includes(unit.type)));
  if (unexercised.length)
    throw new Error(`the briefs cache holds no region of type ${unexercised.map((group) => group.join(' or ')).join(', ')}`);
  const replies = await runPool<ReplayUnit, ReplayReply>(new URL(import.meta.url), units, jobs);
  const report: ReplayReport = { types, maps: new Set(units.map((u) => u.key)).size, regions: 0, features: Object.fromEntries(types.map((t) => [t, {}])),
    drift: [], threw: [], reach, reachChecked: 0, brokenPromises: [] };
  replies.forEach((reply, i) => {
    report.regions += reply.regions;
    report.reachChecked += reply.reachChecked;
    report.drift.push(...reply.drift);
    report.threw.push(...reply.threw);
    report.brokenPromises.push(...reply.brokenPromises);
    for (const [feature, count] of Object.entries(reply.features)) {
      const seen = (report.features[units[i]!.type]![feature] ??= { total: 0, regions: 0 });
      seen.total += count.total;
      seen.regions += count.regions;
    }
  });
  return report;
}

if (!isMainThread && parentPort && workerData === import.meta.url) {
  const port = parentPort;
  port.on('message', (unit: CaptureUnit | ReplayUnit) => port.postMessage(unit.task === 'capture' ? captureMap(unit) : replayMap(unit)));
}
