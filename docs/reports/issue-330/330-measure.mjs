import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildRegion } from '../map/micro/region-types.ts';
import { generate } from '../map/chain.ts';
const cellsOf=(w,h,keep=()=>true)=>{const a=[];for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(keep(x,y))a.push({x,y});return a};
const cases=[
 ['small-yard-6x6',cellsOf(6,6),[{id:'south',axis:'h',x:1,y:6,length:2},{id:'east',axis:'v',x:6,y:3,length:2}]],
 ['broad-yard-10x8',cellsOf(10,8),[{id:'north',axis:'h',x:1,y:0,length:3},{id:'east',axis:'v',x:10,y:2,length:4},{id:'south',axis:'h',x:4,y:8,length:2},{id:'west',axis:'v',x:0,y:5,length:2}]],
 ['concave-ell-12x12',cellsOf(12,12,(x,y)=>y<6||x<6),[{id:'east',axis:'v',x:12,y:2,length:2},{id:'south',axis:'h',x:1,y:12,length:3},{id:'corner',axis:'h',x:7,y:6,length:4}]],
 ['concave-ring-14x14',cellsOf(14,14,(x,y)=>x<5||x>=9||y<5||y>=9),[{id:'north',axis:'h',x:6,y:0,length:2},{id:'hole',axis:'v',x:9,y:6,length:2},{id:'west',axis:'v',x:0,y:10,length:3}]],
];
const out={commit:'3b54da0',directHut:[]};
for(const [name,cells,portals] of cases){const times=[],digests=[];for(let seed=1;seed<=5;seed++){const brief={id:name,seed,type:'hut',cellSize:40,cells,zones:[{tier:3,bonus:0,lootChance:.5,cells}],portals};const t=performance.now();const r=buildRegion(brief);times.push(+((performance.now()-t).toFixed(3)));digests.push({seed,structures:r.manifest.structures,obstacles:r.manifest.obstacles,gates:r.manifest.gates,loot:r.manifest.loot,building:r.elements[0]?`${r.elements[0].template.w/40}x${r.elements[0].template.h/40}`:'open',bytes:JSON.stringify(r).length,sha256:createHash('sha256').update(JSON.stringify(r)).digest('hex')});}out.directHut.push({name,cells:cells.length,portals:portals.length,timesMs:times,medianMs:[...times].sort((a,b)=>a-b)[2],results:digests});}
out.fullMaps=[];
for(const [w,h] of [[12,6],[24,12],[36,18]]){const seed=`issue330-before-${w}x${h}`;const t=performance.now();const map=generate(seed,{mode:'game',zoneWidth:w,zoneHeight:h});const elapsed=+(performance.now()-t).toFixed(3);const raw=JSON.stringify(map);out.fullMaps.push({seed,zoneWidth:w,zoneHeight:h,elapsedMs:elapsed,tiles:map.layout.slots.length,setPieces:map.layout.setPieces.length,results:map.results.length,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')});}
console.log(JSON.stringify(out,null,2));


