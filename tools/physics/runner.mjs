import { scenarios, workload } from './scenarios.mjs';
import { createMetrics } from './metrics.mjs';
import { DT, quantiles, stateText, digest, actionsAt, doorStats } from './common.mjs';

export async function loadCandidate(name) {
  if (!['rapier','custom','legacy'].includes(name)) throw new Error(`Unknown candidate ${name}`);
  return (await import(`./${name}.mjs`)).createWorld;
}

async function trace(create, scenario, substeps, { checkpoint = false, metrics = false } = {}) {
  const world = await create(structuredClone(scenario.scene));
  const metricScene=structuredClone(scenario.scene);
  const diagnostics = metrics ? createMetrics(metricScene) : null;
  const frames = [], errors = [];
  let previous = world.states(), checkpointBytes = null, restored = false, spring = null;
  const initial = createMetrics(scenario.scene); initial.inspect(previous, previous);
  try {
    for (let tick = 0; tick < scenario.ticks; tick++) {
      actionsAt(world, scenario, tick);
      for(const a of scenario.actions??[])if(a.tick===tick){
        if(a.method==='removeBody')metricScene.joints=metricScene.joints.filter(j=>j.a!==a.args[0]&&j.b!==a.args[0]);
        if(a.method==='removeJoint')metricScene.joints=metricScene.joints.filter(j=>j.id!==a.args[0]);
        if(a.method==='addJoint')metricScene.joints.push(a.args[0]);
      }
      if (checkpoint && tick === Math.floor(scenario.ticks / 2)) {
        const saved = world.checkpoint();
        checkpointBytes = new TextEncoder().encode(JSON.stringify(saved)).length;
        world.step(DT); // Restore must undo actual divergence, including solver caches.
        world.restore(saved); restored = true;
      }
      for (let i=0;i<substeps;i++) {
        world.step(DT/substeps);
        const states = world.states();
        diagnostics?.inspect(states, previous);
        previous = states;
      }
      frames.push(stateText(previous));
      const ref=scenario.springReference;
      if(ref && tick+1===Math.round(ref.atSeconds/DT)){
        const a=previous.find(b=>b.id===ref.a),b=previous.find(b=>b.id===ref.b);
        const measured=Math.abs(Math.hypot(a.x-b.x,a.y-b.y)-ref.length);
        spring={measured,expected:ref.expectedAmplitude,relativeError:Math.abs(measured-ref.expectedAmplitude)/ref.expectedAmplitude};
        spring.pass=spring.relativeError<=ref.tolerance;
      }
    }
    return { hash: await digest(frames.join('\n')), final: previous,
      initial: initial.summary(), metrics: diagnostics?.summary(), checkpointBytes, restored,
      settings: world.settings, errors, spring, doors:doorStats(world) };
  } finally { world.dispose(); world.dispose(); if (world.counts().bodies || world.counts().joints) throw new Error('Dispose leaked handles'); }
}

export async function correctness(name, { substepsList = [2,4,8], only } = {}) {
  const create = await loadCandidate(name), rows = [];
  for (const substeps of substepsList) for (const scenario of scenarios().filter(s=>!only || only.includes(s.name))) {
    try {
      const first = await trace(create, scenario, substeps, {metrics:true});
      const second = await trace(create, scenario, substeps);
      let checkpoint;
      try { const continued = await trace(create, scenario, substeps, {checkpoint:true});
        checkpoint = {exact:continued.hash === first.hash, bytes:continued.checkpointBytes, restored:continued.restored};
      } catch(error) { checkpoint = {exact:false,error:String(error)}; }
      const m = first.metrics;
      rows.push({scenario:scenario.name,substeps,hash:first.hash,repeatExact:first.hash===second.hash,
        checkpoint,metrics:m,initial:first.initial,final:first.final,settings:first.settings,spring:first.spring,doors:first.doors,
        metadata:Object.fromEntries(Object.entries(scenario).filter(([k])=>!['scene','actions'].includes(k))),
        numericalGate:m.finite && m.staticPenetration<=.01 && m.actorPenetration<=.5 && m.propPenetration<=.5 && m.crossings===0 && m.ropeExcess<=1 && (!first.spring||first.spring.pass)});
    } catch(error) { rows.push({scenario:scenario.name,substeps,error:String(error),numericalGate:false}); }
  }
  return rows;
}

export function envelopeConfigs({full = true} = {}) {
  const configs = [];
  for (const actors of [11,27,64]) for (const bodies of [0,128,512])
    for (const tethers of (full ? [0,8,32] : [bodies===0?0:bodies===128?8:32]))
      for (const clustered of [false,true]) configs.push({actors,bodies,tethers,clustered,sleeping:0,seed:437});
  // Separate sleeping population; do not substitute it for awake measurements.
  for (const actors of [11,27,64]) configs.push({actors,bodies:512,tethers:0,clustered:false,sleeping:512,seed:437});
  return configs;
}

export async function benchmark(name, config, substeps, {warmup=20,samples=100,projectiles=128}={}) {
  const create = await loadCandidate(name), scene = workload(config);
  const heap=()=>typeof process!=='undefined'?process.memoryUsage():{usedJSHeapSize:performance.memory?.usedJSHeapSize};
  const heapBefore=heap();
  const start = performance.now(), world = await create(structuredClone(scene));
  const startupMs = performance.now()-start, times=[], castTimes=[], serializeTimes=[], frameBytes=[];
  try {
    for (let tick=0;tick<warmup+samples;tick++) {
      const t=performance.now();
      for(let i=0;i<substeps;i++) world.step(DT/substeps);
      const elapsed=performance.now()-t;
      const q=performance.now();
      if(name!=='legacy') for(let i=0;i<projectiles;i++) world.cast({x:-400+(i%16)*50,y:-400+Math.floor(i/16)*50,dx:90,dy:30,radius:1});
      const casts=performance.now()-q;
      const z=performance.now(), frame=stateText(world.states()), serialization=performance.now()-z;
      if(tick>=warmup) {times.push(elapsed);castTimes.push(casts);serializeTimes.push(serialization);frameBytes.push(new TextEncoder().encode(frame).length);}
    }
    return {config,substeps,warmup,samples,projectiles:name==='legacy'?0:projectiles,startupMs,
      stepMs:quantiles(times),castMs:quantiles(castTimes),serializationMs:quantiles(serializeTimes),
      frameBytes:quantiles(frameBytes),raw:{stepMs:times,castMs:castTimes,serializationMs:serializeTimes,frameBytes},
      heap:{before:heapBefore,after:heap(),note:'Unforced readings; includes allocation and GC noise, no WASM census'},
      counts:world.counts(),settings:world.settings,finalHash:await digest(stateText(world.states()))};
  } finally {world.dispose();}
}

export async function lifecycle(name, cycles=50) {
  const create=await loadCandidate(name), startup=[], disposal=[];
  let zeroCounts=true, postDisposeThrows=true;
  for(let i=0;i<cycles;i++) {
    let t=performance.now();
    const w=await create({bodies:[{id:'a',kind:'actor',shape:'circle',radius:8,x:0,y:0}],joints:[]});
    startup.push(performance.now()-t);
    w.addBody({id:'b',kind:'actor',shape:'circle',radius:8,x:40,y:0});
    w.addJoint({id:'j',kind:'rope',a:'a',b:'b',length:50});
    w.removeBody('b'); w.addBody({id:'b',kind:'actor',shape:'circle',radius:8,x:80,y:0});
    if(w.counts().joints!==0) throw new Error('Stale joint after reused ID');
    w.step(DT/4);
    // Synthetic drop/pickup burst, without invoking inventory or gameplay.
    for(let j=0;j<128;j++)w.addBody({id:`drop-${j}`,kind:'loot',shape:'circle',radius:2,x:j*5,y:50});
    w.step(DT/4);
    for(let j=0;j<128;j++)w.removeBody(`drop-${j}`);
    t=performance.now();w.dispose();w.dispose();disposal.push(performance.now()-t);
    zeroCounts &&= w.counts().bodies===0 && w.counts().joints===0;
    try {w.states();postDisposeThrows=false;} catch {}
  }
  return {cycles,burstBodiesPerCycle:128,zeroCounts,postDisposeThrows,startupMs:quantiles(startup),disposeMs:quantiles(disposal),raw:{startup,disposal}};
}

export async function coldStart(name){
  const start=performance.now(),create=await loadCandidate(name),loaded=performance.now();
  const w=await create({bodies:[],joints:[]}),initialized=performance.now();w.dispose();
  return {importMs:loaded-start,firstWorldMs:initialized-loaded,totalMs:initialized-start};
}
