// #575: compare checkpoint content on identical current-library briefs against a pinned strategy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { buildCheckpoint } from '../map/micro/strategies/checkpoint.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { measureFill } from '../map/micro/fill.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { cellsOf } from '../tests/helpers/cells.js';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['out', 'baseline-ref'], arg => `Unknown option ${arg}`);
const baselineRef = args.get('baseline-ref') ?? 'f775fe7';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const baselineCommit = git('rev-parse', `${baselineRef}^{commit}`);
const sourcePath = 'map/micro/strategies/checkpoint.ts';
const oldSource = git('show', `${baselineCommit}:${sourcePath}`);
// Only the checkpoint strategy is historical: all shared geometry/placeables and library inputs
// are current, deliberately isolating this adoption from intervening library changes.
const scratchRoot = resolve('test-results');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'checkpoint-infill-audit-'));
const baselineFile = resolve(scratch, 'baseline.ts');
await writeFile(baselineFile, oldSource.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
  (_, start, relative, end) => `${start}${pathToFileURL(resolve(dirname(sourcePath), relative)).href}${end}`));

try {
  const beforeBuild = (await import(pathToFileURL(baselineFile).href)).buildCheckpoint;
  function inspect(brief, built) {
    const blockers = built.elements.flatMap(e => elementShapes(e));
    const fill = measureFill(brief, built.elements);
    const errors = [...validateFillConstraints(brief, built.elements.flatMap(e => elementShapes(e, true))),
      ...validatePortalReach({ ...brief, blockers }).errors];
    const root = portalStands(brief)[0]?.points[0];
    let doorsChecked = 0;
    const unreachableDoors = [];
    if (root) for (const element of built.elements.filter(e => e.label.startsWith('checkpoint-post'))) {
      for (const gate of element.template.parts.filter(p => p.part === 'gate')) {
        const point = { x: element.x + gate.x, y: element.y + gate.y };
        if (!findRegionRoute(createAccessMask(brief), blockers, root, point, hunterClearance(brief.cellSize)))
          unreachableDoors.push(`${element.label}: no hunter route to door at ${point.x},${point.y}`);
        doorsChecked++;
      }
    }
    return { elements: built.elements.length, crates: built.manifest.infillCrates ?? 0,
      posts: built.manifest.posts ?? 0, barriers: built.manifest.barriers ?? 0,
      loot: built.loot.length, cells: fill.cells, freeCells: fill.freeCells, doorsChecked, unreachableDoors, errors };
  }
  function compare(brief) {
    const beforeTraces = [], afterTraces = [];
    const before = beforeBuild(brief, trace => beforeTraces.push(trace));
    const after = buildCheckpoint(brief, trace => afterTraces.push(trace));
    assert.deepEqual(after.elements.filter(e => !e.label.startsWith('checkpoint-infill-')), before.elements, `${brief.id}: primary elements`);
    assert.deepEqual(afterTraces, beforeTraces, `${brief.id}: building traces`);
    for (const crate of after.elements.filter(e => e.label.startsWith('checkpoint-infill-'))) {
      const a = { x: crate.x, y: crate.y, w: crate.template.w, h: crate.template.h };
      for (const other of after.elements) if (other !== crate) {
        const b = { x: other.x, y: other.y, w: other.template.w, h: other.template.h };
        assert.ok(Math.max(b.x - a.x - a.w, a.x - b.x - b.w,
          b.y - a.y - a.h, a.y - b.y - b.h) > 2 * brief.cellSize - 1e-7,
        `${brief.id}: ${crate.label} keeps two-cell spacing from ${other.label}`);
      }
    }
    const oldCheck = inspect(brief, before), newCheck = inspect(brief, after);
    assert.deepEqual(newCheck.unreachableDoors, oldCheck.unreachableDoors, `${brief.id}: post door access`);
    return { id: brief.id, before: oldCheck, after: newCheck };
  }
  const maps = [];
  for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
    const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
    const views = mapViews(generate(seed, { mode: 'game', zoneWidth, zoneHeight }), GAME_ENGINES.compose);
    const rows = views.briefs.filter(b => b.type === 'checkpoint').map(compare);
    maps.push({ seed, zoneWidth, zoneHeight, rows, mapErrors: views.report.defects });
    console.log(JSON.stringify({ seed, regions: rows.length, crates: rows.reduce((n, r) => n + r.after.crates, 0),
      errors: [...views.report.defects, ...rows.flatMap(r => [...r.before.errors, ...r.after.errors])] }));
  }
  const cells = Array.from({ length: 24 * 18 }, (_, n) => ({ x: n % 24, y: Math.floor(n / 24) }));
  const direct = Array.from({ length: 10 }, (_, n) => compare({ id: `checkpoint-${n + 1}`, seed: n + 1, type: 'checkpoint', cellSize: 40,
    cells, zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 8, length: 2 }, { id: 'east', axis: 'v', x: 24, y: 8, length: 2 }] }));
  const variants = [];
  for (const [name, cells, portals] of [
    ['ell', cellsOf(30, 30, (x, y) => y < 12 || x < 12), [
      { id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 }]],
    ['one', cellsOf(20, 16), [{ id: 'west', axis: 'v', x: 0, y: 6, length: 3 }]],
    ['none', cellsOf(20, 16), []],
    ['narrow', cellsOf(24, 3), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 0, length: 3 }]],
  ]) for (let seed = 1; seed <= 5; seed++) variants.push(compare({ id: `${name}-${seed}`, seed,
    type: 'checkpoint', cellSize: 40, cells, portals, zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }] }));
  const sourceHashes = Object.fromEntries(await Promise.all([sourcePath, 'tools/checkpoint-infill-audit.mjs',
    'map/micro/canvas.ts', 'map/micro/strategies/scatter.ts', 'map/micro/placeables/cover-piece.ts', 'map/micro/region-types.ts']
    .map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  const report = { audit: 'checkpoint-side-yard-infill-1', baselineCommit, commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--', sourcePath, 'map/micro/region-types.ts'),
    createdAt: new Date().toISOString(), node: process.version, contentVersion: REGION_TYPES_VERSION, sourceHashes,
    maps, direct, variants, limits: 'One current-library map per authored size, ten direct 24x18 cases and twenty concave/one-portal/portalless/narrow cases. Historical checkpoint module with current shared dependencies. Exact primary elements/traces, two-cell spacing, fill/margins, portal promises and unchanged reachability of every post door from the first portal checked before/after. Pre-existing inaccessible door targets are recorded separately; portalless door reach is not checked. No delegation acceptance rate: this is direct canvas infill. Human balance and exhaustive coverage unverified.' };
  const out = resolve(args.get('out') ?? 'test-results/575/checkpoint.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  if (maps.some(m => m.mapErrors.length || m.rows.some(r => r.before.errors.length || r.after.errors.length))
    || [...direct, ...variants].some(r => r.before.errors.length || r.after.errors.length)) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
