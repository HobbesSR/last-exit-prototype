import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDelegation } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, readDelegationSnapshot } from '../map/micro/delegation-snapshot.ts';
import { buildDepotExperiment } from '../map/micro/strategies/depot.ts';
import { protectedRoutes } from '../map/micro/strategies/scatter.ts';
import { discoverCordWitness } from '../map/micro/cord-witness.ts';
import { createAccessMask, elementShapes, findRegionRoute, shapesOverlap, shapesShareArea } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';
import { chainBrief, reorderedBrief } from './helpers/chain-briefs.js';

const portals = [{id:'west',axis:'v',x:0,y:8,length:2},{id:'east',axis:'v',x:24,y:8,length:2}];
const fixture = () => chainBrief({type:'depot',seed:5,cells:cellsOf(24,18),portals,parameters:{density:1,roomCells:8}});
const registry = mode => ({ depot: { version:`depot-cord-comparison-1:${mode}`,
  build(brief, _context, observe) { return buildDepotExperiment(brief, mode, observe).result; } } });
const roundTrip = value => JSON.parse(JSON.stringify(value));

/** Recover two-cell exterior stands from realized doors, independent of the builder's demands. */
function doorstepTerminals(element, trace, size) {
  return trace.realization.openings.filter(o => o.kind === 'door' && (o.a === 'outside' || o.b === 'outside')).flatMap(door => {
    const {run, center} = door, horizontal = run.axis === 'h';
    const start = (horizontal ? run.x : run.y) + center - 1;
    return [...new Set([Math.floor(start), Math.ceil(start)])].map(along => horizontal
      ? {x:element.x + (along + 1) * size, y:element.y + (run.y === 0 ? -1 : element.template.h / size + 1) * size}
      : {x:element.x + (run.x === 0 ? -1 : element.template.w / size + 1) * size, y:element.y + (along + 1) * size});
  });
}

test('experimental outputs keep final portal and realized exterior doorstep reach', () => {
  const brief = fixture(), route = protectedRoutes(brief, 'Depot', 'nearby');
  for (const mode of ['fixed','movable']) {
    const traces = [], {result} = buildDepotExperiment(brief, mode, t => traces.push(t));
    const warehouses = result.elements.filter(e => e.label.startsWith('depot-warehouse'));
    assert.ok(warehouses.length > 0, mode);
    assert.ok(result.manifest.rows > 0, mode);
    assert.equal(result.manifest.infillCrates, 0);
    const blockers = result.elements.flatMap(e => elementShapes(e, true));
    assert.deepEqual(validateFillConstraints(result.brief, blockers), []);
    assert.deepEqual(validatePortalReach({...result.brief, blockers}, {search:'thorough'}).errors, []);
    const terminals = warehouses.flatMap(e => {
      const trace = traces.find(t => t.label === e.label);
      assert.ok(trace, e.label);
      const points = doorstepTerminals(e, trace, brief.cellSize);
      assert.ok(points.length >= 2, e.label);
      const openBlockers = result.elements.flatMap(item => elementShapes(item));
      const mask = createAccessMask(result.brief);
      const radius = microMetrics({cellSize: brief.cellSize, bodyProfile: 'cell'}).clearance.contestant;
      for (const point of points) {
        const square = rect(point.x - brief.cellSize, point.y - brief.cellSize, 2 * brief.cellSize, 2 * brief.cellSize);
        assert.ok(mask.contains(square), `  doorstep fits access mask`);
        assert.ok(!blockers.some(shape => shapesShareArea(shape, square)), `  doorstep is physically clear`);
      }
      for (const space of trace.allocation.spaces) {
        const reachable = space.cells.some(cell => findRegionRoute(mask, openBlockers, points[0],
          {x:e.x + (cell.x + 0.5) * brief.cellSize, y:e.y + (cell.y + 0.5) * brief.cellSize}, radius));
        assert.ok(reachable, `${mode} ${e.label} contestant reaches ${space.id}`);
      }
      return points;
    });
    const proof = discoverCordWitness(result.brief, blockers, terminals);
    assert.equal(proof.ok, true, `${mode} doorstep proof: ${JSON.stringify(proof)}`);
    if (mode === 'movable') assert.ok(warehouses.some(e => route.some(s => shapesOverlap(s, rect(e.x,e.y,e.template.w,e.template.h)))), 'warehouse crosses original frozen route');
  }
});

test('each experiment has reproducible separately versioned full and omitted snapshots', () => {
  for (const mode of ['fixed','movable']) {
    const brief = fixture(), builders = registry(mode), node = executeDelegation(brief, builders);
    const reordered = reorderedBrief(brief, 17); reordered.portals = [...reordered.portals].reverse();
    assert.deepEqual(executeDelegation(reordered, builders), node);
    assert.equal(node.registryVersions.depot, `depot-cord-comparison-1:${mode}`);
    const full = roundTrip(saveDelegationSnapshot(node));
    assert.deepEqual(readDelegationSnapshot(full), node);
    const omitted = roundTrip(saveDelegationSnapshot(node, {omitResults:true}));
    assert.deepEqual(readDelegationSnapshot(omitted, builders), node);
    assert.throws(() => readDelegationSnapshot(omitted, registry(mode === 'fixed' ? 'movable' : 'fixed')), /builder depot version/);
  }
});

test('zero density and undersized regions retain their fallback behavior', () => {
  for (const mode of ['fixed','movable']) {
    const empty = executeDelegation({...fixture(),parameters:{density:0}},registry(mode));
    assert.equal(empty.retained.elements.length,0);
    const small = chainBrief({type:'depot',seed:5,cells:cellsOf(6,6)});
    const result = executeDelegation(small,registry(mode));
    assert.equal(result.retained.elements.length,0);
  }
});
