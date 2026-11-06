#!/usr/bin/env node
/**
 * #836: what keeps region boundary without a passability guarantee clear. Read-only.
 * Uses 51.10's boundary samples (two quarter points per exposed cell side, a perpendicular
 * sweep from a quarter cell inside to a quarter cell outside at body clearance) and splits
 * them by side class, then attributes each walkable unguaranteed sample. Definitions: 51.10; results: 42.34.
 *
 *   node map/tools/edge-clearance.mts [--widths 12,24,36] [--seeds 1] [--out FILE] [--maps DIR]
 *
 * `--maps DIR` reads `size-W-S.json` (or .json.gz) saved maps there instead of generating.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { generate, readMap, type ToolMap } from './core.ts';
import { chainMapToJson } from '../macro/src/chain/saving.ts';
import { composeRegions } from '../micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../micro/adapter.ts';
import { hintStrength } from '../micro/hints.ts';
import { navigationClearance, navigationMap } from '../../shared/map/navigation.ts';
import { sweptClear } from '../../shared/movement.ts';
import { bounds, segmentShapeDistance, transform, type Shape } from '../../shared/shape.ts';
import type { Vec2 } from '../../shared/types.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]!; };
const widths = arg('--widths', '12,24,36').split(',').map(Number), seeds = arg('--seeds', '1').split(',').map(Number);
const out = arg('--out', ''), mapsDir = arg('--maps', '');
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
/** A unit cell side, keyed by its lesser endpoint and axis: `h` runs along x, `v` along y. */
const sideKey = (c: { x: number; y: number }, dx: number, dy: number) =>
  dx ? `v:${c.x + (dx > 0 ? 1 : 0)},${c.y}` : `h:${c.x},${c.y + (dy > 0 ? 1 : 0)}`;
const runKeys = (run: { axis: 'h' | 'v'; x: number; y: number; length: number }) =>
  Array.from({ length: run.length }, (_, i) => run.axis === 'h' ? `h:${run.x + i},${run.y}` : `v:${run.x},${run.y + i}`);

type Body = 'contestant' | 'hunter';
type Cls = 'edge' | 'guaranteed' | 'unguaranteed';
/** Why a walkable unguaranteed sample is walkable, from this owner's side (42.34). */
type Why = 'cap' | 'strip' | 'empty' | 'setback' | 'near';

function obstacleShapes(map: ToolMap, origin: Vec2): Shape[][] {
  // Obstacles only: doors are openable for navigation, roofs and enclosure rectangles are not collision.
  return map.results.map(r => r.elements.flatMap(e => e.template.parts.flatMap(p =>
    p.part === 'obstacle' ? [transform(p.shape, e.x + origin.x, e.y + origin.y)] : [])));
}

function measure(map: ToolMap) {
  const built = composeRegions(map.results), size = built.cellSize, { origin } = builtMapFrame(built);
  const collision = builtMapCollision(built), nav = navigationMap(collision, true);
  // composeRegions orders regions by id; map.results may not be.
  const resultIndex = new Map(map.results.map((r, i) => [r.brief.id, i]));
  const shapesByResult = obstacleShapes(map, origin);
  const owner = new Map<string, number>();
  built.regions.forEach((r, i) => { for (const c of r.brief.cells) owner.set(`${c.x},${c.y}`, i); });
  // Per-owner cell buckets of obstacle shapes, padded by one cell.
  const buckets = built.regions.map((r) => {
    const m = new Map<string, Shape[]>();
    for (const s of shapesByResult[resultIndex.get(r.brief.id)!]!) {
      const b = bounds(s);
      for (let y = Math.floor(b.y / size) - 1; y <= Math.floor((b.y + b.h) / size) + 1; y++)
        for (let x = Math.floor(b.x / size) - 1; x <= Math.floor((b.x + b.w) / size) + 1; x++) {
          const k = `${x},${y}`; if (!m.has(k)) m.set(k, []); m.get(k)!.push(s);
        }
    }
    return m;
  });
  const near = (region: number, a: Vec2, b: Vec2) => {
    const k = `${Math.floor((a.x + b.x) / 2 / size)},${Math.floor((a.y + b.y) / 2 / size)}`;
    let d = Infinity; for (const s of buckets[region]!.get(k) ?? []) d = Math.min(d, segmentShapeDistance(a, b, s));
    return d;
  };
  // Every guaranteed unit side on the map: portals and internal runs (20.6 derives margins from both).
  const guaranteed = new Set(built.regions.flatMap(r => [...r.brief.portals, ...(r.brief.internalGuaranteed ?? [])].flatMap(runKeys)));
  const alongLine = (key: string, d: number) => { const [axis, rest] = key.split(':'); const [x, y] = rest!.split(',').map(Number);
    return axis === 'h' ? `h:${x! + d},${y}` : `v:${x},${y! + d}`; };
  const world = (x: number, y: number) => ({ x: x * size + origin.x, y: y * size + origin.y });
  const bodies = (['contestant', 'gladiator'] as const).map(role => ({ body: (role === 'gladiator' ? 'hunter' : role) as Body, clearance: navigationClearance(role) }));

  interface Sample { region: number; type: string; cls: Cls; hinted: '' | 'mutual' | 'one-sided'; key: string; across: number;
    fill: boolean; result: Record<Body, { blocked: boolean; own: boolean; other: boolean; why: Why | null }> }
  const samples: Sample[] = [];
  built.regions.forEach((r, region) => {
    const cells = new Set(r.brief.cells.map(c => `${c.x},${c.y}`));
    const portal = new Set(r.brief.portals.flatMap(runKeys));
    const hinted = new Map<string, 'mutual' | 'one-sided'>();
    for (const h of r.brief.hints ?? []) for (const k of runKeys(h)) hinted.set(k, hintStrength(h));
    const fill = new Set((r.brief.fillCells ?? r.brief.cells).map(c => `${c.x},${c.y}`));
    for (const c of r.brief.cells) for (const [dx, dy] of DIRS) {
      const acrossKey = `${c.x + dx},${c.y + dy}`;
      if (cells.has(acrossKey)) continue;
      const key = sideKey(c, dx, dy), across = owner.get(acrossKey) ?? -1;
      const cls: Cls = across < 0 ? 'edge' : portal.has(key) ? 'guaranteed' : 'unguaranteed';
      for (const offset of [-.25, .25]) {
        const p = world(c.x + .5 + dx * .5 + (dy ? offset : 0), c.y + .5 + dy * .5 + (dx ? offset : 0));
        const a = { x: p.x - dx * size / 4, y: p.y - dy * size / 4 }, b = { x: p.x + dx * size / 4, y: p.y + dy * size / 4 };
        const deep = { x: p.x - dx * size, y: p.y - dy * size };
        const result = {} as Sample['result'];
        for (const { body, clearance } of bodies) {
          const blocked = !sweptClear(nav, a, b, clearance);
          const own = near(region, a, b) < clearance, other = across >= 0 && near(across, a, b) < clearance;
          let why: Why | null = null;
          if (cls === 'unguaranteed' && !blocked) {
            // Distance from the boundary point to this owner's content, inward up to one cell.
            const inward = near(region, p, deep);
            // A clear cell is an end cap when a guaranteed run on this same line ends beside this side; otherwise a side strip.
            why = !fill.has(`${c.x},${c.y}`) ? (guaranteed.has(alongLine(key, -1)) || guaranteed.has(alongLine(key, 1)) ? 'cap' : 'strip') : inward > size / 2 ? 'empty' : near(region, p, p) > size / 2 ? 'setback' : 'near';
          }
          result[body] = { blocked, own, other, why };
        }
        samples.push({ region, type: r.brief.type, cls, hinted: hinted.get(key) ?? '', key, across, fill: fill.has(`${c.x},${c.y}`), result });
      }
    }
  });

  // Seams: unguaranteed unit sides between two owners, seen from both; runs are maximal collinear stretches between one pair.
  const seams = new Map<string, { a: number; b: number; byOwner: Map<number, Sample[]> }>();
  for (const s of samples) if (s.cls === 'unguaranteed') {
    const [lo, hi] = [Math.min(s.region, s.across), Math.max(s.region, s.across)];
    let seam = seams.get(s.key); if (!seam) seams.set(s.key, seam = { a: lo, b: hi, byOwner: new Map() });
    if (!seam.byOwner.has(s.region)) seam.byOwner.set(s.region, []); seam.byOwner.get(s.region)!.push(s);
  }
  const seamSummary = Object.fromEntries(bodies.map(({ body }) => {
    const unit = new Map<string, 'both-walkable' | 'one-blocked' | 'both-blocked'>(), eligible = new Set<string>();
    for (const [key, seam] of seams) {
      // A side is blocked when its own content blocks either of its samples.
      const sides = [seam.a, seam.b].map(o => (seam.byOwner.get(o) ?? []).some(s => s.result[body].own));
      const n = sides.filter(Boolean).length;
      unit.set(key, n === 0 ? 'both-walkable' : n === 1 ? 'one-blocked' : 'both-blocked');
      // Eligible to join (#745's sense, approximately): both sides are fill cells, so neither is a 20.6 margin.
      if ([seam.a, seam.b].every(o => (seam.byOwner.get(o) ?? []).every(s => s.fill))) eligible.add(key);
    }
    const runs: { length: number; pair: string; counts: Record<string, number>; eligible: number; flanked: number }[] = [], done = new Set<string>();
    const step = (key: string, d: number) => { const [axis, rest] = key.split(':'); const [x, y] = rest!.split(',').map(Number);
      return axis === 'h' ? `h:${x! + d},${y}` : `v:${x},${y! + d}`; };
    for (const key of [...seams.keys()].sort()) {
      if (done.has(key)) continue;
      const pair = `${seams.get(key)!.a}/${seams.get(key)!.b}`;
      let start = key; while (seams.has(step(start, -1)) && `${seams.get(step(start, -1))!.a}/${seams.get(step(start, -1))!.b}` === pair) start = step(start, -1);
      const members: string[] = [];
      for (let k = start; seams.has(k) && `${seams.get(k)!.a}/${seams.get(k)!.b}` === pair && !done.has(k); k = step(k, 1)) { members.push(k); done.add(k); }
      const counts: Record<string, number> = { 'both-walkable': 0, 'one-blocked': 0, 'both-blocked': 0 };
      for (const k of members) counts[unit.get(k)!]!++;
      // Ends flanked by a guaranteed run on the same line, whose 20.6 end cap clears the end cell on both sides.
      const flanked = (guaranteed.has(step(members[0]!, -1)) ? 1 : 0) + (guaranteed.has(step(members.at(-1)!, 1)) ? 1 : 0);
      runs.push({ length: members.length, pair, counts, eligible: members.filter(k => eligible.has(k)).length, flanked });
    }
    const units = { 'both-walkable': 0, 'one-blocked': 0, 'both-blocked': 0 } as Record<string, number>;
    for (const v of unit.values()) units[v]!++;
    const hist = (lengths: number[]) => { const h: Record<string, number> = {}; for (const l of lengths) { const b = l >= 6 ? '6+' : String(l); h[b] = (h[b] ?? 0) + 1; } return h; };
    // Eligible stretches: maximal runs of consecutive eligible units inside a run.
    const eligibleLengths: number[] = [];
    for (const key of [...eligible].sort()) if (!eligible.has(step(key, -1)) || seams.get(step(key, -1))!.a !== seams.get(key)!.a || seams.get(step(key, -1))!.b !== seams.get(key)!.b) {
      let n = 0; for (let k = key; eligible.has(k) && seams.get(k)!.a === seams.get(key)!.a && seams.get(k)!.b === seams.get(key)!.b; k = step(k, 1)) n++;
      eligibleLengths.push(n);
    }
    return [body, { units: unit.size, unitClasses: units, eligibleUnits: eligible.size, runs: runs.length,
      runLengths: hist(runs.map(r => r.length)), eligibleStretchLengths: hist(eligibleLengths),
      runsWithBothBlockedUnit: runs.filter(r => r.counts['both-blocked']! > 0).length,
      runsAllBothWalkable: runs.filter(r => r.counts['both-walkable'] === r.length).length,
      unitsByRunLength: Object.fromEntries(['1', '2', '3', '4', '5', '6+'].map(b => [b, runs.filter(r => (r.length >= 6 ? '6+' : String(r.length)) === b).reduce((n, r) => n + r.length, 0)])),
      runsByFlankedEnds: [0, 1, 2].map(f => runs.filter(r => r.flanked === f).length),
      threeCellRunsFlankedBoth: runs.filter(r => r.length === 3 && r.flanked === 2).length }];
  }));

  const tally = (list: Sample[], body: Body) => {
    const t = { samples: list.length, blocked: 0, ownBlocked: 0, otherOnlyBlocked: 0, walkable: 0, why: { cap: 0, strip: 0, empty: 0, setback: 0, near: 0 } as Record<Why, number> };
    for (const s of list) { const r = s.result[body];
      if (r.blocked) { t.blocked++; if (r.own) t.ownBlocked++; else if (r.other) t.otherOnlyBlocked++; }
      else { t.walkable++; if (r.why) t.why[r.why]++; } }
    return t;
  };
  const group = <K extends string>(list: Sample[], keyOf: (s: Sample) => K) => {
    const m = new Map<K, Sample[]>(); for (const s of list) { const k = keyOf(s); if (!m.has(k)) m.set(k, []); m.get(k)!.push(s); }
    return [...m].sort(([a], [b]) => a < b ? -1 : 1);
  };
  const unguaranteed = samples.filter(s => s.cls === 'unguaranteed');
  // #762: internal guaranteed runs and the owned cells their 20.6 footprint clears (end caps included).
  const internal = new Map<string, { regions: number; withRuns: number; runs: number; runLength: number; cells: number; fillCells: number; internalClear: number }>();
  for (const r of built.regions) {
    const t = internal.get(r.brief.type) ?? { regions: 0, withRuns: 0, runs: 0, runLength: 0, cells: 0, fillCells: 0, internalClear: 0 };
    internal.set(r.brief.type, t);
    const runs = r.brief.internalGuaranteed ?? [], owned = new Set(r.brief.cells.map(c => `${c.x},${c.y}`)), cleared = new Set<string>();
    for (const run of runs) for (let i = -1; i <= run.length; i++) for (const j of [-1, 0]) {
      const k = run.axis === 'h' ? `${run.x + i},${run.y + j}` : `${run.x + j},${run.y + i}`; if (owned.has(k)) cleared.add(k);
    }
    t.regions++; t.cells += r.brief.cells.length; t.fillCells += (r.brief.fillCells ?? r.brief.cells).length;
    if (runs.length) { t.withRuns++; t.runs += runs.length; t.runLength += runs.reduce((n, x) => n + x.length, 0); t.internalClear += cleared.size; }
  }
  return {
    seed: map.layout.seed, cellSize: size, regions: built.regions.length,
    byClass: Object.fromEntries(bodies.map(({ body }) => [body, Object.fromEntries(group(samples, s => s.cls).map(([k, l]) => [k, tally(l, body)]))])),
    all: Object.fromEntries(bodies.map(({ body }) => [body, tally(samples, body)])),
    unguaranteedByType: Object.fromEntries(bodies.map(({ body }) => [body, Object.fromEntries(group(unguaranteed, s => s.type).map(([k, l]) => [k, {
      ...tally(l, body), hinted: tally(l.filter(s => s.hinted), body), unhinted: tally(l.filter(s => !s.hinted), body) }]))])),
    edgeByType: Object.fromEntries(bodies.map(({ body }) => [body, Object.fromEntries(group(samples.filter(s => s.cls === 'edge'), s => s.type).map(([k, l]) => [k, {
      ...tally(l, body), hinted: tally(l.filter(s => s.hinted), body) }]))])),
    hintedShare: { unguaranteed: unguaranteed.filter(s => s.hinted).length / unguaranteed.length,
      mutual: unguaranteed.filter(s => s.hinted === 'mutual').length, oneSided: unguaranteed.filter(s => s.hinted === 'one-sided').length },
    seams: seamSummary,
    internalGuaranteedByType: Object.fromEntries([...internal].sort(([a], [b]) => a < b ? -1 : 1)),
  };
}

const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const reports = [];
for (const width of widths) for (const n of seeds) {
  const seed = `size-${width}-${n}`;
  let map: ToolMap, source: string;
  const saved = mapsDir && [`${mapsDir}/${seed}.json`, `${mapsDir}/${seed}.json.gz`].find(existsSync);
  if (saved) {
    const raw = readFileSync(saved), text = (saved.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
    map = readMap(JSON.parse(text)); source = `saved ${saved} ${hash(text)}`;
  } else {
    const t0 = performance.now();
    map = generate(seed, { zoneWidth: width, zoneHeight: width / 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: .04, lootTierStep: .09 }, undefined, 48);
    source = `generated ${hash(chainMapToJson(map))}`;
    console.error(`${seed}: generated in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  reports.push({ source, ...measure(map) });
  console.error(`${seed}: measured`);
}
const report = { version: 'edge-clearance-1', definitions: 'docs/51.10-measurement.md', results: 'docs/42.34-edge-clearance.md', revision: git('rev-parse', 'HEAD'), node: process.version, maps: reports };
if (out) writeFileSync(out, JSON.stringify(report, null, 1) + '\n'); else console.log(JSON.stringify(report, null, 1));
