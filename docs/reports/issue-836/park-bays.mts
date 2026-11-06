#!/usr/bin/env node
/**
 * #836 step 4 (#758 step 1): does 51.10's dead-end measure miss walkable bays in #649's
 * hedge-front parks? Measures each example region alone, before and after fronts, at
 * 51.10's thresholds and at a relaxed set, and renders both for inspection.
 *
 *   node docs/reports/issue-836/park-bays.mts [--png DIR]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { composeRegions } from '../../../map/micro/compose.ts';
import { builtMapCollision } from '../../../map/micro/adapter.ts';
import { measureMeshPockets } from '../../../map/tools/navigation-structure.ts';
import { mapFreeSpace } from '../../../shared/free-space.ts';
import { navigationClearance, navigationMap } from '../../../shared/map/navigation.ts';
import { outline, shapeOf } from '../../../shared/shape.ts';

const examples = JSON.parse(gunzipSync(readFileSync('docs/reports/issue-649/examples.json.gz')).toString('utf8'));
const pngDir = process.argv.includes('--png') ? process.argv[process.argv.indexOf('--png') + 1]! : '';
const rows = [], svgs: [string, string][] = [];
for (const ex of examples) for (const phase of ['before', 'after'] as const) for (const context of ['isolated', 'ring'] as const) {
  // Alone, unpartnered portals cannot compose; geometry does not read them. Isolated, the region edge bounds
  // the mesh (an upper bound: every portal is closed). With `ring`, an empty two-cell ring of playable cells
  // surrounds it, opening its whole edge as most unguaranteed edge is open on real maps (42.34).
  const result = { ...ex[phase], brief: { ...ex[phase].brief, portals: [] } };
  const owned = new Set(result.brief.cells.map((c: { x: number; y: number }) => `${c.x},${c.y}`)), ring: { x: number; y: number }[] = [];
  if (context === 'ring') {
    const seen = new Set<string>();
    for (const c of result.brief.cells) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const k = `${c.x + dx},${c.y + dy}`; if (!owned.has(k) && !seen.has(k)) { seen.add(k); ring.push({ x: c.x + dx, y: c.y + dy }); }
    }
  }
  const stub = { version: 'region-2', brief: { id: '~ring', seed: 0, type: 'open', cellSize: result.brief.cellSize, cells: ring, zones: [], portals: [] }, elements: [], coreElements: [], loot: [], manifest: {} };
  const built = ring.length ? { cellSize: result.brief.cellSize, regions: [result, stub], pairs: [] } as unknown as ReturnType<typeof composeRegions> : composeRegions([result]);
  const size = built.cellSize, collision = builtMapCollision(built);
  const nav = navigationMap(collision, true);
  for (const role of ['contestant', 'gladiator'] as const) {
    const clearance = navigationClearance(role);
    const space = mapFreeSpace(nav, '836 park bays', [{ x: 0, y: 0, w: nav.width, h: nav.height }], clearance);
    // 51.10: width .5–2 cells, area >= 4 cells² and 2·width², depth >= 2·width.
    const standard = measureMeshPockets(space, size / 2, 2 * size, 4 * size * size);
    // Relaxed: mouths up to 4 cells, area >= 1 cell². The depth rule stays (it is inside measureMeshPockets).
    const relaxed = measureMeshPockets(space, size / 4, 4 * size, size * size);
    const walkable = standard.areas.reduce((a, b) => a + b, 0), cell2 = size * size;
    rows.push({ example: ex.id, seed: ex.seed, phase, context, body: role === 'gladiator' ? 'hunter' : role, walkableCells: +(walkable / cell2).toFixed(1),
      standardCuts: standard.pockets.length, standardCells: +(standard.area / cell2).toFixed(2),
      relaxedCuts: relaxed.pockets.length, relaxedCells: +(relaxed.area / cell2).toFixed(2), components: standard.components,
      fronts: ex[phase].manifest.fronts ?? 0, frontCells: ex[phase].manifest.frontCells ?? 0 });
    if (role !== 'contestant') continue;
    const tri = (t: number) => [0, 1, 2].map(k => { const v = space.triangles[t * 3 + k]!; return `${space.points[v * 2]},${space.points[v * 2 + 1]}`; }).join(' ');
    const parts = [`<rect width="${nav.width}" height="${nav.height}" fill="#222"/>`];
    for (let t = 0; t < space.triangles.length / 3; t++) {
      const fill = standard.marked[t] ? '#e33' : relaxed.marked[t] ? '#f90' : '#cfe8cf';
      parts.push(`<polygon points="${tri(t)}" fill="${fill}" stroke="#9b9" stroke-width="0.5"/>`);
    }
    for (const o of collision.obstacles) parts.push(`<polygon points="${outline(shapeOf(o)).map(p => `${p.x},${p.y}`).join(' ')}" fill="#246"/>`);
    svgs.push([`${ex.id.replace(/[^a-z0-9]+/gi, '_')}-${phase}-${context}`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${nav.width} ${nav.height}" width="${nav.width}" height="${nav.height}">${parts.join('')}</svg>`]);
  }
}
console.table(rows);
if (pngDir) {
  mkdirSync(pngDir, { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true }), page = await browser.newPage();
  for (const [name, svg] of svgs) { await page.setContent(svg); await page.locator('svg').screenshot({ path: `${pngDir}/${name}.png` }); }
  await browser.close();
}
writeFileSync('docs/reports/issue-836/park-bays.json', JSON.stringify({ source: 'docs/reports/issue-649/examples.json.gz', rows }, null, 1) + '\n');
