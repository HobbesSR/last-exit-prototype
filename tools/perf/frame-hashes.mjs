// Frame hashes of whole matches, for proving a behavior-preserving change leaves every frame byte-identical
// (#664, #641). Each line is one match: a sha256 over JSON.stringify of its first snapshot and every advance().
// Compare a run on the base commit with one on the branch:
//   node tools/perf/frame-hashes.mjs --out=base.txt   (then, on the branch)   --out=branch.txt
// --size=12x6 --contents=content-6,content-7,... --seeds=4217,11,902 --out=<file>
// --views also hashes every frame's projection for each player and the directed view, in a second digest.
// --payloads exercises recording/live/delayed map queries and hashes their JSON at
// tick 0, 600, 1200 and match end. --root=PATH selects archived match/cache modules.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';
import { liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { stringifyWithMap } from '../../server/map-payload.js';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliArgs } from '../../tests/helpers/args.js';

const args = cliArgs();
const root = resolve(args.get('root') ?? fileURLToPath(new URL('../../', import.meta.url)));
const fromRoot = file => import(pathToFileURL(resolve(root, file)).href);
const { createPhysicsMatch } = await fromRoot('server/match.js');
const { attachPortalGraph } = await fromRoot('shared/navigation/portal-graph.ts');
const { adoptPackedTiles } = await fromRoot('shared/free-space.ts');
// Reuse the startup diagnostic's worker-prepared maps for exact comparisons,
// including real 36x18 matches, without regenerating the same source geometry.
const cache = args.has('maps-cache') ? deserialize(await readFile(args.get('maps-cache'))) : undefined;
const [zoneWidth, zoneHeight] = (args.get('size') ?? '12x6').split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) { console.error('unknown --size'); process.exit(2); }
const contents = (args.get('contents') ?? 'content-6,content-7,content-ammo-1,content-loot-1').split(',');
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
  const match = await createPhysicsMatch(seed, size, map, contentById(id));
  const hash = createHash('sha256'), viewHash = createHash('sha256'), mapHash = createHash('sha256');
  let previousMapFrame;
  const maps = frame => {
    for (const kind of ['recording', 'live', 'spectator'])
      mapHash.update(stringifyWithMap({ map: match.payloadMap(kind, previousMapFrame ?? frame) }));
    previousMapFrame = frame;
  };
  // Recording start publishes its source map before capturing the first frame.
  if (args.has('payloads')) {
    mapHash.update(stringifyWithMap({ map: match.payloadMap('recording') }));
  }
  const record = frame => {
    hash.update(JSON.stringify(frame));
    if (views) for (const viewer of [...frame.players.map(p => p.id), null]) viewHash.update(JSON.stringify(match.project(frame, viewer)));
    if (args.has('payloads') && ([0, 600, 1200].includes(frame.tick) || match.phase !== 'live')) maps(frame);
  };
  record(match.snapshot());
  let frames = 1;
  while (match.phase === 'live') { record(match.advance()); frames++; }
  match.dispose();
  const line = `${id} seed=${seed} frames=${frames} ${hash.digest('hex')}${views ? ` views=${viewHash.digest('hex')}` : ''}${args.has('payloads') ? ` maps=${mapHash.digest('hex')}` : ''}`;
  lines.push(line);
  console.log(`${line} (${((performance.now() - started) / 1000).toFixed(0)} s)`);
}
if (args.has('out')) await writeFile(args.get('out'), lines.join('\n') + '\n');
