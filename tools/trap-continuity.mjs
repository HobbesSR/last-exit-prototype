// #1245: the frozen fixture clears traps and its arenas place none, so it cannot witness the trap rules or the hazard
// areas. This runs the fixture's two arenas as bot matches with traps of all four kinds at every third ground item's spot
// (some without the optional keys a trap's rules create) and a hazard area at every eleventh, with the gladiators' views
// lagging so phase 5 reads the rewind frames. It hashes, every tick, the snapshot (private physics included), the c0, g0
// and spectator views, the trap records as JSON (so key order counts), the pending spawns and the pending impulses.
// Run --out in a pristine export of the commit before a change, then --compare on it from the change: equal hashes mean
// the change preserved what the trace reaches. Usage: node tools/trap-continuity.mjs --out FILE | --compare FILE
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { createGame, disposePhysics, step, snapshot, playerView } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { attachPortalGraph } from '../shared/navigation/portal-graph.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';

const args = process.argv.slice(2), at = flag => args[args.indexOf(flag) + 1];
if (!args.includes('--out') && !args.includes('--compare')) throw new Error('Use --out <path> or --compare <path>');
const fixture = deserialize(gunzipSync(readFileSync('tests/fixtures/behavior-physics-1.v8.gz')));
const KINDS = ['mine', 'turret', 'flame', 'spider'];
const MAX_TICKS = 4000;

async function trace(seed) {
  const arena = fixture.arenas[seed], map = structuredClone(arena.map);
  attachPortalGraph(map, structuredClone(arena.graph));
  map.traps = map.items.filter((_, i) => i % 3 === 0).map((item, i) => {
    const kind = KINDS[i % 4], trap = { id: `trap-${i}`, kind, x: item.x, y: item.y };
    if (kind === 'spider') Object.assign(trap, { homeX: item.x, homeY: item.y });
    if (kind !== 'mine' && i % 3) trap.heading = (i * 0.7) % 6;
    if (kind === 'flame') trap.offset = i * 7;
    if (i % 5) trap.cooldown = 0;
    return trap;
  });
  map.hazards = map.items.filter((_, i) => i % 11 === 1).map(item => ({ x: item.x - 120, y: item.y - 120, w: 240, h: 240 }));
  const counts = { traps: map.traps.length, hazards: map.hazards.length, shock: 0, grapple: 0, turretShots: 0, eliminated: 0 };
  const s = await createGame(seed, map, contentById('content-7'));
  try {
    for (const p of s.players) if (p.role === 'gladiator') p.viewLagTicks = 3;
    const r = physicsRuntime(s), effects = new Set(), events = new Set(), chunks = [];
    let digest = createHash('sha256');
    while (s.phase === 'live' && s.tick < MAX_TICKS) {
      step(s);
      const frame = snapshot(s);
      for (const record of [frame, s.traps, r.pendingSpawns, r.pendingImpulses]) digest.update(JSON.stringify(record));
      for (const id of ['c0', 'g0', 'spectator']) digest.update(JSON.stringify(playerView(s, frame, id)));
      for (const e of s.effects) if (!effects.has(e.id)) { effects.add(e.id); if (e.kind === 'shock') counts.shock++; if (e.kind === 'grapple') counts.grapple++; }
      for (const e of s.events) if (!events.has(e.id)) { events.add(e.id); if (e.kind === 'eliminated') counts.eliminated++; }
      counts.turretShots += r.pendingSpawns.filter(b => b.trap).length;
      if (s.tick % 250 === 0 || s.phase !== 'live') { chunks.push({ tick: s.tick, hash: digest.digest('hex') }); digest = createHash('sha256'); }
    }
    return { ticks: s.tick, phase: s.phase, counts, chunks };
  } finally { disposePhysics(s); }
}

const result = {};
for (const seed of [9, 4217]) result[seed] = await trace(seed);
if (args.includes('--out')) {
  writeFileSync(at('--out'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([seed, r]) => [seed, { ticks: r.ticks, ...r.counts }]))));
} else {
  const expected = JSON.parse(readFileSync(at('--compare'), 'utf8'));
  // Chunk for chunk, and the same count, so a trace that ran longer or shorter differs too (review 987).
  const differ = Object.keys(expected).flatMap(seed => [
    ...expected[seed].chunks.filter((chunk, i) => chunk.hash !== result[seed]?.chunks[i]?.hash).map(chunk => `seed ${seed} by tick ${chunk.tick}`),
    ...(expected[seed].chunks.length === result[seed]?.chunks.length ? [] : [`seed ${seed}'s chunk count`])]);
  console.log(differ.length ? `differs: ${differ.join(', ')}` : 'every hash matches');
  if (differ.length) process.exitCode = 1;
}
