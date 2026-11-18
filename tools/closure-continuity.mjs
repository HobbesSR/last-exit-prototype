// #1131 stage 3: the schema closure changes projections and nothing else. For every tick of both bot matches
// and every scripted checkpoint, this hashes the authoritative snapshot (private physics included) and each
// view after `close`, the declared closure. Run --out in a pristine export of the commit before the closure,
// then --compare on it: equal hashes mean snapshots are unchanged and every view differs from its old self
// exactly by the closure. `close` is a no-op on a closed view, so the same tool runs on both sides.
// Read-only toward fixtures. Usage: node tools/closure-continuity.mjs --out FILE | --compare FILE
import { readFileSync, writeFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { botTrace, scriptedTrace, seeds } from '../tests/characterization-physics-scenarios.js';
import { playerView } from '../shared/simulation.ts';

const args = process.argv.slice(2), at = flag => args[args.indexOf(flag) + 1];
if (!args.includes('--out') && !args.includes('--compare')) throw new Error('Use --out <path> or --compare <path>');
const fixture = deserialize(gunzipSync(readFileSync('tests/fixtures/behavior-physics-1.v8.gz')));

// The closure, as declared in 24.3 and 17.4 #17: match constants and `directed` leave the frame (proposals 3
// and 8); none is absent rather than null (6); unread item and reload identity fields leave (8, Corey).
const HEADER = ['version', 'duration', 'cellChargeTicks', 'directed', 'physicsProfile', 'predictionMotor'];
const ITEM = ['droppedBy', 'pickupAfter', 'nodeId', 'instanceId', 'lineageId'];
const NONE = ['reload', 'charging', 'respawnAt'];
const without = (record, fields) => {
  if (!record || typeof record !== 'object') return record;
  const copy = { ...record };
  for (const field of fields) delete copy[field];
  return copy;
};
const closeItems = layer => Array.isArray(layer) ? layer.map(item => without(item, ITEM)) : layer;
function closeOwn(own) {
  const copy = without(own, ['cell', 'nodeId']);
  for (const field of NONE) if (copy[field] === null) delete copy[field];
  if (Array.isArray(copy.inventory)) copy.inventory = copy.inventory.map(item => item && without(item, ITEM));
  if (copy.reload) copy.reload = without(copy.reload, ['instanceId']);
  return copy;
}
export function close(view) {
  const copy = without(view, HEADER);
  copy.items = closeItems(copy.items);
  if (copy.self) copy.self = closeOwn(copy.self);
  return copy;
}
// Sorted keys: this proves values, while the fixture itself keeps serialized order.
const canonical = value => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

const result = {};
function trace(name, viewers) {
  const digest = createHash('sha256'); let samples = 0;
  return {
    sample(s, frame) {
      samples++;
      digest.update(JSON.stringify(frame));
      for (const id of viewers(s)) digest.update(canonical(close(playerView(s, frame, id))));
    },
    finish() { result[name] = { samples, sha256: digest.digest('hex') }; },
  };
}
for (const seed of seeds) {
  const t = trace(`bots-${seed}`, () => ['c0', 'g0', 'spectator']);
  await botTrace(seed, fixture.arenas[seed], t.sample); t.finish();
}
// Every player's view and the directed one, a superset of the four the scripted trace keeps.
const scripted = trace('scripted', s => [...s.players.map(p => p.id), 'spectator']);
await scriptedTrace(fixture.arenas[4217], scripted.sample); scripted.finish();

if (args.includes('--compare')) {
  const was = JSON.parse(readFileSync(at('--compare'), 'utf8'));
  if (JSON.stringify(was) !== JSON.stringify(result)) throw new Error(`Closure continuity broken:\n${JSON.stringify({ was, result }, null, 2)}`);
  console.log('Snapshots unchanged; every view is its old self less the declared closure:', JSON.stringify(result));
} else { writeFileSync(at('--out'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result)); }
