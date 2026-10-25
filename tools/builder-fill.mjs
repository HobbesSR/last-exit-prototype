// Builder fill diagnostic (#288): how much empty space each region type leaves, over a seed set.
// A measure for builder work, not a check: nothing enforces it, and the sweep's report never calls it.
import { REGION_TYPES, buildRegion } from '../map/micro/region-types.ts';
import { measureFill } from '../map/micro/fill.ts';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['types', 'seeds', 'width', 'height', 'min', 'json'], argument => `Unknown option ${argument}. Use --types=hut,block --seeds=20 --width=24 --height=18 --min=3 --json=1.`);
const width = Number(args.get('width') ?? 24), height = Number(args.get('height') ?? 18), min = Number(args.get('min') ?? 3), seeds = Number(args.get('seeds') ?? 20);
const types = args.has('types') ? args.get('types').split(',') : Object.keys(REGION_TYPES);
const cells = [];
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push({ x, y });
const portals = [{ id: 'west', axis: 'v', x: 0, y: Math.floor(height / 2) - 1, length: 2 }, { id: 'east', axis: 'v', x: width, y: Math.floor(height / 2) - 1, length: 2 }];

const rows = [];
for (const type of types) {
  const reports = [];
  let failed = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    try {
      const brief = { id: `${type}-${seed}`, seed, type, cellSize: 40, cells, zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }], portals };
      reports.push(measureFill(brief, buildRegion(brief).elements, min));
    } catch { failed++; }
  }
  if (!reports.length) { rows.push({ type, built: 0, failed }); continue; }
  const sum = pick => reports.reduce((total, report) => total + pick(report), 0);
  rows.push({ type, built: reports.length, failed,
    freeShare: +(sum(r => r.freeCells) / sum(r => r.cells)).toFixed(3),
    gapsPerRegion: +(sum(r => r.rectangles.length) / reports.length).toFixed(2),
    gapCellsShare: +(sum(r => r.rectangles.reduce((a, g) => a + g.w * g.h, 0)) / sum(r => r.cells)).toFixed(3),
    largestGapCells: reports.reduce((m, r) => Math.max(m, r.largest ? r.largest.w * r.largest.h : 0), 0) });
}
if (args.has('json')) process.stdout.write(JSON.stringify({ width, height, min, seeds, rows }, null, 2) + '\n');
else {
  console.log(`${width}x${height} cells, ${seeds} seeds, gaps are free rectangles of at least ${min}x${min}, taken largest first`);
  console.table(rows);
}
