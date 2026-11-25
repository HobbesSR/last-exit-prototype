// #1344: frames built from the core's output instead of the `Game` mirror. The authority must not move, and the
// frames and views must keep their values. For both of the frozen fixture's bot matches and its scripted scene, this
// hashes, per 100-tick chunk:
// - `core`: the core's opening snapshot, every completed tick (inbound queue, changes, discontinuities, discovery)
//   and its whole snapshot every 100th tick, serialized as they are;
// - `frame`: each private frame with sorted keys, less the receive boundary's internals that the mirror leaked into
//   frames (`DROPPED`);
// - `views`: the `c0`, `g0` and directed projections of each frame, with sorted keys.
// Run --out in a pristine export of the commit before the change, then --compare in the change. Equal `core`
// hashes mean the simulation is untouched; equal `frame` and `views` hashes mean the frames differ from the old
// only in key order and the dropped fields. The first unequal chunk names where to look.
// Read-only toward fixtures. Usage: node tools/frame-continuity.mjs --out FILE | --compare FILE
import { readFileSync, writeFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createGame, disposePhysics, playerView, snapshot } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { attachPortalGraph } from '../shared/navigation/portal-graph.ts';
import { content, scriptedTrace, seeds } from '../tests/characterization-physics-scenarios.js';

const args = process.argv.slice(2), at = flag => args[args.indexOf(flag) + 1];
if (!args.includes('--out') && !args.includes('--compare')) throw new Error('Use --out <path> or --compare <path>');
const fixture = deserialize(gunzipSync(readFileSync('tests/fixtures/behavior-physics-1.v8.gz')));
const VIEWERS = ['c0', 'g0', 'spectator'];
/** What the old frames carried from the receive boundary's per-player state, which no reader of a frame reads. */
const DROPPED = ['receivedSeq', 'inputQueue', 'inputTick'];

const canonical = value => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function frameText(frame) {
  const players = frame.players.map(p => { const copy = { ...p }; for (const key of DROPPED) delete copy[key]; return copy; });
  return canonical({ ...frame, players });
}
const mapOf = arena => { const map = structuredClone(arena.map); if (arena.graph) attachPortalGraph(map, structuredClone(arena.graph)); return map; };

function chunker() {
  const chunks = [];
  let core = createHash('sha256'), frame = createHash('sha256'), views = createHash('sha256');
  return {
    core: text => core.update(text), frame: text => frame.update(text), views: text => views.update(text),
    cut(tick) {
      chunks.push({ tick, core: core.digest('hex'), frame: frame.digest('hex'), views: views.digest('hex') });
      core = createHash('sha256'); frame = createHash('sha256'); views = createHash('sha256');
    },
    chunks,
  };
}

async function botMatch(seed) {
  const s = await createGame(seed, mapOf(fixture.arenas[seed]), content()), c = chunker();
  try {
    const { match } = startGame(s);
    c.core(JSON.stringify(match.snapshot()));
    while (s.phase === 'live') {
      const completed = stepGame(s), frame = snapshot(s);
      c.core(JSON.stringify(completed));
      if (s.tick % 100 === 0) c.core(JSON.stringify(match.snapshot()));
      c.frame(frameText(frame));
      for (const id of VIEWERS) c.views(canonical(playerView(s, frame, id)));
      if (s.tick % 100 === 0 || s.phase !== 'live') c.cut(s.tick);
    }
    return c.chunks;
  } finally { disposePhysics(s); }
}

async function scripted() {
  const c = chunker();
  for (const { label, frame, core, views } of await scriptedTrace(fixture.arenas[4217])) {
    c.core(JSON.stringify(core)); c.frame(frameText(frame)); c.views(canonical(views)); c.cut(label);
  }
  return c.chunks;
}

const started = performance.now(), result = { scripted: await scripted() };
for (const seed of seeds) result[`bots-${seed}`] = await botMatch(seed);
console.log(`traced in ${((performance.now() - started) / 1000).toFixed(1)} s`);

if (args.includes('--out')) { writeFileSync(at('--out'), `${JSON.stringify(result, null, 1)}\n`); console.log(`wrote ${at('--out')}`); }
else {
  const before = JSON.parse(readFileSync(at('--compare'), 'utf8'));
  let equal = true;
  for (const [name, chunks] of Object.entries(result)) {
    const old = before[name] ?? [];
    if (old.length !== chunks.length) { equal = false; console.log(`${name}: ${old.length} chunks before, ${chunks.length} now`); }
    for (const kind of ['core', 'frame', 'views']) {
      const first = chunks.find((chunk, i) => old[i]?.[kind] !== chunk[kind] || old[i]?.tick !== chunk.tick);
      if (first) { equal = false; console.log(`${name}: ${kind} first differs at chunk ending ${first.tick}`); }
      else console.log(`${name}: ${kind} equal over ${chunks.length} chunks`);
    }
  }
  if (!equal) process.exitCode = 1;
}
