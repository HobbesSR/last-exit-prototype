import { readFile, writeFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';
import { contentById } from '../../shared/simulation/content.ts';
import { createMatchFor } from '../../server/match.js';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
const cache=deserialize(await readFile('test-results/issue863/maps.bin'));
const {map,navigation,tiles}=structuredClone(cache.maps[0]);
if(navigation) attachPortalGraph(map,navigation);
for(const packed of tiles) adoptPackedTiles(map,packed);
const match=await createMatchFor(4217,{zoneWidth:36,zoneHeight:18},map,contentById('content-6'));
const rows=[];
try {
  let before=new Set(match.diagnosticState.map.items.map(i=>i.id));
  for(let tick=1;tick<=32;tick++) {
    match.advance();
    const state=match.diagnosticState, after=new Set(state.map.items.map(i=>i.id));
    const removed=[...before].filter(id=>!after.has(id)),added=[...after].filter(id=>!before.has(id));
    if(removed.length||added.length) rows.push({tick,removed,added,lootEffects:state.effects.filter(e=>e.kind==='loot').length});
    before=after;
  }
} finally {match.dispose();}
await writeFile('docs/reports/issue-863/pickups.json',JSON.stringify(rows,null,2)+'\n');
console.log(JSON.stringify(rows));
