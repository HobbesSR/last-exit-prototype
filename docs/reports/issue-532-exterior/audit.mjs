// Replay source-bound authored briefs against the exterior outbuilding policy.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildRegion, REGION_TYPES_VERSION } from '../../../map/micro/region-types.ts';
import { buildCompoundGeneration } from '../../../map/micro/strategies/compound.ts';
import { executionLeaves } from '../../../map/micro/delegation-execute.ts';
import { validateBriefPartition } from '../../../map/micro/delegation.ts';
import { createAccessMask, elementShapes, findRegionRoute, shapesOverlap, travelClear } from '../../../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../../../map/micro/portals.ts';
import { validateFillConstraints } from '../../../map/micro/margins.ts';
import { measureFill } from '../../../map/micro/fill.ts';
import { microMetrics } from '../../../map/micro/metrics.ts';
import { circle, rect, transform } from '../../../shared/shape.ts';
import { CLIP_SCALE } from '../../../shared/shape-construction.ts';
import { freePaths, triangulateFreeSpace } from '../../../shared/free-space.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const beforeBytes = readFileSync(new URL('./before.json.gz', import.meta.url));
const before = JSON.parse(gunzipSync(beforeBytes));
const baseCommit = 'e9e9be3';
for (const [path, digest] of Object.entries(before.sourceHashes)) {
  const historical = execFileSync('git', ['show', `${baseCommit}:${path}`], { encoding: 'utf8', maxBuffer: 4e6 });
  assert.equal(hash(historical.replaceAll('\r\n', '\n')), digest, `baseline source ${path}`);
}
const paths = execFileSync('git', ['ls-files', 'map/micro', 'map/kernel', 'shared'], { encoding: 'utf8' })
  .trim().split(/\r?\n/).filter(p => p.endsWith('.ts'));
paths.push('map/micro/strategies/compound-exterior.ts');
const sourceHashes = Object.fromEntries([...new Set(paths)].sort().map(p => [p, hash(readFileSync(p, 'utf8').replaceAll('\r\n', '\n'))]));
const samples = [];
for (const sample of before.samples) {
  const rows = [];
  for (const entry of sample.compounds) {
    const traces = [], input = entry.brief;
    console.error(`Checking ${sample.seed} ${input.id}`);
    const result = buildRegion(input, undefined, t => traces.push(t));
    const node = buildCompoundGeneration(input);
    const owners = executionLeaves(node);
    assert.deepEqual(validateBriefPartition(node.input, owners.map(o => o.brief)), []);
    const primary = es => es.filter(e => /^compound-(room|gate|keep|court)/.test(e.label));
    assert.deepEqual(primary(result.elements), primary(entry.baseline.elements), 'primary ring and courtyard unchanged');
    const houses = result.elements.filter(e => e.label === 'compound-outbuilding');
    assert.ok(houses.length <= 1);
    if (!houses.length) assert.deepEqual(result, entry.baseline, 'no-fit output unchanged');
    const shapes = result.elements.flatMap(e => elementShapes(e)), physical = result.elements.flatMap(e => elementShapes(e, true));
    assert.deepEqual(validatePortalReach({ ...input, blockers: shapes }, { search: 'thorough' }).errors, []);
    assert.deepEqual(validateFillConstraints(input, physical), []);
    for (const owner of owners) {
      assert.deepEqual(validateFillConstraints(owner.brief, owner.elements.flatMap(e => elementShapes(e, true))), []);
      assert.deepEqual(validatePortalReach({ ...owner.brief, blockers: shapes }, { search: 'thorough' }).errors, []);
    }
    // Entrances and bypasses must stay usable in the retained owner, without
    // borrowing an arbitrary path through a cover child's interior.
    const access = createAccessMask(node.retained.brief), starts = portalStands(input).flatMap(p => p.points), targets = [];
    for (const trace of traces) {
      for (const s of trace.allocation.spaces) {
        const xs = s.cells.map(c => c.x), ys = s.cells.map(c => c.y);
        targets.push({ label: `${trace.label}/${s.id}`, point: {
          x: trace.origin.x + (Math.min(...xs) + Math.max(...xs) + 1) / 2 * input.cellSize,
          y: trace.origin.y + (Math.min(...ys) + Math.max(...ys) + 1) / 2 * input.cellSize } });
      }
      for (const o of trace.realization.openings.filter(o => o.kind === 'door')) for (const offset of [-1, 0, 1]) {
        const { axis, x, y } = o.run;
        targets.push({ label: `${trace.label}/${o.connectionId}/${offset}`, point: {
          x: trace.origin.x + (x + (axis === 'h' ? o.center : offset)) * input.cellSize,
          y: trace.origin.y + (y + (axis === 'v' ? o.center : offset)) * input.cellSize } });
      }
    }
    for (const e of houses) {
      const size = input.cellSize, x = e.x / size, y = e.y / size, w = e.template.w / size, h = e.template.h / size;
      const bands = [rect((x - 2) * size, (y - 2) * size, (w + 4) * size, 2 * size),
        rect((x - 2) * size, (y + h) * size, (w + 4) * size, 2 * size),
        rect((x - 2) * size, y * size, 2 * size, h * size), rect((x + w) * size, y * size, 2 * size, h * size)];
      const others = result.elements.filter(o => o !== e).flatMap(o => elementShapes(o, true));
      assert.ok(bands.every(b => access.contains(b) && others.every(s => !shapesOverlap(b, s))), 'final bypass stays clear');
      // All integer hunter stands around the full bypass, independently of its protected tiling.
      for (let j = y - 2; j <= y + h; j++) for (let i = x - 2; i <= x + w; i++) {
        if (i !== x - 2 && i !== x + w && j !== y - 2 && j !== y + h) continue;
        targets.push({ label: `bypass/${i},${j}`, point: { x: (i + 1) * size, y: (j + 1) * size } });
      }
    }
    // Reuse one final-geometry mesh across room/door/bypass targets; every
    // returned lead and segment still receives the independent exact sweep.
    let mesh;
    const route = (from, to) => {
      const radius = hunterClearance(input.cellSize);
      if (travelClear(access, shapes, from, to, radius)) return true;
      if (!mesh) {
        const domain = [], pad = 2 / CLIP_SCALE, size = input.cellSize, box = access.bounds;
        for (let i = 0; i < access.cells.length;) {
          const first = access.cells[i++]; let end = first.x + 1;
          while (i < access.cells.length && access.cells[i].y === first.y && access.cells[i].x === end) { end++; i++; }
          domain.push(rect(first.x * size - box.x - pad, first.y * size - box.y - pad, (end - first.x) * size + 2 * pad, size + 2 * pad));
        }
        mesh = triangulateFreeSpace(domain, domain, shapes.map(s => transform(s, -box.x, -box.y)), radius);
      }
      const local = p => ({ x: p.x - access.bounds.x, y: p.y - access.bounds.y });
      const candidate = freePaths(mesh, local(from), [local(to)], input.cellSize)[0];
      const world = candidate?.points.map((p, i, all) => i === 0 ? from : i === all.length - 1 ? to
        : { x: p.x + access.bounds.x, y: p.y + access.bounds.y });
      if (world?.every((p, i) => travelClear(access, shapes, i ? world[i - 1] : p, p, radius))) return true;
      return !!findRegionRoute(access, shapes, from, to, radius);
    };
    const routes = targets.map(t => {
      const start = [...starts].sort((a, b) => Math.hypot(a.x - t.point.x, a.y - t.point.y) - Math.hypot(b.x - t.point.x, b.y - t.point.y))[0];
      return { ...t, reachable: route(start, t.point) };
    });
    assert.deepEqual(routes.filter(t => !t.reachable), []);
    const lootRadius = microMetrics({ cellSize: input.cellSize, bodyProfile: 'cell' }).lootRadius;
    assert.ok(result.loot.every(l => physical.every(s => !shapesOverlap(circle(l.x, l.y, lootRadius), s))));
    const fillBefore = measureFill(input, entry.baseline.elements), fillAfter = measureFill(input, result.elements);
    rows.push({ id: input.id, outbuildings: houses.map(e => ({ x: e.x / input.cellSize, y: e.y / input.cellSize,
      w: e.template.w / input.cellSize, h: e.template.h / input.cellSize })),
      rooms: traces.find(t => t.label === 'compound-outbuilding')?.allocation.spaces.length ?? 0,
      occupiedBefore: fillBefore.cells - fillBefore.freeCells, occupiedAfter: fillAfter.cells - fillAfter.freeCells,
      lootBefore: entry.baseline.loot.length, lootAfter: result.loot.length,
      leafOwners: owners.length,
      beforeHash: jsonHash(entry.baseline), afterHash: jsonHash(result), routes });
  }
  samples.push({ seed: sample.seed, params: sample.params, rows });
}
const report = { version: REGION_TYPES_VERSION, baseCommit, baselineSha256: hash(beforeBytes), sourceHashes, samples };
const file = new URL('./after.json', import.meta.url);
if (process.argv.includes('--verify')) assert.deepEqual(report, JSON.parse(readFileSync(file)), 'retained report matches current sources and output');
else writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(samples.map(s => ({ seed: s.seed, compounds: s.rows.length, houses: s.rows.filter(r => r.outbuildings.length).length,
  targets: s.rows.reduce((n, r) => n + r.routes.length, 0) })));
