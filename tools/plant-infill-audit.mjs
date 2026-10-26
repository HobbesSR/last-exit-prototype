// #577: compare plant residual infill on identical current-library briefs against a pinned strategy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { buildPlant } from '../map/micro/strategies/plant.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { measureFill } from '../map/micro/fill.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['out', 'baseline-ref'], arg => `Unknown option ${arg}`);
const baselineRef = args.get('baseline-ref') ?? 'f775fe7';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const baselineCommit = git('rev-parse', `${baselineRef}^{commit}`);
const sourcePath = 'map/micro/strategies/plant.ts';
const oldSource = git('show', `${baselineCommit}:${sourcePath}`);
// Pin only the strategy; current geometry, placeables and authored library stay shared.
const scratchRoot = resolve('test-results');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'plant-infill-audit-'));
const baselineFile = resolve(scratch, 'baseline.ts');
await writeFile(baselineFile, oldSource.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
  (_, start, relative, end) => `${start}${pathToFileURL(resolve(dirname(sourcePath), relative)).href}${end}`));

const cellSize = 40;
const cellsOf = (w, h, include = () => true) => Array.from({ length: w * h }, (_, n) => ({ x: n % w, y: Math.floor(n / w) }))
  .filter(cell => include(cell.x, cell.y));
const brief = (id, seed, w, h, include, portals, parameters = { density: 0.6, shed: 0.5 }) => {
  const cells = cellsOf(w, h, include);
  return { id, seed, type: 'plant', cellSize, cells, zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }], portals, parameters };
};
const rectPortals = (w, h) => [
  { id: 'west', axis: 'v', x: 0, y: Math.floor(h / 2) - 1, length: 2 },
  { id: 'east', axis: 'v', x: w, y: Math.floor(h / 2) - 1, length: 2 },
];

try {
  const beforeBuild = (await import(pathToFileURL(baselineFile).href)).buildPlant;
  function inspect(input, built) {
    const blockers = built.elements.flatMap(element => elementShapes(element));
    const fill = measureFill(input, built.elements);
    const errors = {
      fill: validateFillConstraints(input, built.elements.flatMap(element => elementShapes(element, true))),
      portal: validatePortalReach({ ...input, blockers }).errors,
    };
    const root = portalStands(input)[0]?.points[0];
    const unreachableDoors = [];
    let doorsChecked = 0;
    if (root) for (const element of built.elements.filter(e => e.label.startsWith('plant-shed-'))) {
      for (const gate of element.template.parts.filter(part => part.part === 'gate')) {
        const point = { x: element.x + gate.x, y: element.y + gate.y };
        const target = `${element.label}: ${point.x},${point.y}`;
        if (!findRegionRoute(createAccessMask(input), blockers, root, point, hunterClearance(input.cellSize))) unreachableDoors.push(target);
        doorsChecked++;
      }
    }
    const byPrefix = prefix => built.elements.filter(element => element.label.startsWith(prefix)).length;
    return { elements: built.elements.length, infillCrates: built.manifest.infillCrates ?? 0,
      machines: built.manifest.machines ?? byPrefix('plant-machine-'), pipes: built.manifest.pipes ?? byPrefix('plant-pipe-'),
      sheds: built.manifest.sheds ?? byPrefix('plant-shed-'), loot: built.loot.length,
      cells: fill.cells, freeCells: fill.freeCells, doorsChecked, unreachableDoors, errors };
  }
  function compare(input) {
    const beforeTraces = [], afterTraces = [];
    const before = beforeBuild(input, trace => beforeTraces.push(trace));
    const after = buildPlant(input, trace => afterTraces.push(trace));
    assert.deepEqual(after.elements.filter(element => !element.label.startsWith('plant-infill-')), before.elements,
      `${input.id}: primary elements`);
    assert.deepEqual(afterTraces, beforeTraces, `${input.id}: building traces`);
    const oldCheck = inspect(input, before), newCheck = inspect(input, after);
    const newlyUnreachableDoors = newCheck.unreachableDoors.filter(target => !oldCheck.unreachableDoors.includes(target));
    const recoveredDoors = oldCheck.unreachableDoors.filter(target => !newCheck.unreachableDoors.includes(target));
    const newErrors = Object.fromEntries(Object.keys(oldCheck.errors).map(kind => [kind,
      newCheck.errors[kind].filter(error => !oldCheck.errors[kind].includes(error))]));
    return { id: input.id, before: oldCheck, after: newCheck, newlyUnreachableDoors, recoveredDoors, newErrors };
  }

  const maps = [];
  for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
    const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
    const views = mapViews(generate(seed, { mode: 'game', zoneWidth, zoneHeight }), GAME_ENGINES.compose);
    const rows = views.briefs.filter(input => input.type === 'plant').map(compare);
    maps.push({ seed, zoneWidth, zoneHeight, rows, mapErrors: views.report.defects });
    console.log(JSON.stringify({ seed, regions: rows.length,
      crates: rows.reduce((n, row) => n + row.after.infillCrates, 0),
      newErrors: rows.flatMap(row => Object.values(row.newErrors).flat()).length }));
  }

  const direct = [];
  for (let seed = 1; seed <= 10; seed++) direct.push(compare(brief(`plant-rect-${seed}`, seed, 24, 18,
    () => true, rectPortals(24, 18))));
  const varied = [
    ['L', 30, 30, (x, y) => y < 15 || x < 15],
    ['ring', 36, 36, (x, y) => x < 13 || x >= 23 || y < 13 || y >= 23],
    ['notched', 32, 24, (x, y) => !(x >= 12 && x < 20 && y >= 8 && y < 24)],
    ['thin', 10, 24, () => true],
  ];
  for (const [name, w, h, include] of varied) for (const seed of [17, 29, 43])
    direct.push(compare(brief(`plant-${name}-${seed}`, seed, w, h, include, rectPortals(w, h))));
  direct.push(compare(brief('plant-density-zero', 83, 24, 18, () => true, rectPortals(24, 18), { density: 0, shed: 0 })));

  // Exercise the established >32-portal bounded boundary policy without a large world.
  const many = [];
  for (let x = 1; x < 70; x += 2) many.push({ id: `north-${x}`, axis: 'h', x, y: 0, length: 1 });
  many.push({ id: 'south', axis: 'h', x: 34, y: 24, length: 2 });
  direct.push(compare(brief('plant-many-portals', 71, 72, 24, () => true, many)));

  const sourcePaths = [sourcePath, 'tools/plant-infill-audit.mjs', 'map/micro/canvas.ts',
    'map/micro/strategies/scatter.ts', 'map/micro/placeables/cover-piece.ts', 'map/micro/region-types.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
    [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  const report = { audit: 'plant-residual-infill-1', baselineRef, baselineCommit, commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--', sourcePath, 'map/micro/region-types.ts'),
    createdAt: new Date().toISOString(), node: process.version, contentVersion: REGION_TYPES_VERSION,
    sourceHashes, maps, direct,
    limits: 'Baseline strategy is pinned while shared current library, geometry and placeables are used on both sides. Three current-library authored maps, ten direct 24x18 cases, twelve varied-shape cases and one >32-portal case. Checks exact primary geometry and building traces, fill constraints, portal reach, and unchanged/unlost shed-door reachability. Pre-existing errors and inaccessible doors are recorded separately from regressions. No claim of human balance, exhaustive coverage or performance beyond these samples.' };
  const out = resolve(args.get('out') ?? 'test-results/577/plant.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  const rows = [...maps.flatMap(map => map.rows), ...direct];
  const newIssues = rows.flatMap(row => [...Object.values(row.newErrors).flat(), ...row.newlyUnreachableDoors]);
  if (newIssues.length) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
