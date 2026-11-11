// Exact whole-match archive comparison for storage changes (#728). Not a timing benchmark:
// both writers receive the same authoritative frame, and drain outside simulation.
// --baseline=<archived replay-writer module> --maps-cache=<room-startup cache> --out=<json>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { deserialize } from 'node:v8';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReplayWriter } from '../../server/replay-writer.js';
import { createPhysicsMatch } from '../../server/match.js';
import { liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { SCHEMA, minimumReaderForMatch } from '../../shared/recording.ts';
import { cliArgs } from '../../tests/helpers/args.js';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const args = cliArgs();
if (!args.has('baseline') || !args.has('maps-cache')) throw new Error('--baseline and --maps-cache are required');
const baseline = await import(pathToFileURL(resolve(args.get('baseline'))).href);
const cache = deserialize(await readFile(args.get('maps-cache')));
const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) throw new Error('unsupported cache size');
const lock = await acquireMachineLock('bench');
const entry = structuredClone(cache.maps[0]), map = entry.map;
if (entry.navigation) attachPortalGraph(map, entry.navigation);
for (const packed of entry.tiles ?? []) adoptPackedTiles(map, packed);
const match = await createPhysicsMatch(cache.seed, size, map, contentById(cache.content));
const header = { id: 'recording-comparison', seed: cache.seed, createdAt: 0, hz: 20,
  version: match.version, contentId: match.contentId, schema: SCHEMA,
  minSchema: minimumReaderForMatch(map, match.hasPhysics === true), map: match.map() };
const digests = [createHash('sha256'), createHash('sha256')], bytes = [0, 0];
// The changed writer receives the prepared map that production room startup uses;
// the baseline receives the existing detached-map header. Both must be identical.
const preparedHeader = { ...header, map: match.payloadMap('recording') };
assert.equal(JSON.stringify(preparedHeader), JSON.stringify(header));
const writers = [baseline.createReplayWriter, createReplayWriter].map((create, i) => create({ header: i ? preparedHeader : header,
  output: new Writable({ write(chunk, _encoding, next) { digests[i].update(chunk); bytes[i] += chunk.length; next(); } }),
  publish: async () => {}, onError: () => {} }));
const frames = createHash('sha256'), snapshots = createHash('sha256');
let count = 0;
try {
  do {
    const state = count ? match.advance() : match.snapshot();
    snapshots.update(JSON.stringify(state));
    frames.update(JSON.stringify({ state, commands: [] }) + '\n');
    for (const writer of writers) assert.equal(writer.append(state, []), true, 'healthy comparison must retain every frame');
    while (writers.some(writer => writer.blocked)) {
      for (const writer of writers) if (writer.failed) throw writer.failed;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    count++;
  } while (match.phase === 'live');
  const metadata = await Promise.all(writers.map(writer => writer.finish({ ticks: match.tick })));
  const sha256 = digests.map(hash => hash.digest('hex'));
  assert.deepEqual(metadata[0], metadata[1]);
  assert.equal(metadata[0].sha256, frames.digest('hex'));
  assert.equal(sha256[0], sha256[1], 'entire gzip archive must be byte identical');
  assert.equal(bytes[0], bytes[1]);
  assert.ok(writers.every(writer => writer.droppedFrames === 0));
  const result = { seed: cache.seed, size: cache.size, content: cache.content, node: process.version,
    frames: count, snapshotSha256: snapshots.digest('hex'), archiveSha256: sha256[0], archiveBytes: bytes[0], metadata: metadata[0] };
  if (args.has('out')) await writeFile(args.get('out'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { for (const writer of writers) writer.abort(); match.dispose(); lock.release(); }
