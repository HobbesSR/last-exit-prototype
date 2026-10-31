// Contextual feature-versus-original-content cost, separate from isolated #723.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {acquireMachineLock} from '../../../tests/helpers/machine-lock.js';
const [directory,baselinePanel,output]=process.argv.slice(2);
const hash=b=>createHash('sha256').update(b).digest('hex');
const load=(name,f)=>import(pathToFileURL(path.resolve(directory,name,f)));
const corpusBytes=fs.readFileSync(path.join(directory,'batch/docs/reports/issue-716/frozen-corpus.json.gz'));
const rows=JSON.parse(gunzipSync(corpusBytes)).rows;
const {readChainMap}=await load('original','map/macro/src/chain/saving.ts');
const maps=new Map(),inputHashes={};
for(const row of rows)if(!maps.has(row.seed)){
  const bytes=fs.readFileSync(path.join(baselinePanel,row.seed+'.json.gz'));
  maps.set(row.seed,readChainMap(gunzipSync(bytes)));inputHashes[row.seed]=hash(bytes);
}
const body=({elements,loot,coreElements,manifest})=>({elements,loot,coreElements,manifest});
const builders={};
for(const name of ['original','batch']){
  builders[name]={};for(const type of ['depot','market'])builders[name][type]=(await load(name,`map/micro/strategies/${type}.ts`))[type==='depot'?'buildDepot':'buildMarket'];
}
const report={scope:'Contextual original types-56 content versus optimized #716 prototype; NOT the isolated #723 comparison.',originalRevision:'54d9077a5fd881765b123d4d877d3bca67694409',originalArchiveSha256:hash(fs.readFileSync(path.join(directory,'original.tar'))),corpusSha256:hash(corpusBytes),inputHashes,repeats:[],scale:[]};
fs.writeFileSync(output,JSON.stringify(report),{flag:'wx'});
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
const lock=await acquireMachineLock('bench',{timeoutMs:1000,pollMs:100});
try{
  for(let repetition=0;repetition<3;repetition++){
    const pair={};
    for(const name of repetition%2?['batch','original']:['original','batch']){
      const started=performance.now(),outputs=[],groups={};
      for(const row of rows){
        const saved=maps.get(row.seed).results[row.index];
        if(JSON.stringify(saved.brief)!==JSON.stringify(row.brief))throw Error('Baseline brief drift');
        const tick=performance.now(),actual=body(builders[name][row.brief.type](structuredClone(row.brief))),ms=performance.now()-tick;
        const outputHash=hash(JSON.stringify(actual)),expected=name==='batch'?row.sha256:hash(JSON.stringify(body(saved)));
        if(outputHash!==expected)throw Error(`Output drift: ${name}/${row.seed}/${row.index}`);
        const group=groups[row.brief.type]??={count:0,ms:0};group.count++;group.ms+=ms;outputs.push(outputHash);
      }
      pair[name]={ms:performance.now()-started,groups,outputSha256:hash(JSON.stringify(outputs))};
      console.log(JSON.stringify({repetition:repetition+1,name,...pair[name]}));
    }
    report.repeats.push(pair);save();
  }
  // Retain the original 200x150 witness and 3s assertion. A hard 10s process
  // cap bounds each attempt; a capped run is explicitly incomplete, not a pass.
  for(let repetition=0;repetition<3;repetition++)for(const name of ['original','batch']){
    const args=['--test','--test-concurrency=1','--test-name-pattern=macro-sized depot','tests/micro-depot.test.js'];
    const started=performance.now(),r=spawnSync(process.execPath,args,{cwd:path.resolve(directory,name),env:{...process.env,BUILD_BUDGETS:'enforce'},encoding:'utf8',timeout:10000,maxBuffer:1024*1024,windowsHide:true});
    const result={repetition:repetition+1,name,ms:performance.now()-started,capMs:10000,status:r.error?.code==='ETIMEDOUT'?'time-cap':r.status===0?'passed':'failed',exitCode:r.status,stdout:r.stdout,stderr:r.stderr};
    report.scale.push(result);save();console.log(JSON.stringify({scale:result.status,repetition:result.repetition,name,ms:result.ms}));
  }
  report.status='complete';save();
}finally{lock.release();save();}
