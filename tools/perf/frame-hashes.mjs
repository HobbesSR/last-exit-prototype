// Frame hashes of whole matches, for proving a behavior-preserving change leaves every frame byte-identical
// (#664, #641). Each line is one match: a sha256 over JSON.stringify of its first snapshot and every advance().
// Compare a run on the base commit with one on the branch:
//   node tools/perf/frame-hashes.mjs --out=base.txt   (then, on the branch)   --out=branch.txt
// --size=12x6 --contents=content-5,content-6,... --seeds=4217,11,902 --out=<file>
// --views also hashes every frame's projection for each player and the directed view, in a second digest.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';
import { liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { createMatchFor } from '../../server/match.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';

const args = cliArgs();
// Reuse the startup diagnostic's worker-prepared maps for exact comparisons,
// including real 36x18 matches, without regenerating the same source geometry.
const cache = args.has('maps-cache') ? deserialize(await readFile(args.get('maps-cache'))) : undefined;
const [zoneWidth, zoneHeight] = (args.get('size') ?? '12x6').split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) { console.error('unknown --size'); process.exit(2); }
const contents = (args.get('contents') ?? 'content-5,content-6,content-ammo-1,content-loot-1').split(',');
const seeds = (args.get('seeds') ?? '4217,11,902').split(',').map(Number);
const views = args.has('views');
if (cache && (cache.size !== `${zoneWidth}x${zoneHeight}` || contents.some(id => id !== cache.content)))
  throw new Error('map cache size/content mismatch');

const lines = [];
for (const id of contents) for (const seed of seeds) {
  const started = performance.now();
  let map;
  if (cache) {
    const entry = cache.maps[seed - cache.seed];
    if (!entry) throw new Error(`map cache has no seed ${seed}`);
    const cloned = structuredClone(entry);
    map = cloned.map;
    if (cloned.navigation) attachPortalGraph(map, cloned.navigation);
    for (const packed of cloned.tiles) adoptPackedTiles(map, packed);
  }
  const match = await createMatchFor(seed, size, map, contentById(id));
  const hash = createHash('sha256'), viewHash = createHash('sha256');
  const record = frame => {
    hash.update(JSON.stringify(frame));
    if (views) for (const viewer of [...frame.players.map(p => p.id), null]) viewHash.update(JSON.stringify(match.project(frame, viewer)));
  };
  record(match.snapshot());
  let frames = 1;
  while (match.phase === 'live') { record(match.advance()); frames++; }
  match.dispose();
  const line = `${id} seed=${seed} frames=${frames} ${hash.digest('hex')}${views ? ` views=${viewHash.digest('hex')}` : ''}`;
  lines.push(line);
  console.log(`${line} (${((performance.now() - started) / 1000).toFixed(0)} s)`);
}
if (args.has('out')) await writeFile(args.get('out'), lines.join('\n') + '\n');
