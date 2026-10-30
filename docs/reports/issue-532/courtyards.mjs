import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARIES } from '../../../map/chain.ts';
import { generateChainMap, mapViews } from '../../../map/macro/src/chain/map.ts';
import { REGION_TYPES_VERSION, buildRegion } from '../../../map/micro/region-types.ts';
import { composeRegions } from '../../../map/micro/compose.ts';
import { measureFill } from '../../../map/micro/fill.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../../../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../../../map/micro/portals.ts';

const samples = [];
for (const library of CHAIN_LIBRARIES) {
  const seed = `size-${library.zoneWidth}-1`, size = 48;
  console.error(`Generating ${seed}`);
  const params = { zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight,
    exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: .04, lootTierStep: .09 };
  const map = generateChainMap(seed, params, library, size, {
    version: REGION_TYPES_VERSION, build: buildRegion, compose: composeRegions });
  const defects = mapViews(map, composeRegions).report.defects;
  assert.deepEqual(defects, []);
  const courts = [];
  for (const result of map.results.filter(r => r.brief.type === 'compound')) {
    console.error(`Checking ${result.brief.id}`);
    const traces = [];
    const replay = buildRegion(result.brief, undefined, t => traces.push(t));
    assert.deepEqual(replay.elements, result.elements);
    const shapes = result.elements.flatMap(e => elementShapes(e));
    const access = createAccessMask(result.brief), radius = hunterClearance(size);
    const starts = portalStands(result.brief).flatMap(p => p.points);
    const targets = [];
    for (const trace of traces) for (const space of trace.allocation.spaces) {
      // Every authored room/keep space has rectangular cell allocation.
      const xs = space.cells.map(c => c.x), ys = space.cells.map(c => c.y);
      targets.push({ label: `${trace.label}/${space.id}`, point: {
        x: trace.origin.x + (Math.min(...xs) + Math.max(...xs) + 1) / 2 * size,
        y: trace.origin.y + (Math.min(...ys) + Math.max(...ys) + 1) / 2 * size } });
    }
    for (const trace of traces) for (const o of trace.realization.openings.filter(o => o.kind === 'door')) {
      const { axis, x, y } = o.run;
      const center = { x: trace.origin.x + (x + (axis === 'h' ? o.center : 0)) * size,
        y: trace.origin.y + (y + (axis === 'v' ? o.center : 0)) * size };
      for (const offset of [-1, 0, 1]) targets.push({ label: `${trace.label}/${o.connectionId}/${offset}`,
        point: { x: center.x + (axis === 'v' ? offset * size : 0),
          y: center.y + (axis === 'h' ? offset * size : 0) } });
    }
    // The portal promise joins the starts; use the nearest one for each local
    // target rather than exploring a large region from a distant first portal.
    const routes = targets.map(t => {
      const start = [...starts].sort((a, b) => Math.hypot(a.x - t.point.x, a.y - t.point.y)
        - Math.hypot(b.x - t.point.x, b.y - t.point.y))[0];
      return { ...t, reachable: !!findRegionRoute(access, shapes, start, t.point, radius) };
    });
    assert.ok(routes.every(t => t.reachable), JSON.stringify(routes.filter(t => !t.reachable)));
    const reachErrors = validatePortalReach({ ...result.brief, blockers: shapes }).errors;
    assert.deepEqual(reachErrors, []);
    const ring = result.elements.filter(e => /^compound-(room|gate)/.test(e.label));
    const x = Math.min(...ring.map(e => e.x)), y = Math.min(...ring.map(e => e.y));
    const w = (Math.max(...ring.map(e => e.x + e.template.w)) - x) / size;
    const h = (Math.max(...ring.map(e => e.y + e.template.h)) - y) / size;
    const added = result.elements.filter(e => /^compound-(keep|court)/.test(e.label));
    const before = measureFill(result.brief, result.elements.filter(e => !added.includes(e)));
    const after = measureFill(result.brief, result.elements);
    courts.push({ id: result.brief.id, court: { w: w - 6, h: h - 6 },
      added: added.map(e => ({ label: e.label, x: e.x / size, y: e.y / size, w: e.template.w / size, h: e.template.h / size })),
      occupiedBefore: before.cells - before.freeCells, occupiedAfter: after.cells - after.freeCells,
      reachErrors, routes });
  }
  samples.push({ seed, params, defects, courts });
}
writeFileSync(new URL('./courtyards.json', import.meta.url), JSON.stringify({ version: REGION_TYPES_VERSION, samples }, null, 2) + '\n');
console.log(samples.map(s => ({ seed: s.seed, courts: s.courts.length, added: s.courts.map(c => c.added.length) })));
