import { performance } from 'node:perf_hooks';
import { bakeGraph, queryGraph } from './graph.mjs';
import { createHierarchy } from './hierarchy.mjs';
import { createClearance } from './clearance.mjs';
import { gridRoute } from '../../shared/map/route.ts';
import { reachClear } from '../../shared/movement.ts';

const time=fn=>{const start=performance.now();const value=fn();return {ms:performance.now()-start,value};};
const scene=(width,height,obstacles=[],gates=[])=>({width,height,obstacles,gates,playableArea:{cellSize:48,rows:Array.from({length:height/48},(_,y)=>({y,runs:[[0,width/48]]}))}});
const result=r=>({status:r.status,length:Number.isFinite(r.length)?r.length:null,expansions:r.expansions,localExpansions:r.localExpansions});
export function measureWitnesses() {
  const passages=[];
  for(const [radius,gap] of [[14,40],[25,60]]) {
    const map=scene(384,192,[{x:180,y:0,w:10,h:48-gap/2},{x:180,y:48+gap/2,w:10,h:192-48-gap/2}]);
    const from={x:130,y:130},to={x:230,y:130};
    const samples=[];
    for(const spacing of [40,24,6]) {
      const baked=time(()=>bakeGraph(map,{radius,spacing}));
      const query=time(()=>queryGraph(baked.value,from,to));
      samples.push({spacing,bakeMs:baked.ms,bytes:baked.value.estimatedBytes,nodes:baked.value.nodeCount,queryMs:query.ms,...result(query.value)});
    }
    passages.push({radius,gap,physicalWitness:createClearance(map,radius)({x:130,y:48},{x:230,y:48}),samples});
  }
  const detours=[];
  for(const radius of [14,25]) {
    const map=scene(384,1920,[{x:180,y:0,w:10,h:1560}]),from={x:120,y:96},to={x:264,y:96};
    const graph=bakeGraph(map,{radius});
    const fine=time(()=>queryGraph(graph,from,to)),oracle=time(()=>queryGraph(graph,from,to,{heuristic:false}));
    const hierarchy=createHierarchy(graph),cold=time(()=>hierarchy.query(from,to)),warm=time(()=>hierarchy.query(from,to));
    const old=time(()=>gridRoute(map,radius===14?'contestant':'gladiator',{x:0,y:0,width:10,height:18},from,to,true));
    detours.push({radius,oldBoxMaxY:720,oldStatus:old.value?'complete':'no-route',oldMs:old.ms,fine:{ms:fine.ms,...result(fine.value)},oracle:{ms:oracle.ms,...result(oracle.value)},cold:{ms:cold.ms,...result(cold.value)},warm:{ms:warm.ms,...result(warm.value)},maxRouteY:Math.max(...fine.value.path.map(p=>p.y)),cache:hierarchy.stats()});
  }
  const doors=[];
  for(const radius of [14,25]) {
    const map=scene(384,192,[{x:180,y:0,w:10,h:60},{x:180,y:132,w:10,h:60}],[{x:185,y:96,w:10,h:72,open:true}]);
    const from={x:120,y:96},to={x:264,y:96},changes=[];
    for(const open of [true,false,true]) {
      map.gates[0].open=open;
      const baked=time(()=>bakeGraph(map,{radius}));
      const index=time(()=>createHierarchy(baked.value));
      const query=time(()=>index.value.query(from,to));
      changes.push({open,bakeMs:baked.ms,indexMs:index.ms,queryMs:query.ms,...result(query.value)});
    }
    doors.push({radius,changes,policy:'explicit full rebake; incremental invalidation not implemented'});
  }
  const interactionMap=scene(384,192,[{x:180,y:0,w:10,h:192,kind:'window'}]);
  const interactionGraph=bakeGraph(interactionMap),from={x:300,y:96},target={x:200,y:96},stand={x:218,y:96};
  return {passages,detours,doors,interaction:{target:result(queryGraph(interactionGraph,from,target)),stand:result(queryGraph(interactionGraph,from,stand)),handReach:reachClear(interactionMap,stand,target),acrossWindow:reachClear(interactionMap,{x:165,y:96},target)}};
}
