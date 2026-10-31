import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createAccessMask } from '../../../map/micro/geometry.ts';
import { portalStands } from '../../../map/micro/portals.ts';
import { acquireMachineLock } from '../../../tests/helpers/machine-lock.js';

const hash = b => createHash('sha256').update(b).digest('hex');
const corpusPath = resolve('docs/reports/issue-716/frozen-corpus.json.gz');
const corpusBytes = readFileSync(corpusPath), corpus = JSON.parse(gunzipSync(corpusBytes));
const source = readFileSync('map/micro/geometry.ts','utf8');
const js = stripTypeScriptTypes(source);
const begin = js.indexOf('const step = mask.cellSize / 2, box = mask.bounds;', js.indexOf('export function findRegionRoute'));
const end = js.indexOf('const queue', begin);
const localText = js.slice(begin,end);
const collar = localText.indexOf('// Only this collar');
const sort = localText.indexOf('nearby.sort');
if (begin<0||end<0||collar<0||sort<0) throw Error('Source markers changed');
const oldText = localText.slice(0,collar) + 'for(let i=0;i<width*height;i++) if(Math.hypot(point(i).x-a.x,point(i).y-a.y)<=step*3) nearby.push(i);\n' + localText.slice(sort);
const oldStarts = new Function('mask','a',oldText+'return nearby;');
const localStarts = new Function('mask','a',localText+'return nearby;');
const cases = corpus.rows.map(row => ({id:row.seed+'/'+row.brief.id,mask:createAccessMask(row.brief),a:portalStands(row.brief)[0]?.points[0]})).filter(c=>c.a);
for(const c of cases.slice(0,4)) for(const delta of [-0.33,0.27]) cases.push({...c,id:c.id+'/off-grid/'+delta,a:{x:c.a.x+delta*c.mask.cellSize,y:c.a.y+delta*c.mask.cellSize}});
for(const c of cases) if(JSON.stringify(oldStarts(c.mask,c.a))!==JSON.stringify(localStarts(c.mask,c.a))) throw Error('Start ordering drift: '+c.id);
const report = {scope:'Source-extracted start enumeration only; not whole-generation timing.',sourceSha256:hash(source),controlSha256:hash(oldText),variantSha256:hash(localText),microCases:cases.length,corpusSha256:hash(corpusBytes),repetitions:[]};
let lock;
try {
  lock = await acquireMachineLock('bench',{timeoutMs:1000,pollMs:100});
  const deadline = performance.now()+10000;
  for(let i=0;i<3;i++) {
    if(performance.now()>deadline) {report.microStatus='time-cap';break;}
    const pair={};
    for(const [name,fn] of [['wholeGrid',oldStarts],['local',localStarts]]) {
      const results=[],start=performance.now();
      for(const c of cases) results.push(fn(c.mask,c.a));
      const ms=performance.now()-start;
      pair[name]={ms,outputSha256:hash(JSON.stringify(results))};
    }
    if(pair.wholeGrid.outputSha256!==pair.local.outputSha256) throw Error('Microbenchmark output drift');
    report.repetitions.push(pair);
  }
  report.microStatus ??= report.repetitions.length===3?'complete':'incomplete';
} catch(e) { report.microStatus='deferred';report.microReason=String(e); }
finally {lock?.release();}
writeFileSync('test-results/issue-722-micro.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({phase:'micro',status:report.microStatus,cases:cases.length,repetitions:report.repetitions}));

// One output-identity pass only. The parent imposes a hard wall-clock limit.
const temp=mkdtempSync(resolve('test-results/issue-722-identity-'));
const progress=join(temp,'progress.json'), child=join(temp,'check.mjs');
const moduleUrl=p=>pathToFileURL(resolve(p)).href;
writeFileSync(child,`import fs from'node:fs';import{gunzipSync}from'node:zlib';import{createHash}from'node:crypto';
import{buildDepot}from${JSON.stringify(moduleUrl('map/micro/strategies/depot.ts'))};
import{buildMarket}from${JSON.stringify(moduleUrl('map/micro/strategies/market.ts'))};
const rows=JSON.parse(gunzipSync(fs.readFileSync(${JSON.stringify(corpusPath)}))).rows;
let state={status:'running',checked:0,total:rows.length};const save=()=>fs.writeFileSync(${JSON.stringify(progress)},JSON.stringify(state));save();
for(const row of rows){const r=(row.brief.type==='depot'?buildDepot:buildMarket)(row.brief),body={elements:r.elements,loot:r.loot,coreElements:r.coreElements,manifest:r.manifest};
const actual=createHash('sha256').update(JSON.stringify(body)).digest('hex');
if(actual!==row.sha256){state.status='mismatch';state.row=row.seed+'/'+row.brief.id;save();process.exit(1);}state.checked++;save();}
state.status='complete';save();`);
const started=performance.now();
const execution=spawnSync(process.execPath,[child],{encoding:'utf8',timeout:60000,windowsHide:true,maxBuffer:1024*1024});
const identity=JSON.parse(readFileSync(progress,'utf8'));
identity.elapsedMs=performance.now()-started;identity.capMs=60000;
if(execution.error?.code==='ETIMEDOUT')identity.status='time-cap';
else if(execution.status!==0&&identity.status!=='mismatch'){identity.status='error';identity.error=String(execution.error??execution.stderr);}
if(hash(readFileSync('map/micro/geometry.ts','utf8'))!==report.sourceSha256)throw Error('Geometry source changed during checks');
identity.corpusSha256=hash(corpusBytes);
writeFileSync('test-results/issue-722-identity.json',JSON.stringify(identity,null,2)+'\n');
console.log(JSON.stringify({phase:'identity',...identity}));
