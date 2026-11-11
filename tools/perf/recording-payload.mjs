// Recording-only scaling probe: a tiled map may exceed physics admission limits.
// This does not run a tiled simulation or measure server ticks/capacity.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';
import { createReplayWriter } from '../../server/replay-writer.js';
import { createPhysicsMatch } from '../../server/match.js';
import { liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { publishItems } from '../../shared/simulation/ground-items.ts';
import { publishGates } from '../../shared/simulation/frame-gates.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { tileMap } from '../../tests/helpers/tile-map.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const args = cliArgs();
if (!args.has('maps-cache')) throw new Error('--maps-cache is required');
const cache = deserialize(await readFile(args.get('maps-cache')));
const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number);
const [columns, rows] = (args.get('tile') ?? '2x2').split('x').map(Number);
const ticks = Number(args.get('ticks') ?? 1200);
const create = args.has('baseline') ? (await import(pathToFileURL(resolve(args.get('baseline'))).href)).createReplayWriter : createReplayWriter;
const lock = await acquireMachineLock('bench');
const entry = structuredClone(cache.maps[0]);
if (entry.navigation) attachPortalGraph(entry.map, entry.navigation);
for (const packed of entry.tiles ?? []) adoptPackedTiles(entry.map, packed);
const match = await createPhysicsMatch(cache.seed, liveZoneSize({ zoneWidth, zoneHeight }), entry.map, contentById(cache.content));
const source = match.snapshot(), map = tileMap(entry.map, columns, rows);
match.dispose();
const frame = { ...source, items: publishItems({ map }), gates: publishGates({ map }) };
const archive = createHash('sha256');
const writer = create({ header: { id: 'payload-probe', seed: cache.seed, contentId: cache.content, map },
  output: new Writable({ write(chunk, _encoding, next) { archive.update(chunk); next(); } }),
  publish: async () => {}, onError: () => {} });
const times = [], cpuStarted = process.cpuUsage(), started = performance.now();
try {
  for (let tick = 0; tick < ticks; tick++) {
    const before = performance.now();
    if (!writer.append({ ...frame, tick }, [])) throw writer.failed ?? new Error('payload probe omitted a frame');
    times.push(performance.now() - before);
    while (writer.blocked) {
      if (writer.failed) throw writer.failed;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }
  const cpu = process.cpuUsage(cpuStarted), wallMs = performance.now() - started;
  const metadata = await writer.finish({ ticks: ticks - 1 });
  const sorted = [...times].sort((a, b) => a - b);
  const result = { note: 'Recording-only stable-list payload probe; no tiled physics simulation or server tick timing',
    seed: cache.seed, content: cache.content, node: process.version, size: `${zoneWidth * columns}x${zoneHeight * rows}`,
    items: frame.items.length, gates: frame.gates.length, frameBytes: Buffer.byteLength(JSON.stringify({ state: frame, commands: [] })), ticks,
    append: { mean: times.reduce((a, b) => a + b, 0) / times.length, p99: sorted[Math.floor(times.length * 0.99)], max: sorted.at(-1) },
    run: { wallMs, cpuMs: (cpu.user + cpu.system) / 1000 }, droppedFrames: writer.droppedFrames,
    archiveSha256: archive.digest('hex'), frameSha256: metadata.sha256 };
  if (args.has('out')) await writeFile(args.get('out'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { writer.abort(); lock.release(); }
