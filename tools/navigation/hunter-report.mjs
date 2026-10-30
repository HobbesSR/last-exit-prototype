// Compare how gladiator bots hunt under two or more contents (#681): whole bot-only live-chain matches, seed by seed.
// node tools/navigation/hunter-report.mjs [output.json]   CONTENTS=content-6,content-7  SIZES=12x6:4,24x12:2,36x18:2
// Per match: outcome (escaped, eliminated, kills by gladiators), how far gladiators travelled, how long they spent
// still (under STILL_RANGE in STILL_TICKS) while the match was live, the share of ticks a gladiator saw a contestant,
// and route-search work (expansions, repaths, portal plans) and the bot phase's cost. Runs sequentially under the bench lock.
import { writeFileSync } from 'node:fs';
import { generateLiveMap, liveZoneSize } from '../../map/live.ts';
import { step } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { prebuiltTiles } from '../../shared/simulation/bots.ts';
import { visibleTo } from '../../shared/simulation/visibility.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { createMatchFor } from '../../server/match.js';
import * as profiler from '../../shared/profiler.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const CONTENTS = (process.env.CONTENTS ?? 'content-6,content-7').split(',');
const SIZES = (process.env.SIZES ?? '12x6:4,24x12:2,36x18:2').split(',').map(entry => { const [size, seeds] = entry.split(':'); return { size, seeds: Number(seeds) }; });
const STILL_TICKS = 100, STILL_RANGE = 40;
const WORK = ['work.route.expansions', 'work.repath', 'work.route.portalPlans', 'sim.bots', 'sim.bots.plan'];

async function playMatch(size, seed, contentId) {
  const [zoneWidth, zoneHeight] = size.split('x').map(Number), zone = liveZoneSize({ zoneWidth, zoneHeight }), content = contentById(contentId);
  const map = generateLiveMap(seed, content, zone);
  for (const tiles of prebuiltTiles(map, content)) adoptPackedTiles(map, tiles);
  const match = await createMatchFor(seed, zone, map, content), s = match.diagnosticState;
  const gladiators = s.players.filter(p => p.role === 'gladiator'), anchor = new Map(gladiators.map(p => [p, { x: p.x, y: p.y, tick: 0 }]));
  let travelled = 0, still = 0, seeing = 0, active = 0, ticks = 0;
  const sums = Object.fromEntries(WORK.map(name => [name, 0]));
  profiler.reset(); profiler.enable(true);
  while (s.phase === 'live') {
    const before = new Map(gladiators.map(p => [p, { x: p.x, y: p.y }]));
    step(s); ticks++;
    const frame = profiler.frame() ?? {};
    for (const name of WORK) sums[name] += frame[name] ?? 0;
    for (const p of gladiators) {
      if (p.status !== 'active') { anchor.set(p, { x: p.x, y: p.y, tick: s.tick }); continue; }
      active++;
      const was = before.get(p);
      travelled += Math.hypot(p.x - was.x, p.y - was.y);
      if (s.players.some(t => t.role === 'contestant' && t.status === 'active' && visibleTo(s, p, t))) seeing++;
      const a = anchor.get(p);
      if (Math.hypot(p.x - a.x, p.y - a.y) >= STILL_RANGE) anchor.set(p, { x: p.x, y: p.y, tick: s.tick });
      else if (s.tick - a.tick >= STILL_TICKS) still++;
    }
  }
  profiler.enable(false);
  const contestants = s.players.filter(p => p.role === 'contestant');
  match.dispose();
  return {
    size, seed, content: contentId, ticks,
    escaped: contestants.filter(p => p.status === 'escaped').length,
    eliminated: contestants.filter(p => p.status === 'eliminated').length,
    gladiatorKills: gladiators.reduce((sum, p) => sum + (p.kills ?? 0), 0),
    travelledPerTick: travelled / Math.max(1, active), stillShare: still / Math.max(1, active), seeingShare: seeing / Math.max(1, active),
    perTick: Object.fromEntries(WORK.map(name => [name, sums[name] / Math.max(1, ticks)])),
  };
}

await acquireMachineLock('bench');
const results = [];
for (const { size, seeds } of SIZES) for (let seed = 1; seed <= seeds; seed++) for (const content of CONTENTS) {
  const row = await playMatch(size, seed, content);
  results.push(row);
  console.log(`${size} seed ${seed} ${content}: ${row.ticks} ticks, escaped ${row.escaped}, eliminated ${row.eliminated}, gladiator kills ${row.gladiatorKills},`
    + ` travel ${row.travelledPerTick.toFixed(2)}/tick, still ${(100 * row.stillShare).toFixed(1)}%, seeing ${(100 * row.seeingShare).toFixed(1)}%,`
    + ` expansions ${row.perTick['work.route.expansions'].toFixed(0)}/tick, sim.bots ${row.perTick['sim.bots'].toFixed(2)} ms`);
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ contents: CONTENTS, node: process.version, results }, null, 1));
