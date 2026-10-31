// Bounded, source-extracted microbenchmark. This does not time whole generation.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';

function selectors(source) {
  const js = stripTypeScriptTypes(source);
  const start = js.indexOf('const step = mask.cellSize / 2, box = mask.bounds;', js.indexOf('export function findRegionRoute'));
  const end = js.indexOf('const queue',start);
  if (start<0 || end<start || !js.slice(start,end).includes('nearby.sort')) throw Error('Review changed route-search source');
  const localText=js.slice(start,end),collar=localText.indexOf('// Only this collar'),sort=localText.indexOf('nearby.sort');
  if(collar<0)throw Error('Review changed start-selection source');
  const controlText=localText.slice(0,collar)+'for(let i=0;i<width*height;i++) if(Math.hypot(point(i).x-a.x,point(i).y-a.y)<=step*3) nearby.push(i);\n'+localText.slice(sort);
  // Both variants retain the same unused free() closure and other common setup.
  return {local:new Function('mask','a',localText+'return nearby;'),control:new Function('mask','a',controlText+'return nearby;'),localText,controlText};
}
export function actualStarts(source) {return selectors(source).local;}

export function wholeGridStarts(mask,a) {
  const step=mask.cellSize/2,box=mask.bounds;
  const width=Math.round(box.w/step)+1,height=Math.round(box.h/step)+1;
  const point=i=>({x:box.x+i%width*step,y:box.y+Math.floor(i/width)*step});
  const nearby=[];
  for(let i=0;i<width*height;i++) if(Math.hypot(point(i).x-a.x,point(i).y-a.y)<=step*3) nearby.push(i);
  nearby.sort((i,j)=>Math.hypot(point(i).x-a.x,point(i).y-a.y)-Math.hypot(point(j).x-a.x,point(j).y-a.y));
  return nearby;
}

async function main() {
  const [flag,out]=process.argv.slice(2);
  if(flag!=='--out'||!out||process.argv.length!==4)throw Error('Usage: route-start-bench.mjs --out NEW_REPORT.json');
  const source=readFileSync(new URL('../map/micro/geometry.ts',import.meta.url),'utf8');
  const cases=JSON.parse(readFileSync(new URL('../docs/reports/issue-722/cases.json',import.meta.url),'utf8'));
  const {local,control,localText,controlText}=selectors(source),hash=b=>createHash('sha256').update(b).digest('hex');
  for(const c of cases)assert.deepEqual(local(c.mask,c.a),wholeGridStarts(c.mask,c.a),c.id);
  const lock=await acquireMachineLock('bench',{timeoutMs:1000,pollMs:100});
  const pairs=[],deadline=performance.now()+10000;
  try {
    for(let i=0;i<3;i++) {
      if(performance.now()>deadline)throw Error('Microbenchmark exceeded 10-second budget; no automatic retry');
      const pair={};
      for(const [name,fn]of [['wholeGrid',control],['local',local]]) {
        const values=[],start=performance.now();
        for(const c of cases)values.push(fn(c.mask,c.a));
        pair[name]={ms:performance.now()-start,outputSha256:hash(JSON.stringify(values))};
      }
      assert.equal(pair.wholeGrid.outputSha256,pair.local.outputSha256);pairs.push(pair);
    }
  }finally{lock.release();}
  const report={scope:'Start enumeration only; not whole-generation timing.',cases:cases.length,
    sourceNormalizedSha256:hash(source.replaceAll('\r\n','\n')),controlSha256:hash(controlText),variantSha256:hash(localText),pairs};
  writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
