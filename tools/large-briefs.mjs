#!/usr/bin/env node
/**
 * Captures the briefs only the larger authored sizes make (#821), for
 * `tests/slow/micro-large-briefs.test.js`, which runs each through the builder contract
 * instead of building whole 24 × 12 and 36 × 18 maps.
 *
 * The rule is reproducible: for each region type and each axis (portal count, owned cells), the
 * largest brief over the larger sizes' seeds is kept when it exceeds the largest the full
 * sweep's 120 game maps hand that type (`sweep-1` to `sweep-120`). A brief that wins both axes
 * is kept once. Only macro runs: placement through briefs, no builds.
 *
 *   node tools/large-briefs.mjs [--out=tests/fixtures/large-briefs.json.gz] [--seeds=5]
 *
 * The fixture is a builder input, so it stays valid when macro moves on. The tests/fixtures
 * README says when to recapture it.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CHAIN_LIBRARIES, generateMacro } from '../map/chain.ts';
import { MACRO_VERSION, mapViews } from '../map/macro/src/chain/map.ts';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(out|seeds)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use [--out=tests/fixtures/large-briefs.json.gz] [--seeds=5]');
  return [match[1], match[2]];
}));
const out = resolve(args.out ?? 'tests/fixtures/large-briefs.json.gz');
const seeds = Number(args.seeds ?? 5);
if (!Number.isInteger(seeds) || seeds < 1) throw new Error('--seeds must be a positive whole number');

const AXES = { portals: brief => brief.portals.length, cells: brief => brief.cells.length };

/** Macro's briefs for one seed, as `generate` would hand them to the builders. */
function briefsOf(seed, library) {
  return mapViews(generateMacro(seed, { zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight })).briefs;
}

/** Per type and axis, the largest value and the first brief that has it. */
function extremes(maps) {
  const best = {};
  for (const { seed, briefs } of maps) for (const brief of briefs) for (const [axis, measure] of Object.entries(AXES)) {
    const slot = ((best[brief.type] ??= {})[axis] ??= { value: -1 });
    const value = measure(brief);
    if (value > slot.value) Object.assign(slot, { value, seed, brief });
  }
  return best;
}

const [base, ...larger] = CHAIN_LIBRARIES;
const sweep = extremes(Array.from({ length: 120 }, (_, i) => ({ seed: `sweep-${i + 1}`, briefs: briefsOf(`sweep-${i + 1}`, base) })));
const large = extremes(larger.flatMap(library => Array.from({ length: seeds }, (_, i) => {
  const seed = `size-${library.zoneWidth}-${i + 1}`;
  return { seed, size: `${library.zoneWidth}x${library.zoneHeight}`, briefs: briefsOf(seed, library) };
})));

const kept = new Map();
for (const [type, axes] of Object.entries(large).sort(([a], [b]) => (a < b ? -1 : 1)))
  for (const [axis, { value, seed, brief }] of Object.entries(axes)) {
    const was = sweep[type]?.[axis]?.value ?? 0;
    if (value <= was) continue;
    const key = `${seed}/${brief.id}`;
    const entry = kept.get(key) ?? { seed, axes: {}, brief };
    entry.axes[axis] = { value, sweepMax: was };
    kept.set(key, entry);
  }

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const fixture = {
  provenance: { commit, macroVersion: MACRO_VERSION, seeds, rule: 'per type and axis, the largest larger-size brief exceeding the 120-map sweep maximum' },
  briefs: [...kept.values()],
};
writeFileSync(out, gzipSync(JSON.stringify(fixture)));
for (const { seed, axes, brief } of fixture.briefs)
  console.log(`${brief.type.padEnd(10)} ${`${seed}/${brief.id}`.padEnd(32)} ${Object.entries(axes).map(([axis, { value, sweepMax }]) => `${axis} ${value} (sweep ${sweepMax})`).join(', ')}`);
console.log(`${fixture.briefs.length} briefs → ${out}`);
