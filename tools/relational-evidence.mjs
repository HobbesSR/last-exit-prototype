// #1153: compare gameplay independently of intentional serialized projection changes.
// Read-only toward fixtures. Run --out before the switch, then --compare after it.
import { readFileSync, writeFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { botTrace, scriptedTrace, seeds } from '../tests/characterization-physics-scenarios.js';
import { formatEvent } from '../shared/events.ts';
const args = process.argv.slice(2), out = args[args.indexOf('--out') + 1], compare = args[args.indexOf('--compare') + 1];
if (!args.includes('--out') && !args.includes('--compare')) throw new Error('Use --out <path> or --compare <path>');
const fixture = deserialize(gunzipSync(readFileSync('tests/fixtures/behavior-physics-1.v8.gz')));
const result = {};
function captureTrace(name) {
  const digest = createHash('sha256'); let samples = 0;
  return { sample(s, frame) {
    samples++;
    digest.update(JSON.stringify({ tick: s.tick, phase: s.phase, rng: s.rng, serial: s.serial,
      itemSerial: s.itemSerial, scatterSerial: s.scatterSerial, slots: s.slots, hazardX: s.hazardX,
      players: s.players, items: s.map.items, gates: s.map.gates, traps: s.map.traps,
      projectiles: s.projectiles, effects: s.effects, events: s.events.map(e => ({ id: e.id, tick: e.tick, text: formatEvent(e) })),
      physics: frame.physics }));
  }, finish() { result[name] = { samples, sha256: digest.digest('hex') }; } };
}
for (const seed of seeds) { const trace = captureTrace(`bots-${seed}`); await botTrace(seed, fixture.arenas[seed], trace.sample); trace.finish(); }
const trace = captureTrace('scripted'); await scriptedTrace(fixture.arenas[4217], trace.sample); trace.finish();
if (args.includes('--compare')) {
  const was = JSON.parse(readFileSync(compare, 'utf8'));
  if (JSON.stringify(was) !== JSON.stringify(result)) throw new Error(`Gameplay drift:\n${JSON.stringify({ was, result }, null, 2)}`);
  console.log('Gameplay and private PhysicsWorld evidence unchanged:', JSON.stringify(result));
} else { writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result)); }
