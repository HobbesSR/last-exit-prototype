// Correctness only: compare every requested cache answer with uncached swept geometry.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw Error('Usage: node docs/reports/issue-724/diagnose.mjs SNAPSHOTS OUTPUT');
const root = path.resolve(directory, 'batch');
const file = path.join(root, 'map/micro/strategies/content-access.ts');
const original = fs.readFileSync(file, 'utf8');
let guard = original;
guard = guard.replace('  const clearance = createRouteClearance(mask, blockers, radius);', `
  const actual = createRouteClearance(mask, blockers, radius);
  const checked = (clear: (a: Vec2, b: Vec2) => boolean, shapes: readonly Shape[]) => (a: Vec2, b: Vec2) => {
    const cached = clear(a, b), expected = travelClear(mask, shapes, a, b, radius);
    (globalThis as any).__clearanceChecks++;
    if (cached !== expected) throw Error('Cached clearance mismatch: ' + JSON.stringify({a,b,cached,expected}));
    return cached;
  };
  const clearance = {
    accepted: () => checked(actual.accepted(), blockers),
    prepare: (added: readonly Shape[]) => {
      const trial = actual.prepare(added);
      return { clear: checked(trial.clear, [...blockers, ...added]), commit: trial.commit };
    },
  };`);
if (guard === original) throw Error('Missing instrumentation anchor');
const corpusBytes = fs.readFileSync(path.join(root, 'docs/reports/issue-716/frozen-corpus.json.gz'));
const corpus = JSON.parse(gunzipSync(corpusBytes));
const row = corpus.rows.find(r => r.seed === 'size-12-1' && r.brief.id === 'depot@126,102');
if (!row) throw Error('Missing failed row');
const hash = b => createHash('sha256').update(b).digest('hex');
fs.writeFileSync(output, '', {flag:'wx'});
fs.writeFileSync(file, guard);
try {
  globalThis.__clearanceChecks = 0;
  const { buildDepot } = await import(pathToFileURL(path.join(root, 'map/micro/strategies/depot.ts')));
  const {elements, loot, coreElements, manifest} = buildDepot(structuredClone(row.brief));
  const actual = hash(JSON.stringify({elements, loot, coreElements, manifest}));
  if (actual !== row.sha256) throw Error(`Failed-row output drift: ${actual} expected ${row.sha256}`);
  fs.writeFileSync(output, JSON.stringify({status:'complete',seed:row.seed,id:row.brief.id,
    checkedClearances:globalThis.__clearanceChecks,actual,expected:row.sha256,corpusSha256:hash(corpusBytes)},null,2)+'\n');
  console.log('Failed row matches; every cached clearance matched uncached geometry.');
} finally { fs.writeFileSync(file, original); }
