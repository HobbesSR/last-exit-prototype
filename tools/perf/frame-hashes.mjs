// Frame hashes of whole matches, for proving a behavior-preserving change leaves every frame byte-identical
// (#664, #641). Each line is one match: a sha256 over JSON.stringify of its first snapshot and every advance().
// Compare a run on the base commit with one on the branch:
//   node tools/perf/frame-hashes.mjs --out=base.txt   (then, on the branch)   --out=branch.txt
// --size=12x6 --contents=content-5,content-6,... --seeds=4217,11,902 --out=<file>
// --views also hashes every frame's projection for each player and the directed view, in a second digest.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { createMatchFor } from '../../server/match.js';
import { cliArgs } from '../../tests/helpers/args.js';

const args = cliArgs();
const [zoneWidth, zoneHeight] = (args.get('size') ?? '12x6').split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) { console.error('unknown --size'); process.exit(2); }
const contents = (args.get('contents') ?? 'content-5,content-6,content-ammo-1,content-loot-1').split(',');
const seeds = (args.get('seeds') ?? '4217,11,902').split(',').map(Number);
const views = args.has('views');

const lines = [];
for (const id of contents) for (const seed of seeds) {
  const started = performance.now();
  const match = await createMatchFor(seed, size, undefined, contentById(id));
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
