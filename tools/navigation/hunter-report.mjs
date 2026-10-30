// Compare how gladiator bots hunt under two or more contents (#681): whole bot-only live-chain matches, seed by seed.
// node tools/navigation/hunter-report.mjs [output.json]   CONTENTS=content-6,content-7  SIZES=12x6:4,24x12:2,36x18:2  MAX_TICKS=
// For iterating, one map and part of a match take about a minute: SIZES=12x6:1@3 MAX_TICKS=1500 (seed 3 only, first 1,500 ticks).
// Per match: outcome (escaped, eliminated, kills by gladiators), how far gladiators travelled, how long they spent
// still (under STILL_RANGE in STILL_TICKS) while the match was live, the share of ticks a gladiator saw a contestant
// and the share it held a heard-gunfire cue (#684), how far each contestant shot was from the nearest gladiator (the
// distances hearing ranges are set against), how many cues a gladiator later came within REACHED of (and, of those heard from beyond FAR, how many were followed by seeing a contestant within FOUND_WITHIN, and how soon), how fast contestants
// close on the newest cue they hear (opportunists and the rest apart, #685), and route-search work (expansions, repaths, portal plans) and the bot phase's cost. Runs sequentially under the bench lock.
import { writeFileSync } from 'node:fs';
import { generateLiveMap, liveZoneSize } from '../../map/live.ts';
import { step } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { isOpportunistic, prebuiltTiles } from '../../shared/simulation/bots.ts';
import { visibleTo } from '../../shared/simulation/visibility.ts';
import { heardBy } from '../../shared/simulation/hearing.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { createMatchFor } from '../../server/match.js';
import * as profiler from '../../shared/profiler.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const CONTENTS = (process.env.CONTENTS ?? 'content-6,content-7').split(',');
// `size:n` plays seeds 1..n; `size:n@first` plays n seeds from `first`.
const SIZES = (process.env.SIZES ?? '12x6:4,24x12:2,36x18:2').split(',').map(entry => {
  const [size, spec] = entry.split(':'), [seeds, first = '1'] = spec.split('@');
  return { size, seeds: Number(seeds), first: Number(first) };
});
const MAX_TICKS = Number(process.env.MAX_TICKS) || Infinity;
const STILL_TICKS = 100, STILL_RANGE = 40, REACHED = 400, FAR = 1500, FOUND_WITHIN = 60 * 20;
const WORK = ['work.route.expansions', 'work.repath', 'work.route.portalPlans', 'sim.bots', 'sim.bots.plan'];

async function playMatch(size, seed, contentId) {
  const [zoneWidth, zoneHeight] = size.split('x').map(Number), zone = liveZoneSize({ zoneWidth, zoneHeight }), content = contentById(contentId);
  const map = generateLiveMap(seed, content, zone);
  for (const tiles of prebuiltTiles(map, content)) adoptPackedTiles(map, tiles);
  const match = await createMatchFor(seed, zone, map, content), s = match.diagnosticState;
  const gladiators = s.players.filter(p => p.role === 'gladiator'), anchor = new Map(gladiators.map(p => [p, { x: p.x, y: p.y, tick: 0 }]));
  let travelled = 0, still = 0, seeing = 0, hearing = 0, active = 0, ticks = 0, lastShot = s.serial, reached = 0;
  const shotDistances = [], arrivals = [], heardCues = new Map(gladiators.map(p => [p, new Map()]));
  const contestants = s.players.filter(p => p.role === 'contestant'), closing = { opportunist: [0, 0], cautious: [0, 0] };
  const sums = Object.fromEntries(WORK.map(name => [name, 0]));
  profiler.reset(); profiler.enable(true);
  while (s.phase === 'live' && ticks < MAX_TICKS) {
    const before = new Map(gladiators.map(p => [p, { x: p.x, y: p.y }]));
    const listening = contestants.filter(p => p.status === 'active').map(p => ({ p, cue: heardBy(p, s.tick).at(-1), x: p.x, y: p.y })).filter(entry => entry.cue);
    step(s); ticks++;
    const frame = profiler.frame() ?? {};
    for (const name of WORK) sums[name] += frame[name] ?? 0;
    for (const { p, cue, x, y } of listening) {
      if (p.status !== 'active') continue;
      const sum = closing[isOpportunistic(p) ? 'opportunist' : 'cautious'];
      sum[0] += Math.hypot(x - cue.x, y - cue.y) - Math.hypot(p.x - cue.x, p.y - cue.y); sum[1]++;
    }
    // A shot is a contestant's new projectiles in one tick, however many pellets; measured from where the shooter stands.
    const shooters = new Set(s.projectiles.filter(q => q.id >= lastShot && !q.trap).map(q => q.owner)); lastShot = s.serial;
    for (const id of shooters) {
      const shooter = s.players.find(p => p.id === id);
      if (shooter?.role !== 'contestant') continue;
      const near = gladiators.filter(p => p.status === 'active').map(p => Math.hypot(p.x - shooter.x, p.y - shooter.y));
      if (near.length) shotDistances.push(Math.min(...near));
    }
    for (const p of gladiators) {
      if (p.status !== 'active') { anchor.set(p, { x: p.x, y: p.y, tick: s.tick }); continue; }
      active++;
      const was = before.get(p);
      travelled += Math.hypot(p.x - was.x, p.y - was.y);
      const sees = s.players.some(t => t.role === 'contestant' && t.status === 'active' && visibleTo(s, p, t));
      if (sees) seeing++;
      const cues = heardBy(p, s.tick), held = heardCues.get(p);
      if (cues.length) hearing++;
      for (const cue of cues) if (!held.has(`${cue.x},${cue.y},${cue.tick}`)) held.set(`${cue.x},${cue.y},${cue.tick}`, { ...cue, reached: false, found: false, far: Math.hypot(p.x - cue.x, p.y - cue.y) > FAR });
      for (const cue of held.values()) if (!cue.reached && Math.hypot(p.x - cue.x, p.y - cue.y) < REACHED) { cue.reached = true; reached++; }
      // A shot heard from afar has led somewhere when the gladiator next sees a contestant within FOUND_WITHIN of it.
      if (sees) for (const cue of held.values()) if (cue.far && !cue.found && s.tick - cue.tick <= FOUND_WITHIN) { cue.found = true; arrivals.push(s.tick - cue.tick); }
      const a = anchor.get(p);
      if (Math.hypot(p.x - a.x, p.y - a.y) >= STILL_RANGE) anchor.set(p, { x: p.x, y: p.y, tick: s.tick });
      else if (s.tick - a.tick >= STILL_TICKS) still++;
    }
  }
  profiler.enable(false);
  match.dispose();
  return {
    size, seed, content: contentId, ticks,
    escaped: contestants.filter(p => p.status === 'escaped').length,
    eliminated: contestants.filter(p => p.status === 'eliminated').length,
    gladiatorKills: gladiators.reduce((sum, p) => sum + (p.kills ?? 0), 0),
    travelledPerTick: travelled / Math.max(1, active), stillShare: still / Math.max(1, active), seeingShare: seeing / Math.max(1, active),
    hearingShare: hearing / Math.max(1, active), shots: shotDistances.length, shotDistance: quantiles(shotDistances),
    cuesHeard: [...heardCues.values()].reduce((sum, held) => sum + held.size, 0), cuesReached: reached, farCues: [...heardCues.values()].reduce((sum, held) => sum + [...held.values()].filter(cue => cue.far).length, 0), farFound: arrivals.length, foundTicks: quantiles(arrivals),
    closingPerTick: Object.fromEntries(Object.entries(closing).map(([kind, [sum, n]]) => [kind, n ? sum / n : null])), listeningTicks: closing.opportunist[1] + closing.cautious[1],
    perTick: Object.fromEntries(WORK.map(name => [name, sums[name] / Math.max(1, ticks)])),
  };
}

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b), at = q => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : null;
  return { p25: at(0.25), p50: at(0.5), p75: at(0.75) };
}

// The lock keeps the cost columns comparable. A capped run is for behaviour, so it skips the lock; its costs are not comparable.
if (MAX_TICKS === Infinity) await acquireMachineLock('bench');
else console.log(`Capped at ${MAX_TICKS} ticks, without the bench lock: behaviour only, costs not comparable.`);
const results = [];
for (const { size, seeds, first } of SIZES) for (let seed = first; seed < first + seeds; seed++) for (const content of CONTENTS) {
  const row = await playMatch(size, seed, content);
  results.push(row);
  console.log(`${size} seed ${seed} ${content}: ${row.ticks} ticks, escaped ${row.escaped}, eliminated ${row.eliminated}, gladiator kills ${row.gladiatorKills},`
    + ` travel ${row.travelledPerTick.toFixed(2)}/tick, still ${(100 * row.stillShare).toFixed(1)}%, seeing ${(100 * row.seeingShare).toFixed(1)}%,`
    + ` hearing ${(100 * row.hearingShare).toFixed(1)}%, shots ${row.shots} (nearest gladiator p25/50/75 ${row.shotDistance.p25}/${row.shotDistance.p50}/${row.shotDistance.p75}),`
    + ` cues ${row.cuesHeard} reached ${row.cuesReached}, heard from beyond ${FAR} ${row.farCues}, then saw a contestant within ${FOUND_WITHIN / 20} s ${row.farFound} (ticks p25/50/75 ${row.foundTicks.p25}/${row.foundTicks.p50}/${row.foundTicks.p75}), closing opp/caut ${row.closingPerTick.opportunist?.toFixed(2)}/${row.closingPerTick.cautious?.toFixed(2)} per tick,`
    + ` expansions ${row.perTick['work.route.expansions'].toFixed(0)}/tick, sim.bots ${row.perTick['sim.bots'].toFixed(2)} ms`);
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ contents: CONTENTS, node: process.version, results }, null, 1));
