// Input control is the published #723 batch snapshot, built with its prepare.mjs.
import fs from 'node:fs';
import path from 'node:path';
const [directory] = process.argv.slice(2);
if (!directory) throw Error('Usage: node docs/reports/issue-724/prepare.mjs SNAPSHOTS');
const read = f => fs.readFileSync(path.join(directory, 'control', f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(directory, 'batch', f), s);
let geometry = read('map/micro/geometry.ts');
const current = fs.readFileSync('map/micro/geometry.ts', 'utf8');
let search = current.slice(current.indexOf('export function createRegionRouteSearch'));
search = search.replace('radius: number,', 'radius: number, query?: ShapeQuery,');
search = search.replace('travelClear(mask, blockers, from, to, radius)', 'travelClear(mask, blockers, from, to, radius, query)');
geometry = geometry.slice(0, geometry.indexOf('export function createRegionRouteSearch')) + search;
write('map/micro/geometry.ts', geometry);
write('map/micro/route-clearance.ts', fs.readFileSync('map/micro/route-clearance.ts', 'utf8'));
let guard = read('map/micro/strategies/content-access.ts');
const replace = (from, to) => {
  if (!guard.includes(from)) throw Error(`Missing adapter anchor: ${from}`);
  guard = guard.replace(from, to);
};
replace("import { hunterClearance", "import { createRouteClearance } from '../route-clearance.ts';\nimport { hunterClearance");
replace('  const index =', '  const clearance = createRouteClearance(mask, blockers, radius);\n  const index =');
replace('findRegionRoute(mask, blockers, a, b, radius) ??', 'createRegionRouteSearch(mask, blockers, a, radius, undefined, clearance.accepted())(b) ??');
replace('createRegionRouteSearch, findRegionRoute,', 'createRegionRouteSearch,');
replace('const sharedRoutes = (shapes: readonly Shape[], query?: ShapeQuery)',
  'const sharedRoutes = (shapes: readonly Shape[], query?: ShapeQuery, cachedClear = clearance.accepted())');
replace('createRegionRouteSearch(mask, shapes, a, radius, query)', 'createRegionRouteSearch(mask, shapes, a, radius, query, cachedClear)');
replace('const targetPaths = (points: readonly Vec2[], shapes: readonly Shape[], query?: ShapeQuery)',
  'const targetPaths = (points: readonly Vec2[], shapes: readonly Shape[], query?: ShapeQuery, cachedClear = clearance.accepted())');
replace('const routeTo = sharedRoutes(shapes, query)', 'const routeTo = sharedRoutes(shapes, query, cachedClear)');
replace('      const nextProof: Evidence[] = [];', '      const trial = clearance.prepare(added);\n      const nextProof: Evidence[] = [];');
replace('sharedRoutes(nextBlockers, query)', 'sharedRoutes(nextBlockers, query, trial.clear)');
replace('targetPaths(newTargets, nextBlockers, query)', 'targetPaths(newTargets, nextBlockers, query, trial.clear)');
replace('        index.add(added);', '        trial.commit();\n        index.add(added);');
write('map/micro/strategies/content-access.ts', guard);
console.log('Prepared #724 cache variant; #723 control unchanged.');
