#!/usr/bin/env node
/** #761 measurement only. Fixed-layout counterfactuals; never writes a library or map.
 * node map/tools/seam-pitch-probe.mts --out docs/reports/issue-761/seam-pitch.json
 * Optional: --widths 12,24,36 --seeds 1 --replace. See the retained report's README.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateMacro } from './core.ts';
import { mapViews } from '../macro/src/chain/map.ts';
import { regions, portalViolations } from '../macro/src/chain/regions.ts';
import { proof, proofViolations } from '../macro/src/chain/proof.ts';
import type { ChainLibrary } from '../macro/src/chain/library.ts';
import { clearFootprint, applyClearConstraints } from '../kernel/margins.ts';
import type { Cell } from '../kernel/cell.ts';
import type { ResolvedLayout, SegmentKey } from '../macro/src/chain/types.ts';
import { createAccessMask, findRegionRoute, travelClear } from '../micro/geometry.ts';
import { hunterClearance } from '../micro/portals.ts';
import { bounds, rect } from '../../shared/shape.ts';
import { moveBody, canOccupy } from '../../shared/movement.ts';
import type { CollisionMap, ObstacleId } from '../../shared/types.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1]!.startsWith('--')) throw new Error(`${name} requires a value`);
  return process.argv[i + 1]!;
};
const widths = arg('--widths', '12,24,36').split(',').map(Number);
const seeds = arg('--seeds', '1').split(',').map(Number);
assert.ok(widths.length && widths.every(w => [12, 24, 36].includes(w)));
assert.ok(seeds.length && seeds.every(n => Number.isSafeInteger(n) && n > 0));
const out = arg('--out', '');
if (out && existsSync(out) && !process.argv.includes('--replace')) throw new Error(`${out} exists; pass --replace`);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const keyCell = (c: Cell) => `${c.x},${c.y}`;
const parse = (k: SegmentKey) => { const [axis, rest] = k.split(':'); const [x, y] = rest!.split(',').map(Number); return { axis: axis as 'h' | 'v', x: x!, y: y! }; };
const step = (k: SegmentKey, d: number): SegmentKey => { const { axis, x, y } = parse(k); return axis === 'h' ? `h:${x + d},${y}` : `v:${x},${y + d}`; };
const segmentCells = (k: SegmentKey): Cell[] => { const { axis, x, y } = parse(k); return axis === 'h' ? [{ x, y: y - 1 }, { x, y }] : [{ x: x - 1, y }, { x, y }]; };
const guaranteed = (r: ResolvedLayout) => new Set((Object.keys(r.segments) as SegmentKey[]).filter(k => r.segments[k]!.guarantee === 'guaranteed'));
const hinted = (r: ResolvedLayout, k: SegmentKey) => r.segments[k]?.guarantee !== 'guaranteed' && !!r.segments[k]?.stated.includes('not-passable-hint');

/** Same per-unit union as clearFootprint, except cap contributions into hinted units are omitted.
 * Perpendicular/overlapping guarantees can still clear those cells. Side strips never shrink.
 */
function footprint(r: ResolvedLayout, playable: Cell[], clipHints: boolean): Set<string> {
  const play = new Set(playable.map(keyCell)), clear = new Set<string>();
  for (const k of guaranteed(r)) for (const d of [-1, 0, 1]) {
    if (clipHints && d && hinted(r, step(k, d))) continue;
    for (const c of segmentCells(step(k, d))) if (play.has(keyCell(c))) clear.add(keyCell(c));
  }
  if (!clipHints) assert.deepEqual([...clear].sort(), clearFootprint([...guaranteed(r)].map(k => ({ ...parse(k), length: 1 })), playable).map(keyCell).sort());
  return clear;
}

/** Remove all guaranteed halves on selected physical 6-cell tile sides, from both owners.
 * A horizontal side uses tile-row y/6 and tile-column floor(x/6); vertical swaps axes.
 * The parity is (normal tile-line index + along-side tile index) modulo 2.
 * Interiors of tiles remain unchanged. Complementary phases expose spatial bias.
 */
function thin(r: ResolvedLayout, phase: number): { resolved: ResolvedLayout; removedUnits: number; removedTileSides: number } {
  const result = structuredClone(r), sides = new Set<string>(); let removedUnits = 0;
  for (const k of guaranteed(r)) {
    const { axis, x, y } = parse(k), normal = axis === 'h' ? y : x, along = axis === 'h' ? x : y;
    if (normal % 6 || (normal / 6 + Math.floor(along / 6)) % 2 !== phase) continue;
    result.segments[k] = { guarantee: 'none', stated: ['not-passable-hint', 'not-passable-hint'] };
    sides.add(`${axis}:${normal},${Math.floor(along / 6)}`); removedUnits++;
  }
  return { resolved: result, removedUnits, removedTileSides: sides.size };
}

function lengths(units: Map<SegmentKey, string>) {
  const found: number[] = [];
  for (const [k, pair] of units) if (units.get(step(k, -1)) !== pair) {
    let n = 0; for (let s = k; units.get(s) === pair; s = step(s, 1)) n++;
    found.push(n);
  }
  return { units: units.size, runs: found.length,
    unitsInRuns6Plus: found.filter(n => n >= 6).reduce((a, b) => a + b, 0),
    shareInRuns6Plus: units.size ? found.filter(n => n >= 6).reduce((a, b) => a + b, 0) / units.size : 0,
    histogram: Object.fromEntries([...new Set(found)].sort((a, b) => a - b).map(n => [n, found.filter(v => v === n).length])) };
}

function measure(r: ResolvedLayout, seed: string, playable: Cell[], clipHints: boolean, library: ChainLibrary) {
  const found = regions(r, seed), clear = footprint(r, playable, clipHints), guarantees = guaranteed(r);
  const unguaranteed = new Map<SegmentKey, string>(), fillable = new Map<SegmentKey, string>();
  let hintedUnits = 0;
  for (const { a, b, run } of found.boundaries) for (let i = 0; i < run.length; i++) {
    const k = step(`${run.axis}:${run.x},${run.y}`, i);
    if (guarantees.has(k)) continue;
    unguaranteed.set(k, `${a}/${b}`);
    if (hinted(r, k)) hintedUnits++;
    if (segmentCells(k).every(c => !clear.has(keyCell(c)))) fillable.set(k, `${a}/${b}`);
  }
  const authored = lengths(unguaranteed), fill = lengths(fillable);
  return { regions: found.regions.length, portals: found.portals.length, guaranteedUnits: guarantees.size,
    graphComponents: proof(found).components.length,
    proofViolations: proofViolations(proof(found), found, library).length,
    shortPortalViolations: portalViolations(found).length,
    clearCells: clear.size, hintedUnguaranteedUnits: hintedUnits,
    authoredUnguaranteed: authored, fillable: fill,
    fillableShareOfUnguaranteed: fill.units / authored.units,
    fillable6PlusShareOfUnguaranteed: fill.unitsInRuns6Plus / authored.units };
}

/** Existing map-passable-margins corner witness, with actual hinted cap continuation.
 * The legal filled interior blocks the shortcut; the hunter must round the outside corner.
 */
function turning(cellSize: number) {
  const cells = (x0: number, y0: number, w: number, h: number) => Array.from({ length: w * h }, (_, i) => ({ x: x0 + i % w, y: y0 + Math.floor(i / w) }));
  const owned = cells(1, 1, 6, 6), playable = cells(0, 0, 8, 8);
  const portals = [{ id: 'north', axis: 'h' as const, x: 1, y: 1, length: 6 }, { id: 'west', axis: 'v' as const, x: 1, y: 1, length: 6 }];
  const r: ResolvedLayout = { width: 8, height: 8, cells: [], segments: {} };
  for (const p of portals) for (let i = 0; i < p.length; i++) r.segments[step(`${p.axis}:${p.x},${p.y}`, i)] = { guarantee: 'guaranteed', stated: ['passable', 'passable'] };
  for (const k of ['h:0,1', 'v:1,0'] as SegmentKey[]) r.segments[k] = { guarantee: 'none', stated: ['not-passable-hint', 'not-passable-hint'] };
  const blockers = [rect(2 * cellSize, 2 * cellSize, 4 * cellSize, 4 * cellSize)];
  const radius = hunterClearance(cellSize), a = { x: 4 * cellSize, y: cellSize }, b = { x: cellSize, y: 4 * cellSize };
  const results = [];
  for (const clipHints of [false, true]) {
    const clear = footprint(r, playable, clipHints);
    const brief = { cells: owned, portals, cellSize, ...applyClearConstraints(owned, playable.filter(c => clear.has(keyCell(c)))) };
    const mask = createAccessMask(brief), route = findRegionRoute(mask, blockers, a, b, radius);
    let movementReached = false;
    if (route) {
      // Treat the exact access-mask cells as playable, with the same geometry and clearance.
      const collision = { width: 8 * cellSize, height: 8 * cellSize, gates: [], obstacles: [{ id: 'wall' as ObstacleId, kind: 'ruin-wall', ...bounds(blockers[0]!) }],
        playableArea: { cellSize, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: Array.from({ length: 8 }, (_, x) => x).filter(x => mask.has(x, y)).map(x => [x, x + 1]) })) } } as CollisionMap;
      const mover = { ...a };
      for (const goal of route.slice(1)) {
        let budget = 400;
        while (Math.hypot(goal.x - mover.x, goal.y - mover.y) > .01 && budget-- > 0) {
          const dx = goal.x - mover.x, dy = goal.y - mover.y, d = Math.hypot(dx, dy);
          moveBody(collision, mover, { x: dx / d, y: dy / d }, radius, Math.min(4, d));
          assert.ok(canOccupy(collision, mover.x, mover.y, radius));
        }
        assert.ok(budget > 0);
      }
      movementReached = Math.hypot(b.x - mover.x, b.y - mover.y) < .01;
    }
    results.push({ caps: clipHints ? 'stop-at-hints' : 'baseline', radiusCells: radius / cellSize,
      cornerCellClear: clear.has('0,0'), routeFound: !!route, movementReached,
      viaCornerSweptClear: travelClear(mask, blockers, a, { x: cellSize, y: cellSize }, radius) && travelClear(mask, blockers, { x: cellSize, y: cellSize }, b, radius) });
  }
  assert.equal(results[0]!.movementReached, true);
  assert.equal(results[1]!.routeFound, false);
  return { cellSize, diagonalPinchWidthCells: Math.SQRT2, hunterClearanceDiameterCells: 2 * radius / cellSize, results };
}

const maps = [];
for (const width of widths) for (const n of seeds) {
  const seed = `size-${width}-${n}`, params = { zoneWidth: width, zoneHeight: width / 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: .04, lootTierStep: .09 };
  const map = generateMacro(seed, params, undefined, 48), views = mapViews(map), original = JSON.stringify(views.resolved);
  const playable = views.resolved.cells.flatMap((c, i) => c ? [{ x: i % views.resolved.width, y: Math.floor(i / views.resolved.width) }] : []);
  const baseline = measure(views.resolved, seed, playable, false, map.library), clipped = measure(views.resolved, seed, playable, true, map.library);
  assert.deepEqual(baseline.authoredUnguaranteed, clipped.authoredUnguaranteed, 'caps cannot change authored run lengths');
  const baselineClear = footprint(views.resolved, playable, false);
  for (const b of views.briefs) assert.deepEqual(b.fillCells!.map(keyCell).sort(), b.cells.filter(c => !baselineClear.has(keyCell(c))).map(keyCell).sort(), 'baseline matches actual macro briefs');
  const variants = [{ id: 'baseline', removedUnits: 0, removedTileSides: 0, ...baseline }, { id: 'caps-stop-at-hints', removedUnits: 0, removedTileSides: 0, ...clipped }];
  for (const phase of [0, 1]) {
    const thinned = thin(views.resolved, phase);
    for (const clip of [false, true]) variants.push({ id: `remove-side-parity-${phase}${clip ? '-caps-stop-at-hints' : ''}`,
      removedUnits: thinned.removedUnits, removedTileSides: thinned.removedTileSides, ...measure(thinned.resolved, seed, playable, clip, map.library) });
  }
  assert.equal(JSON.stringify(views.resolved), original, 'probe leaves production views unchanged');
  maps.push({ seed, params, cellSize: map.cellSize, layoutSha256: hash(JSON.stringify(map.layout)), libraryFingerprint: map.layout.library,
    resolvedSha256: hash(original), variants });
  console.error(`${seed}: measured ${variants.length} variants`);
}
const report = { version: 'seam-pitch-probe-1', revision: git('rev-parse', 'HEAD'), node: process.version,
  sourceSha256LF: hash(readFileSync(new URL(import.meta.url), 'utf8').replaceAll('\r\n', '\n')),
  interpretation: 'Fixed layout and owners; resolved guarantees changed in memory. No re-placement, builder output, physical blockage or detour claim. Proof uses the source library spawn class.',
  turning: [turning(40), turning(48)], maps };
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); else console.log(JSON.stringify(report, null, 2));
