// Complete one identical empty-knowledge request after the bounded aggregate run.
// This exposes total repeated-search work without treating slice exhaustion as failure.
import { neutralGraph } from './optimistic.mjs';
import { beginQuery } from './graph.mjs';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { performance } from 'node:perf_hooks';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const lock=await acquireMachineLock('bench');
try {
  const cases=[];
  for(const size of [12,24,36])for(const spacing of [24,40])for(const radius of [14,25]) {
    const width=size*1440,height=size*720;
    const graph=neutralGraph(width,height,spacing,radius);
    const start=performance.now(),search=beginQuery(graph,{x:96,y:96},{x:width-96,y:height*.73},{direct:false});
    let answer,slices=0;
    do {answer=search.step(2000);slices++;}while(answer.status==='budget-exhausted');
    cases.push({size,spacing,radius,slices,status:answer.status,expansions:answer.expansions,worldSamples:graph.passable.length,fraction:answer.expansions/graph.passable.length,ms:performance.now()-start,privateBytes:search.privateBytes,identicalElevenBotExpansions:11*answer.expansions});
    console.error(`${size} r${radius} s${spacing}: ${answer.expansions} expansions, ${slices} slices`);
    global.gc?.();
  }
  const sourceHash=createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex');
  writeFileSync(process.argv[2]??'test-results/navigation-364-continuation.json',JSON.stringify({sourceHash,cases},null,2)+'\n');
}finally{lock.release();}
