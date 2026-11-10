import { createMapGenerator } from '../../server/map-generator.js';
import { prebuiltTiles } from '../../shared/simulation/bots.ts';
import { portalGraphOf } from '../../shared/navigation/portal-graph.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { writeFile } from 'node:fs/promises';
import { serialize } from 'node:v8';
const generator = createMapGenerator();
try {
  const size = {zoneWidth:36, zoneHeight:18};
  const map = await generator.generate(4217, size);
  await writeFile('test-results/issue863/maps.bin', serialize({seed:4217, size:'36x18', content:defaultContent().id,
    maps:[{map,navigation:portalGraphOf(map),tiles:prebuiltTiles(map,defaultContent())}]}));
  console.log('Fresh main 6943fa1 production-worker map cached');
} finally { await generator.close(); }
