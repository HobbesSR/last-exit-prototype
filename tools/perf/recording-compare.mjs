// Whole-match recording witness (#901, 26). Not a timing benchmark: records one whole cached match through
// the production writer and worker, reads the archive back with the shared reader, and fails unless every
// rebuilt frame is byte for byte the authoritative frame's JSON, every checkpoint holds and the published
// digest covers the stored lines. Run it when the frame encoding changes; it stays out of the test tiers.
// --maps-cache=<room-startup cache> [--keyframe-every=N] [--out=<json>]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { deserialize } from 'node:v8';
import { createReplayWriter } from '../../server/replay-writer.js';
import { createMatch } from '../../server/match.js';
import { liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { SCHEMA, minimumReaderForMatch } from '../../shared/recording.ts';
import { readArchive, sha256, storedDigest, storedLines } from '../../tests/helpers/recordings.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const args = cliArgs();
if (!args.has('maps-cache')) throw new Error('--maps-cache is required');
const cache = deserialize(await readFile(args.get('maps-cache')));
const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) throw new Error('unsupported cache size');
const lock = await acquireMachineLock('bench', { mode: 'shared' });
const entry = structuredClone(cache.maps[0]), map = entry.map;
if (entry.navigation) attachPortalGraph(map, entry.navigation);
for (const packed of entry.tiles ?? []) adoptPackedTiles(map, packed);
const match = await createMatch(cache.seed, size, map, contentById(cache.content));
const header = { id: 'recording-witness', seed: cache.seed, createdAt: 0, hz: 20,
  version: match.version, contentId: match.contentId, schema: SCHEMA,
  minSchema: minimumReaderForMatch(), map: match.payloadMap('recording') };
const chunks = [];
const writer = createReplayWriter({ header, publish: async () => {}, onError: () => {},
  ...(args.has('keyframe-every') ? { keyframeEvery: Number(args.get('keyframe-every')) } : {}),
  output: new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } }) });
// Each authoritative frame's full line, hashed as it is offered: the reference the rebuilt frames must equal.
const expected = [];
let fullBytes = 0;
try {
  do {
    const state = expected.length ? match.advance() : match.snapshot();
    const line = JSON.stringify({ state, commands: [] });
    expected.push(sha256(line)); fullBytes += Buffer.byteLength(line) + 1;
    assert.equal(writer.append(state, []), true, 'a healthy witness must retain every frame');
    while (writer.blocked) {
      if (writer.failed) throw writer.failed;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  } while (match.phase === 'live');
  const meta = await writer.finish({ ticks: match.tick });
  const recording = readArchive(chunks), lines = storedLines(chunks);
  assert.equal(recording.frames.length, expected.length);
  recording.frames.forEach((frame, i) => assert.equal(sha256(JSON.stringify(frame)), expected[i], `frame ${i} rebuilds exactly`));
  assert.equal(meta.sha256, storedDigest(chunks));
  assert.equal(writer.droppedFrames, 0);
  const archiveBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const storedBytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  const result = { seed: cache.seed, size: cache.size, content: cache.content, node: process.version,
    frames: expected.length, keyframes: lines.filter(line => line.startsWith('{"state":')).length,
    checkpoints: recording.checkpoints.length, archiveBytes, storedBytes, fullFrameBytes: fullBytes,
    storedShare: storedBytes / fullBytes, archiveSha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), metadata: meta };
  if (args.has('out')) await writeFile(args.get('out'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { writer.abort(); match.dispose(); lock.release(); }
