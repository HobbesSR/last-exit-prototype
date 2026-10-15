// Reproduce #364: node --expose-gc tools/navigation/report.mjs [output.json]
// Each case runs in a fresh process; benchmarks run sequentially under the bench lock.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { generateLiveMap } from '../../map/live.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { bakeGraph, queryGraph } from './graph.mjs';
import { speculative } from './optimistic.mjs';
import { measureWitnesses } from './witnesses.mjs';
import { gridRoute } from '../../shared/map/route.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const measure = fn => { const start=performance.now(); const value=fn(); return {ms:performance.now()-start,value}; };
const compact = result => ({status:result.status,length:Number.isFinite(result.length)?result.length:null,expansions:result.expansions,privateBytes:result.privateBytes,localSearches:result.localSearches,localExpansions:result.localExpansions,cacheBytes:result.cacheBytes});
const memory = () => ({...process.memoryUsage(),maxRssBytes:process.resourceUsage().maxRSS*1024});
function legacy(map,role,from,to,clear) {
  const x=Math.max(0,Math.floor((Math.min(from.x,to.x)-600)/40)), y=Math.max(0,Math.floor((Math.min(from.y,to.y)-600)/40));
  const width=Math.min(Math.ceil((Math.max(from.x,to.x)+600)/40),Math.ceil(map.width/40))-x;
  const height=Math.min(Math.ceil((Math.max(from.y,to.y)+600)/40),Math.ceil(map.height/40))-y;
  const steps=gridRoute(map,role,{x,y,width,height},from,to,true);
  if (!steps) return {status:'no-route',unsafeSegments:0,length:null};
  const points=[from,...steps.map(([x,y])=>({x:(x+.5)*40,y:(y+.5)*40})),to];
  let length=0,unsafeSegments=0;
  for(let i=1;i<points.length;i++) {if(!clear(points[i-1],points[i]))unsafeSegments++;length+=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);}
  return {status:unsafeSegments?'unsafe-success':'complete',unsafeSegments,length};
}

async function runCase(zoneWidth,radius,spacing) {
  const role=radius===14?'contestant':'gladiator', content=defaultContent();
  const generated=measure(()=>generateLiveMap(1,content,{zoneWidth,zoneHeight:zoneWidth/2})),map=generated.value;
  // Static bake, with barriers separately tested in authored fixtures.
  const staticMap={...map,gates:[]};
  const baked=measure(()=>bakeGraph(staticMap,{radius,spacing})),graph=baked.value;
  const afterBake=memory();
  const hierarchyModule=await import('./hierarchy.mjs');
  const indexed=measure(()=>hierarchyModule.createHierarchy(graph)),hierarchy=indexed.value;
  const afterIndex=memory();
  const pairs=[['spawn-exit',map.spawns[0],map.exit],['opposite-spawns',map.spawns[0],map.spawns.at(-1)],['hunter-exit',map.hunterSpawns[0],map.exit],['local',map.spawns[0],{x:map.spawns[0].x+96,y:map.spawns[0].y}],['station',map.spawns[0],map.stations[0]]];
  const routes=[];
  for(const [name,from,to] of pairs) {
    hierarchy.rows.clear();
    const fine=measure(()=>queryGraph(graph,from,to)),oracle=measure(()=>queryGraph(graph,from,to,{heuristic:false}));
    const cold=measure(()=>hierarchy.query(from,to)),warm=measure(()=>hierarchy.query(from,to));
    const oldCold=measure(()=>legacy(map,role,from,to,graph.clear)),oldWarm=measure(()=>legacy(map,role,from,to,graph.clear));
    if(fine.value.status!==oracle.value.status || fine.value.status==='complete'&&Math.abs(fine.value.length-oracle.value.length)>1e-6)throw new Error('fine/oracle mismatch');
    if(cold.value.status!==fine.value.status || cold.value.status==='complete'&&Math.abs(cold.value.length-fine.value.length)>1e-6)throw new Error('hierarchy/fine mismatch');
    const repeats={fineMs:[fine.ms],hierarchyColdMs:[cold.ms],hierarchyWarmMs:[warm.ms],oldColdMs:[oldCold.ms],oldWarmMs:[oldWarm.ms]};
    for(let trial=1;trial<3;trial++) {
      repeats.fineMs.push(measure(()=>queryGraph(graph,from,to)).ms);
      hierarchy.rows.clear();
      repeats.hierarchyColdMs.push(measure(()=>hierarchy.query(from,to)).ms);
      repeats.hierarchyWarmMs.push(measure(()=>hierarchy.query(from,to)).ms);
      const fresh={...map};
      repeats.oldColdMs.push(measure(()=>legacy(fresh,role,from,to,graph.clear)).ms);
      repeats.oldWarmMs.push(measure(()=>legacy(fresh,role,from,to,graph.clear)).ms);
    }
    routes.push({name,from,to,fine:{ms:fine.ms,...compact(fine.value)},oracle:{ms:oracle.ms,...compact(oracle.value)},hierarchyCold:{ms:cold.ms,...compact(cold.value)},hierarchyWarm:{ms:warm.ms,...compact(warm.value)},stretch:cold.value.status==='complete'?cold.value.length/fine.value.length:null,oldCold,oldWarm,repeats});
  }
  const a=map.spawns[0],b=map.exit,known=new Set([...graph.support(a),...graph.support(b)]);
  const reveal=measure(()=>queryGraph(graph,a,b,{support:known}));
  const atlas={nodeCount:graph.nodeCount,edgeCount:graph.edgeCount,chunkCount:graph.chunkCols*graph.chunkRows,boundaryNodes:graph.boundaryNodes,boundaryEdges:graph.boundaryEdges,estimatedBytes:graph.estimatedBytes,artifactBytes:graph.artifactBytes};
  const cache=hierarchy.stats();
  const beforeSpeculation=memory();global.gc?.();
  const optimistic=speculative(map.width,map.height,spacing,radius,content.roster.contestants.length+content.roster.gladiators.length);
  return {zoneWidth,zoneHeight:zoneWidth/2,seed:1,radius,spacing,width:map.width,height:map.height,obstacles:map.obstacles.length,gates:map.gates.length,bots:content.roster.contestants.length+content.roster.gladiators.length,generationMs:generated.ms,bakeMs:baked.ms,indexMs:indexed.ms,atlas,afterBake,afterIndex,cache,beforeSpeculation,routes,reveal:{ms:reveal.ms,knownChunks:known.size,...compact(reveal.value)},optimistic,finalMemory:memory()};
}

if(process.argv[2]==='--case') {
  console.log(JSON.stringify(await runCase(...process.argv.slice(3).map(Number))));
} else {
  const lock=await acquireMachineLock('bench');
  try {
    const report={revision:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),created:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,cpuCount:os.cpus().length,totalMemory:os.totalmem(),seed:1,sourceHashes:{},cases:[]};
    for(const path of ['shared/shape.ts','tools/navigation/clearance.mjs','tools/navigation/graph.mjs','tools/navigation/hierarchy.mjs','tools/navigation/optimistic.mjs','tools/navigation/witnesses.mjs','tools/navigation/report.mjs'])report.sourceHashes[path]=createHash('sha256').update(readFileSync(path)).digest('hex');
    report.witnesses=measureWitnesses();
    for(const size of [12,24,36])for(const radius of [14,25])for(const spacing of [24,40]) {
      console.error(`Measuring ${size}x${size/2} r=${radius} spacing=${spacing}`);
      const child=spawnSync(process.execPath,['--expose-gc',import.meta.filename,'--case',String(size),String(radius),String(spacing)],{encoding:'utf8',maxBuffer:16*1024*1024});
      if(child.status!==0)throw new Error(child.stderr||child.stdout);
      report.cases.push(JSON.parse(child.stdout));
      writeFileSync(process.argv[2]??'test-results/navigation-364.json',JSON.stringify(report,null,2)+'\n');
    }
  } finally {lock.release();}
}
