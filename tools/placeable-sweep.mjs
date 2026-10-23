/** Complete built-region hashes for behavior-preserving placeable extraction (20.8). */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildRegion, REGION_TYPES } from '../map/micro/region-types.ts';
import { generate } from '../map/tools/core.ts';
import { stableStringify } from '../map/tools/sweep.mts';

const digest = value => createHash('sha256').update(stableStringify(value)).digest('hex');
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const shapes = {
  square: cellsOf(16, 16),
  wide: cellsOf(24, 12),
  ell: cellsOf(20, 20, (x, y) => x < 12 || y < 12),
  ring: cellsOf(24, 24, (x, y) => x < 8 || x >= 16 || y < 8 || y >= 16),
};
const seeds = Array.from({ length: 24 }, (_, i) => i + 1);
const mapSeeds = [1, 2, 3, 4, 5, 9, 17, 42, 101, 4217];

function entries() {
  const out = {};
  for (const type of Object.keys(REGION_TYPES)) for (const [shape, cells] of Object.entries(shapes)) for (const seed of seeds) {
    const key = `${type}/${shape}/${seed}`;
    const brief = { id: key, seed, type, cellSize: 40, cells, portals: [],
      zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }] };
    try { out[key] = digest(buildRegion(brief)); }
    catch (error) { out[key] = { error: error instanceof Error ? error.message : String(error) }; }
  }
  for (const seed of mapSeeds) {
    const key = `live/${seed}`;
    try { out[key] = digest(generate(`placeable-${seed}`, {}).results); }
    catch (error) { out[key] = { error: error instanceof Error ? error.message : String(error) }; }
  }
  return out;
}

const [mode, file] = process.argv.slice(2);
if (!['capture', 'check'].includes(mode) || !file) throw new Error('Usage: node tools/placeable-sweep.mjs capture|check <baseline.json>');
const current = entries();
if (mode === 'capture') {
  const baseline = { provenance: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    types: Object.keys(REGION_TYPES), shapes: Object.keys(shapes), seeds, mapSeeds }, entries: current };
  writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`${Object.keys(current).length} builds; ${digest(current)}; ${file}`);
} else {
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  const keys = new Set([...Object.keys(baseline.entries), ...Object.keys(current)]);
  const changed = [...keys].filter(key => stableStringify(current[key]) !== stableStringify(baseline.entries[key]));
  console.log(`${Object.keys(current).length} builds; ${digest(current)}; ${changed.length} changed`);
  if (changed.length) { console.error(changed.slice(0, 30).join('\n')); process.exitCode = 1; }
}
