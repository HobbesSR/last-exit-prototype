// Per-tick change fraction (#655 stage 0): how much of each published frame differs from the previous tick's frame.
// Runs one bot room as the server does and compares consecutive snapshots entity by entity, keyed by id. The answer
// decides whether structurally shared frames pay: their copy cost follows the entities that change, not those that exist.
// A value comparison is a lower bound on what copy-on-write would replace: a step that writes an equal value still
// touches the entity unless the write is skipped.
//
// --size=12x6 --content=<id> --seed --ticks --out=<file.json>
import { writeFile } from 'node:fs/promises';
import { DURATION } from '../shared/simulation.ts';
import { generateLiveMap, liveZoneSize, zoneSizeName, DEFAULT_LIVE_ZONE_SIZE, LIVE_ZONE_SIZES } from '../map/live.ts';
import { contentById, CONTENT_ID } from '../shared/simulation/content.ts';
import { prebuiltTiles } from '../shared/simulation/bots.ts';
import { adoptPackedTiles } from '../shared/free-space.ts';
import { createMatchFor } from '../server/match.js';
import { cliArgs } from './helpers/args.js';

const args = cliArgs();
const seed = Number(args.get('seed') ?? 4217), ticks = Number(args.get('ticks') ?? DURATION);
const [zoneWidth, zoneHeight] = (args.get('size') ?? zoneSizeName(DEFAULT_LIVE_ZONE_SIZE)).split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) { console.error(`--size must be one of ${LIVE_ZONE_SIZES.map(zoneSizeName).join(', ')}`); process.exit(2); }
const content = contentById(args.get('content') ?? CONTENT_ID);

const map = generateLiveMap(seed, content, size);
for (const packed of prebuiltTiles(map, content)) adoptPackedTiles(map, packed);
const match = await createMatchFor(seed, size, map, content);

// Each collection of the frame, as entries keyed by their identity.
const collections = {
  players: f => f.players, items: f => f.items, gates: f => f.gates, traps: f => f.traps,
  projectiles: f => f.projectiles, effects: f => f.effects, bodies: f => f.bodies, tethers: f => f.tethers,
  worldBodies: f => f.physics?.world.bodies, constraints: f => f.physics?.world.constraints,
};
const keyOf = (entry, index) => entry.id ?? entry.spec?.id ?? (entry.a !== undefined ? `${entry.a}|${entry.b}` : index);
const keyed = list => new Map((list ?? []).map((entry, index) => [keyOf(entry, index), entry]));
const stats = Object.fromEntries(Object.keys(collections).map(name => [name,
  { size: [], changed: [], added: [], removed: [], everChanged: new Set(), seen: new Set(), fields: {} }]));

let previous = Object.fromEntries(Object.entries(collections).map(([name, pick]) => [name, keyed(pick(match.snapshot()))]));
for (let tick = 0; tick < ticks && match.phase === 'live'; tick++) {
  const frame = match.advance();
  for (const [name, pick] of Object.entries(collections)) {
    const current = keyed(pick(frame)), before = previous[name], s = stats[name];
    let changed = 0, added = 0;
    for (const [key, entry] of current) {
      s.seen.add(key);
      const old = before.get(key);
      if (!old) { added++; continue; }
      if (JSON.stringify(old) === JSON.stringify(entry)) continue;
      changed++; s.everChanged.add(key);
      for (const field of new Set([...Object.keys(old), ...Object.keys(entry)]))
        if (JSON.stringify(old[field]) !== JSON.stringify(entry[field])) s.fields[field] = (s.fields[field] ?? 0) + 1;
    }
    let removed = 0;
    for (const key of before.keys()) if (!current.has(key)) removed++;
    s.size.push(current.size); s.changed.push(changed); s.added.push(added); s.removed.push(removed);
    previous[name] = current;
  }
}
match.dispose();

const mean = list => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
const quantile = (list, q) => { const sorted = [...list].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0; };
const summary = {};
for (const [name, s] of Object.entries(stats)) {
  if (!s.seen.size) continue;
  // Share of the collection that a structurally shared frame would have to replace this tick.
  const touched = s.changed.map((c, i) => s.size[i] ? (c + s.added[i]) / s.size[i] : 0);
  summary[name] = { meanSize: +mean(s.size).toFixed(1), meanChanged: +mean(s.changed).toFixed(2), meanAdded: +mean(s.added).toFixed(2), meanRemoved: +mean(s.removed).toFixed(2),
    fraction: { mean: +mean(touched).toFixed(4), p50: +quantile(touched, 0.5).toFixed(4), p95: +quantile(touched, 0.95).toFixed(4), max: +quantile(touched, 1).toFixed(4) },
    everChanged: +(s.everChanged.size / s.seen.size).toFixed(4), seen: s.seen.size,
    fields: Object.fromEntries(Object.entries(s.fields).sort((a, b) => b[1] - a[1]).slice(0, 8)) };
}
const meta = { seed, content: content.id, size: zoneSizeName(size), ticks: stats.players.size.length, node: process.version };
console.log(`Change fraction — seed ${seed}, ${content.id}, ${meta.size}, ${meta.ticks} ticks`);
console.log('collection   size  changed/tick  added  removed  mean frac  p95 frac  ever changed  top fields');
for (const [name, r] of Object.entries(summary))
  console.log(`${name.padEnd(12)} ${String(r.meanSize).padStart(6)} ${String(r.meanChanged).padStart(12)} ${String(r.meanAdded).padStart(6)} ${String(r.meanRemoved).padStart(8)} ${(r.fraction.mean * 100).toFixed(2).padStart(9)}% ${(r.fraction.p95 * 100).toFixed(2).padStart(8)}% ${(r.everChanged * 100).toFixed(1).padStart(12)}%  ${Object.keys(r.fields).join(', ')}`);
if (args.get('out')) await writeFile(args.get('out'), JSON.stringify({ meta, summary, series: Object.fromEntries(Object.entries(stats).map(([n, s]) => [n, { size: s.size, changed: s.changed, added: s.added, removed: s.removed }])) }));
