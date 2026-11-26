// Recapture the frozen characterization fixture, `tests/fixtures/behavior-physics-1.v8.gz`, at a named checkpoint
// (tests/fixtures README, "Physics behavior baseline"). A recapture is a decision, never a way to make a refactor pass
// (docs/31 "The frozen fixture"): run it only in the PR that lands a decided change, with its continuity evidence.
// The stored arenas and portal graphs are carried forward, so generation never moves the traces. It prints the digests
// the README records. `--check` recomputes and compares without writing.
// Usage: node tools/capture-physics-fixture.mjs --checkpoint=<name> [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CONTENT, botTrace, scriptedTrace, seeds } from '../tests/characterization-physics-scenarios.js';
import { PHYSICS_VERSION } from '../shared/simulation.ts';

const FILE = 'tests/fixtures/behavior-physics-1.v8.gz';
const checkpoint = process.argv.find(a => a.startsWith('--checkpoint='))?.split('=')[1];
if (!checkpoint) throw new Error('Name the checkpoint: --checkpoint=<name>');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const previous = deserialize(gunzipSync(readFileSync(FILE)));
const arenas = previous.arenas;
const bots = {};
for (const seed of seeds) bots[seed] = await botTrace(seed, arenas[seed]);
const scripted = JSON.parse(JSON.stringify(await scriptedTrace(arenas[4217])));
const fixture = { checkpoint, version: PHYSICS_VERSION, content: CONTENT, arenas, bots, scripted };

const gz = gzipSync(serialize(fixture));
console.log(`checkpoint ${checkpoint}, ${PHYSICS_VERSION}, ${CONTENT}`);
console.log(`arenas serialized SHA-256 ${sha(serialize(arenas))}`);
console.log(`scripted JSON SHA-256 ${sha(JSON.stringify(scripted))}`);
for (const seed of seeds) console.log(`seed ${seed}: ${bots[seed].at(-1).tick} ticks`);
if (process.argv.includes('--check')) {
  const same = JSON.stringify({ bots: previous.bots, scripted: previous.scripted }) === JSON.stringify({ bots, scripted });
  console.log(same ? 'the stored traces match' : 'the stored traces differ');
  process.exitCode = same ? 0 : 1;
} else {
  writeFileSync(FILE, gz);
  console.log(`gzip SHA-256 ${sha(gz)}`);
}
