// #570: compare depot content on identical current-library briefs against a pinned strategy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { buildDepot } from '../map/micro/strategies/depot.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { measureFill } from '../map/micro/fill.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['out', 'baseline-ref'], arg => `Unknown option ${arg}`);
const baselineRef = args.get('baseline-ref') ?? 'e81a499';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const baselineCommit = git('rev-parse', `${baselineRef}^{commit}`);
const sourcePath = 'map/micro/strategies/depot.ts';
const oldSource = git('show', `${baselineCommit}:${sourcePath}`);
// Only the depot strategy is historical: all shared geometry/placeables and library inputs
// are current, deliberately isolating this adoption from intervening library changes.
const scratchRoot = resolve('test-results');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'depot-infill-audit-'));
const baselineFile = resolve(scratch, 'baseline.ts');
await writeFile(baselineFile, oldSource.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
  (_, start, relative, end) => `${start}${pathToFileURL(resolve(dirname(sourcePath), relative)).href}${end}`));

try {
  const beforeBuild = (await import(pathToFileURL(baselineFile).href)).buildDepot;
  function inspect(brief, built) {
    const blockers = built.elements.flatMap(e => elementShapes(e));
    const fill = measureFill(brief, built.elements);
    const errors = [...validateFillConstraints(brief, built.elements.flatMap(e => elementShapes(e, true))),
      ...validatePortalReach({ ...brief, blockers }).errors];
    const root = portalStands(brief)[0]?.points[0];
    let doorsChecked = 0;
    const unreachableDoors = [];
    if (root) for (const element of built.elements.filter(e => e.label.startsWith('depot-warehouse'))) {
      for (const gate of element.template.parts.filter(p => p.part === 'gate')) {
        const point = { x: element.x + gate.x, y: element.y + gate.y };
        if (!findRegionRoute(createAccessMask(brief), blockers, root, point, hunterClearance(brief.cellSize)))
          unreachableDoors.push(`${element.label}: no hunter route to door at ${point.x},${point.y}`);
        doorsChecked++;
      }
    }
    return { elements: built.elements.length, crates: built.manifest.infillCrates ?? 0,
      warehouses: built.manifest.warehouses ?? 0, rows: built.manifest.rows ?? 0,
      loot: built.loot.length, cells: fill.cells, freeCells: fill.freeCells, doorsChecked, unreachableDoors, errors };
  }
  function compare(brief) {
    const beforeTraces = [], afterTraces = [];
    const before = beforeBuild(brief, trace => beforeTraces.push(trace));
    const after = buildDepot(brief, trace => afterTraces.push(trace));
    assert.deepEqual(after.elements.filter(e => !e.label.startsWith('depot-infill-')), before.elements, `${brief.id}: primary elements`);
    assert.deepEqual(afterTraces, beforeTraces, `${brief.id}: building traces`);
    const oldCheck = inspect(brief, before), newCheck = inspect(brief, after);
    assert.deepEqual(newCheck.unreachableDoors, oldCheck.unreachableDoors, `${brief.id}: warehouse door access`);
    return { id: brief.id, before: oldCheck, after: newCheck };
  }
  const maps = [];
  for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
    const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
    const views = mapViews(generate(seed, { mode: 'game', zoneWidth, zoneHeight }), GAME_ENGINES.compose);
    const rows = views.briefs.filter(b => b.type === 'depot').map(compare);
    maps.push({ seed, zoneWidth, zoneHeight, rows, mapErrors: views.report.defects });
    console.log(JSON.stringify({ seed, regions: rows.length, crates: rows.reduce((n, r) => n + r.after.crates, 0),
      errors: [...views.report.defects, ...rows.flatMap(r => [...r.before.errors, ...r.after.errors])] }));
  }
  const cells = Array.from({ length: 24 * 18 }, (_, n) => ({ x: n % 24, y: Math.floor(n / 24) }));
  const direct = Array.from({ length: 10 }, (_, n) => compare({ id: `depot-${n + 1}`, seed: n + 1, type: 'depot', cellSize: 40,
    cells, zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 8, length: 2 }, { id: 'east', axis: 'v', x: 24, y: 8, length: 2 }] }));
  const sourceHashes = Object.fromEntries(await Promise.all([sourcePath, 'tools/depot-infill-audit.mjs',
    'map/micro/canvas.ts', 'map/micro/strategies/scatter.ts', 'map/micro/placeables/cover-piece.ts', 'map/micro/region-types.ts']
    .map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  const report = { audit: 'depot-lane-infill-1', baselineCommit, commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--', sourcePath, 'map/micro/region-types.ts'),
    createdAt: new Date().toISOString(), node: process.version, contentVersion: REGION_TYPES_VERSION, sourceHashes,
    maps, direct, limits: 'One current-library map per authored size and ten direct 24x18 cases. Historical depot module with current shared dependencies. Exact primary elements/traces, fill/margins, portal promises and unchanged reachability of every warehouse door checked before/after. Some direct-fixture doors at ownership boundaries are already unreachable before infill; they are recorded separately and must remain identical. No delegation acceptance rate: this is direct canvas infill. Human balance and exhaustive coverage unverified.' };
  const out = resolve(args.get('out') ?? 'test-results/570/depot.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  if (maps.some(m => m.mapErrors.length || m.rows.some(r => r.before.errors.length || r.after.errors.length))
    || direct.some(r => r.before.errors.length || r.after.errors.length)) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
