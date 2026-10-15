import { performance } from 'node:perf_hooks';
import { beginQuery } from './graph.mjs';
const memory = () => ({...process.memoryUsage(),maxRssBytes:process.resourceUsage().maxRSS*1024});
// A neutral implicit empty-world lattice uses public dimensions ONLY. It never
// reads truth passability, mask, obstacles, gates or components. No baked array.
export function neutralGraph(width,height,spacing,radius) {
  const cols=Math.floor(width/spacing),rows=Math.floor(height/spacing),count=cols*rows;
  const graph={width,height,spacing,radius,cols,rows,chunkSize:192,chunkCols:Math.ceil(width/192),chunkRows:Math.ceil(height/192)};
  graph.point=id=>({x:(id%cols+.5)*spacing,y:(Math.floor(id/cols)+.5)*spacing});
  graph.clear=(a,b)=>[a,b].every(p=>p.x>=radius&&p.y>=radius&&p.x<=width-radius&&p.y<=height-radius);
  graph.passable=new Proxy({length:count},{get:(target,key)=>key==='length'?count:graph.clear(graph.point(Number(key)),graph.point(Number(key)))?1:0});
  const dx=[1,1,0,-1,-1,-1,0,1],dy=[0,1,1,1,0,-1,-1,-1];
  graph.edges=new Proxy({}, {get:(_,key)=>{const id=Number(key),x=id%cols,y=Math.floor(id/cols);let bits=0;for(let d=0;d<8;d++){const nx=x+dx[d],ny=y+dy[d];if(nx>=0&&nx<cols&&ny>=0&&ny<rows&&graph.passable[ny*cols+nx])bits|=1<<d;}return bits;}});
  return graph;
}
export function speculative(width,height,spacing,radius,bots) {
  const graph=neutralGraph(width,height,spacing,radius), from={x:96,y:96},to={x:width-96,y:height*.73};
  const result={};
  for(const direct of [false,true]) {
    result[direct?'direct':'naiveSampled']=[];
    for(const temperature of ['cold','warm']) {
      const started=performance.now();
      const searches=Array.from({length:bots},()=>beginQuery(graph,from,to,{direct}));
      const slices=[];let answers=[];
      for(let round=0;round<8;round++) {
        const t=performance.now();answers=searches.map(search=>search.step(2000));
        slices.push({round:round+1,ms:performance.now()-t,expansions:answers.reduce((n,r)=>n+r.expansions,0),complete:answers.filter(r=>r.status==='complete').length,exhausted:answers.filter(r=>r.status==='budget-exhausted').length,privateBytes:searches.reduce((n,s)=>n+s.privateBytes,0),memory:memory()});
        if(answers.every(r=>r.status!=='budget-exhausted'))break;
      }
      result[direct?'direct':'naiveSampled'].push({temperature,aggregateMs:performance.now()-started,slices});
      global.gc?.();
    }
  }
  return result;
}
