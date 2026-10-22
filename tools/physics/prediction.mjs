import { loadCandidate } from './runner.mjs';
import { DT, quantiles } from './common.mjs';

// Synthetic projection-only island. No production protocol or visibility implementation.
export async function prediction(name, {rttMs=100,substeps=4,ticks=100}={}) {
  const create=await loadCandidate(name);
  const local={id:'local',kind:'actor',shape:'circle',radius:8,x:0,y:0};
  const hidden={id:'secret',kind:'actor',shape:'circle',radius:8,x:55,y:0,mass:20};
  const wall={id:'known-wall',kind:'static',shape:'box',hx:3,hy:100,x:180,y:0};
  const authority=await create({bodies:[local,hidden,wall],joints:[]});
  let client=await create({bodies:[local,wall],joints:[]});
  const packets=[],error=[],cost=[],corrections=[],replayTicks=[];
  let leaks=0,resets=0,cacheExact=0,cacheTrials=0,maxBacklog=0;
  const input=tick=>({x:tick<65?100:-100,y:tick>=35&&tick<55?65:0,accel:350});
  const step=(w,tick)=>{w.motor('local',input(tick));for(let i=0;i<substeps;i++)w.step(DT/substeps);};
  try {
    for(let tick=0;tick<ticks;tick++) {
      // Visibility churn: hidden body only becomes authorized after tick 45.
      // Door disagreement: authority closes a new wall at tick 25; learn it at 45.
      if(tick===25) authority.addBody({id:'door',kind:'static',shape:'box',hx:3,hy:70,x:120,y:0});
      if(tick===60) {authority.removeBody('secret');resets++;}
      step(authority,tick);
      const visible=authority.states().filter(b=>b.id==='local'||b.id==='known-wall'||(tick>=45&&(b.id==='door'||b.id==='secret')));
      const payload=JSON.stringify(visible);
      if(tick<45&&(payload.includes('secret')||payload.includes('door'))) leaks++;
      // Ordered reliable connection: stalls delay a batch; no fake packet reordering.
      const baseDelay=Math.ceil(rttMs/2/50),jitter=(tick%7===0?1:0);
      const deliver=Math.max(tick+baseDelay+jitter,packets.at(-1)?.deliver??0, tick>=30&&tick<36?36:0);
      packets.push({tick,deliver,bodies:visible});
      const started=performance.now(); step(client,tick);
      let newest;
      while(packets.length && packets[0].deliver<=tick) newest=packets.shift();
      if(newest) {
        const backlog=tick-newest.tick;maxBacklog=Math.max(maxBacklog,backlog);
        const old=client.states().find(b=>b.id==='local');
        const fresh=await create({bodies:newest.bodies,joints:[]});
        let snapshot;
        try{snapshot=fresh.checkpoint();}catch{}
        if(backlog>8) resets++;
        const begin=backlog>8?tick+1:newest.tick+1;
        for(let t=begin;t<=tick;t++)step(fresh,t);
        replayTicks.push(Math.max(0,tick-begin+1));
        const next=fresh.states().find(b=>b.id==='local');
        corrections.push(Math.hypot(next.x-old.x,next.y-old.y));
        // Safe cache belongs to this newly projected island, never authority's hidden world.
        if(snapshot && tick%10===0) {
          const expected=JSON.stringify(fresh.states()); fresh.restore(snapshot);
          for(let t=begin;t<=tick;t++)step(fresh,t);
          cacheTrials++;cacheExact+=JSON.stringify(fresh.states())===expected?1:0;
        }
        client.dispose();client=fresh;
      }
      cost.push(performance.now()-started);
      const a=authority.states().find(b=>b.id==='local'),b=client.states().find(b=>b.id==='local');
      error.push(Math.hypot(a.x-b.x,a.y-b.y));
    }
    return {rttMs,substeps,ticks,model:'synthetic ordered projection, fresh-island replay; one-way RTT/2, tick jitter, stall 30..35, removal 60',
      leaks,resets,maxBacklog,replayCap:8,replayTicks:quantiles(replayTicks),error:quantiles(error),
      correction:quantiles(corrections),frameMs:quantiles(cost),cache:{trials:cacheTrials,exact:cacheExact},
      settleTickAfterRemoval:error.findIndex((v,i)=>i>=60&&v<=.5),raw:{error,cost,corrections,replayTicks}};
  }finally{authority.dispose();client.dispose();}
}
