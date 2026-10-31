// Bounded start-enumeration microbenchmark. This does not time whole generation.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { routeStarts } from '../../../map/micro/geometry.ts';
import { acquireMachineLock } from '../../../tests/helpers/machine-lock.js';

function wholeGridStarts(step, box, width, height, a) {
  const point = i => ({ x: box.x + i % width * step, y: box.y + Math.floor(i / width) * step });
  const nearby = [];
  for (let i = 0; i < width * height; i++) {
    if (Math.hypot(point(i).x - a.x, point(i).y - a.y) <= step * 3) nearby.push(i);
  }
  nearby.sort((i, j) => Math.hypot(point(i).x - a.x, point(i).y - a.y) - Math.hypot(point(j).x - a.x, point(j).y - a.y));
  return nearby;
}

const [flag, out] = process.argv.slice(2);
if (flag !== '--out' || !out || process.argv.length !== 4) throw Error('Usage: route-start-bench.mjs --out NEW_REPORT.json');
const source = readFileSync(new URL('../../../map/micro/geometry.ts', import.meta.url), 'utf8');
const cases = JSON.parse(readFileSync(new URL('../../../tests/fixtures/route-start-cases.json', import.meta.url), 'utf8'));
const inputs = cases.map(({ mask, a }) => {
  const step = mask.cellSize / 2, box = mask.bounds;
  return [step, box, Math.round(box.w / step) + 1, Math.round(box.h / step) + 1, a];
});
const hash = b => createHash('sha256').update(b).digest('hex');
for (let i = 0; i < inputs.length; i++) assert.deepEqual(routeStarts(...inputs[i]), wholeGridStarts(...inputs[i]), cases[i].id);
const lock = await acquireMachineLock('bench', { timeoutMs: 1000, pollMs: 100 });
const pairs = [], deadline = performance.now() + 10000;
try {
  for (let i = 0; i < 3; i++) {
    if (performance.now() > deadline) throw Error('Microbenchmark exceeded 10-second budget; no automatic retry');
    const pair = {};
    for (const [name, fn] of [['wholeGrid', wholeGridStarts], ['local', routeStarts]]) {
      const values = [], start = performance.now();
      for (const input of inputs) values.push(fn(...input));
      pair[name] = { ms: performance.now() - start, outputSha256: hash(JSON.stringify(values)) };
    }
    assert.equal(pair.wholeGrid.outputSha256, pair.local.outputSha256); pairs.push(pair);
  }
} finally { lock.release(); }
const report = { scope: 'Start enumeration only; not whole-generation timing.', cases: cases.length,
  sourceNormalizedSha256: hash(source.replaceAll('\r\n', '\n')), controlSha256: hash(wholeGridStarts.toString()), variantSha256: hash(routeStarts.toString()), pairs };
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
