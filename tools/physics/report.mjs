import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { correctness, benchmark, lifecycle, envelopeConfigs, coldStart } from './runner.mjs';
import { prediction } from './prediction.mjs';
import { digest } from './common.mjs';

const args=new Map(process.argv.slice(2).map(s=>s.replace(/^--/,'').split('=')));
const out=args.get('out')??'test-results/physics-437.json';
const mode=args.get('mode')??'correctness';
if(!['correctness','node','browser','all'].includes(mode))throw Error('mode must be correctness, node, browser or all');
const samples=Number(args.get('samples')??100),warmup=Number(args.get('warmup')??20);
if(!Number.isInteger(samples)||samples<1||!Number.isInteger(warmup)||warmup<0)throw Error('Invalid sample count');
const names=(args.get('candidates')??'custom,rapier').split(',');
const lock=await acquireMachineLock('bench');
const report={schema:1,date:new Date().toISOString(),command:process.argv.slice(2),
  provenance:{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    trackedStatus:execFileSync('git',['status','--short','--untracked-files=no'],{encoding:'utf8'}).trim(),
    node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,
    os:os.release(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemory:os.totalmem(),
    seed:437,tickSeconds:.05,substeps:[2,4,8],samples,warmup,lockPort:lock.port,files:{}},
  limitations:['Synthetic lab, not whole-game throughput or a production prediction benchmark.',
    'Substep endpoint/straight-path observations cannot reconstruct internal CCD bounce paths.',
    'Heap readings include JS wrappers and runtime noise, not a WASM allocation census.',
    'p99 is descriptive of the retained finite samples, not a tail-latency guarantee.'],node:{},browser:{}};
const save=async()=>{await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n');};
const attempt=async fn=>{try{return await fn();}catch(e){return {error:String(e),stack:e.stack};}};
try{
  for(const file of (await readdir('tools/physics')).filter(f=>/\.(mjs|md)$/.test(f))){
    const p=`tools/physics/${file}`;report.provenance.files[p]=await digest(await readFile(p,'utf8'));
  }
  for(const p of ['package-lock.json','node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs'])
    report.provenance.files[p]=await digest(await readFile(p,'utf8'));
  const wasm=await readFile('node_modules/@dimforge/rapier2d-compat/dist/rapier_wasm2d_bg.wasm');
  const {createHash}=await import('node:crypto');
  report.provenance.wasm={bytes:wasm.length,sha256:createHash('sha256').update(wasm).digest('hex')};
  const pack=JSON.parse(await readFile('node_modules/@dimforge/rapier2d-compat/package.json','utf8'));
  report.provenance.dependency={name:pack.name,version:pack.version,license:pack.license};
  if(mode!=='browser') for(const name of names){
    const entry=report.node[name]={};
    entry.coldStart=await attempt(()=>coldStart(name));
    console.log(`${name}: correctness`);
    entry.correctness=await attempt(()=>correctness(name));await save();
    global.gc?.();const before=process.memoryUsage();
    entry.lifecycle=await attempt(()=>lifecycle(name));global.gc?.();
    entry.memory={before,after:process.memoryUsage(),forcedGC:!!global.gc};
    entry.prediction=[];
    for(const rttMs of [0,50,100,200])entry.prediction.push(await attempt(()=>prediction(name,{rttMs})));
    await save();
    if(mode==='node'||mode==='all'){
      entry.benchmarks=[];
      for(const config of envelopeConfigs({full:!args.has('diagonal')}))for(const substeps of [2,4,8]){
        console.log(`${name}: ${config.actors}/${config.bodies}/${config.tethers} ${config.clustered?'clustered':'sparse'} sleep=${config.sleeping} sub=${substeps}`);
        entry.benchmarks.push(await attempt(()=>benchmark(name,config,substeps,{samples,warmup})));await save();
      }
    }
  }
  if(mode==='node'||mode==='all'){
    report.node.legacy={benchmarks:[]};
    for(const actors of [11,27,64])for(const clustered of [false,true]){
      report.node.legacy.benchmarks.push(await attempt(()=>benchmark('legacy',{actors,bodies:0,tethers:0,clustered,sleeping:0,seed:437},1,{samples,warmup,projectiles:0})));
    }await save();
  }
  if(mode==='browser'||mode==='all'){
    const root=process.cwd();
    const server=createServer(async(req,res)=>{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Physics P0</title>');return;}
      const allowed=/^\/tools\/physics\/[a-z0-9-]+\.mjs$/.test(url.pathname)||url.pathname==='/node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs';
      if(!allowed){res.writeHead(404).end();return;}
      try{res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(root,url.pathname)));}catch{res.writeHead(404).end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let browser;
    try{
      browser=await chromium.launch({channel:'chrome',args:['--enable-precise-memory-info']});
      const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
      report.browser.runtime={version:browser.version(),userAgent:await page.evaluate(()=>navigator.userAgent),headless:true};
      for(const name of names){
        console.log(`browser ${name}: correctness`);
        const e=report.browser[name]={};
        e.coldStart=await attempt(()=>page.evaluate(async name=>(await import('/tools/physics/runner.mjs')).coldStart(name),name));
        e.correctness=await attempt(()=>page.evaluate(async name=>(await import('/tools/physics/runner.mjs')).correctness(name),name));await save();
        e.lifecycle=await attempt(()=>page.evaluate(async name=>{
          const before=performance.memory?.usedJSHeapSize;
          const result=await(await import('/tools/physics/runner.mjs')).lifecycle(name);
          return {...result,heapBefore:before,heapAfter:performance.memory?.usedJSHeapSize};
        },name));
        e.prediction=[];
        for(const rttMs of [0,50,100,200])e.prediction.push(await attempt(()=>page.evaluate(async({name,rttMs})=>(await import('/tools/physics/prediction.mjs')).prediction(name,{rttMs}),{name,rttMs})));
        e.benchmarks=[];
        for(const config of envelopeConfigs({full:false})){
          console.log(`browser ${name}: ${config.actors}/${config.bodies}/${config.tethers} clustered=${config.clustered}`);
          e.benchmarks.push(await attempt(()=>page.evaluate(async({name,config,samples,warmup})=>(await import('/tools/physics/runner.mjs')).benchmark(name,config,4,{samples,warmup}),{name,config,samples,warmup})));await save();
        }
      }
    }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
  }
  await save();console.log(`Wrote ${out}`);
}finally{lock.release();}
