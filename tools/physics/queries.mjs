import { loadCandidate } from './runner.mjs';
import { workload } from './scenarios.mjs';
import { DT, quantiles, digest } from './common.mjs';

// Query-only microbenchmark supplement. The full sweep's fringe casts are kept
// as recorded; these fixed paths deliberately traverse the body population.
export async function queryBenchmark(name,config,{samples=100,warmup=20}={}){
  const scene=workload(config),targets=scene.bodies.filter(b=>b.kind!=='static');
  const queries=Array.from({length:128},(_,i)=>{
    const b=targets[i%targets.length];
    return {x:b.x-32,y:b.y+(i%4===3?32:0),dx:64,dy:0,radius:1};
  });
  const create=await loadCandidate(name),world=await create(structuredClone(scene));
  const times=[],hits=[];
  try{
    world.step(DT/4); // Populate the engine's query index; freeze the scene here.
    for(let i=0;i<warmup+samples;i++){
      const start=performance.now();let hitCount=0;
      for(const q of queries)if(world.cast(q))hitCount++;
      const elapsed=performance.now()-start;
      if(i>=warmup){times.push(elapsed);hits.push(hitCount);}
    }
    return {config,samples,warmup,queries:128,inputHash:await digest(JSON.stringify(queries)),
      scene:'one common 12.5 ms step then frozen; 96 paths through initial body centres, 32 offset by 32 units',
      castMs:quantiles(times),hits:quantiles(hits),raw:{castMs:times,hits},settings:world.settings};
  }finally{world.dispose();}
}
