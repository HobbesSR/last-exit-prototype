// Materialize the isolated variant in an already archived prototype snapshot.
import fs from 'node:fs';
import path from 'node:path';
const [directory] = process.argv.slice(2);
if(!directory) throw Error('Usage: node docs/reports/issue-723/prepare.mjs SNAPSHOTS');
const file=path.join(directory,'batch/map/micro/geometry.ts');
let prototype=fs.readFileSync(path.join(directory,'control/map/micro/geometry.ts'),'utf8');
const current=fs.readFileSync('map/micro/geometry.ts','utf8');
const start=current.indexOf('export function findRegionRoute');
if(start<0) throw Error('Expected exported reusable search');
const helperStart=current.indexOf('export function routeStarts');
const helperEnd=current.indexOf('/**',helperStart);
let implementation=current.slice(helperStart,helperEnd)+current.slice(start);
// The prototype already has a spatial broad phase; retain it identically.
implementation=implementation.replaceAll('radius: number)', 'radius: number, query?: ShapeQuery)');
implementation=implementation.replace(/travelClear\(mask, blockers, ([^;\n]*?), radius\)/g,'travelClear(mask, blockers, $1, radius, query)');
implementation=implementation.replaceAll('createRegionRouteSearch(mask, blockers, a, radius)', 'createRegionRouteSearch(mask, blockers, a, radius, query)');
const oldStart=prototype.indexOf('export function findRegionRoute');
prototype=prototype.slice(0,oldStart)+implementation;
fs.writeFileSync(file,prototype);
const guardFile=path.join(directory,'batch/map/micro/strategies/content-access.ts');
let guard=fs.readFileSync(path.join(directory,'control/map/micro/strategies/content-access.ts'),'utf8').replace('createAccessMask, findRegionRoute,','createAccessMask, createRegionRouteSearch, findRegionRoute,');
// Each adapter is confined to one immutable collision prefix/trial. Nothing is
// cached across prepare/commit, rejected trials or caller mutations.
const adapter=`  const sharedRoutes = (shapes: readonly Shape[], query?: ShapeQuery) => {
    const searches = new Map<string, ReturnType<typeof createRegionRouteSearch>>();
    return (a: Vec2, b: Vec2) => {
      const id = key(a);
      let search = searches.get(id);
      if (!search) { search = createRegionRouteSearch(mask, shapes, a, radius, query); searches.set(id, search); }
      return search(b);
    };
  };
`;
guard=guard.replace('  const targetPaths =',adapter+'  const targetPaths =');
guard=guard.replace('    const paths: Evidence[] = [];','    const paths: Evidence[] = [];\n    const routeTo = sharedRoutes(shapes, query);');
guard=guard.replace('findRegionRoute(mask, shapes, root, point, radius, query)','routeTo(root, point)');
guard=guard.replace('      const nextProof: Evidence[] = [];','      const nextProof: Evidence[] = [];\n      const routeTo = sharedRoutes(nextBlockers, query);');
guard=guard.replace('findRegionRoute(mask, nextBlockers, path.a, path.b, radius, query)','routeTo(path.a, path.b)');
fs.writeFileSync(guardFile,guard);
console.log('Prepared isolated batch snapshot; original control untouched.');
