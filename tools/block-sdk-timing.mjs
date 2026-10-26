// #580 cold-process comparison: node tools/block-sdk-timing.mjs before|after.
// Pin only the block strategy; keep the current child builders and brief validation.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRegion } from '../map/micro/region-types.ts';
import { cellsOf } from '../tests/helpers/cells.js';
import { brief } from '../tests/helpers/block-masks.js';
const root = resolve('test-results');
await mkdir(root, {recursive:true});
const scratch = await mkdtemp(resolve(root,'580-timing-'));
try {
  const sourcePath='map/micro/strategies/block.ts';
  const source=execFileSync('git',['show',`872932e:${sourcePath}`],{encoding:'utf8'});
  const baseline=resolve(scratch,'baseline.ts');
  await writeFile(baseline,source.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,(_,a,p,b)=>`${a}${pathToFileURL(resolve(dirname(sourcePath),p)).href}${b}`));
  const before=(await import(pathToFileURL(baseline).href)).buildBlock;
  const cells=cellsOf(200,150),portals=[];
  for(let x=2;x<196;x+=4) portals.push({id:`n${x}`,axis:'h',x,y:0,length:2},{id:`s${x}`,axis:'h',x,y:150,length:2});
  for(let y=2;y<146;y+=4) portals.push({id:`w${y}`,axis:'v',x:0,y,length:2},{id:`e${y}`,axis:'v',x:200,y,length:2});
  const input=brief('macro',3,cells,portals);
  const mode=process.argv[2];
  const start=performance.now();
  const result=mode==='before'?buildRegion(input,{block:before}):buildRegion(input);
  console.log(JSON.stringify({mode,elapsedMs:performance.now()-start,lots:result.manifest.lots,elements:result.elements.length}));
} finally {await rm(scratch,{recursive:true,force:true});}
