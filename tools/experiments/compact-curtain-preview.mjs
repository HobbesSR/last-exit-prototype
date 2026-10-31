/** Presentation-only derivative of the immutable #705 capture preview. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = process.argv[2];
assert.ok(file, 'Usage: node tools/experiments/compact-curtain-preview.mjs PATH/index.html');
const original = readFileSync(file, 'utf8');
const start = original.indexOf('const data=') + 'const data='.length;
const end = original.indexOf(';\nfunction draw', start);
assert.ok(start >= 'const data='.length && end > start, 'Expected capture preview');
const data = JSON.parse(original.slice(start, end));
// Canvas world coordinates: 0.1 world unit is <0.1 pixel even at size 12.
const point = p => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
for (const map of data) {
  for (const phase of ['routesBefore', 'routesAfter']) {
    map[phase] = { roles: map[phase].roles.map(role => ({ body: role.body,
      samples: role.samples.filter((p, i, all) => p.category !== 'before-owner-loot' ||
        p.status !== 'complete' || all.slice(0, i).filter(q => q.category === p.category && q.status === 'complete').length < 12)
      .map(p => ({ category: p.category, status: p.status,
        ratio: p.ratio, to: point(p.to), points: p.points.map(point) })) })) };
  }
}
const compact = (original.slice(0, start) + JSON.stringify(data) + original.slice(end))
  .replace('Use browser zoom to inspect.', 'Use browser zoom to inspect. Old-owner loot preview shows the first 12 complete routes per body/phase plus every failed endpoint; full unrounded measurements remain in the compressed reports. Route drawing coordinates are rounded to 0.1 world unit.');
writeFileSync(file, compact);
console.log(JSON.stringify({ bytes: Buffer.byteLength(compact), sha256: createHash('sha256').update(compact).digest('hex') }));
