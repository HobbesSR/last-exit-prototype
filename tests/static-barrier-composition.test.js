import test from 'node:test';
import assert from 'node:assert/strict';
import { bottleElement, placeBottle, validateBottle, targetPairs } from '../tools/experiments/static-barrier.mjs';
import { measureFixedRoutes } from '../tools/experiments/barrier-routes.mjs';
import { measureNavigationStructure } from '../map/tools/navigation-structure.ts';

function room() {
  const cells = Array.from({ length: 32*32 }, (_, i) => ({ x: i%32, y: Math.floor(i/32) }));
  return { layout: { seed: 'bottle', params: {} }, results: [{ version: 'region-2', brief: {
    id: 'park', seed: 'bottle', type: 'park', cellSize: 48, cells, fillCells: cells, clearCells: [], zones: [], portals: [],
  }, elements: [], loot: [], coreElements: [] }] };
}

test('connected bottle gives both bodies a substantial accessible single-mouth pocket and target-relative detour', () => {
  const before = room(), element = bottleElement(6*48,6*48,48);
  const after = structuredClone(before); after.results[0].elements.push(element);
  const pairs = targetPairs(element,48,{x:0,y:0});
  const b = measureFixedRoutes(before,{contestant:pairs,hunter:pairs});
  const a = measureFixedRoutes(after,{contestant:pairs,hunter:pairs});
  const metrics = measureNavigationStructure(after);
  for (let i=0;i<2;i++) {
    assert.ok(a.roles[i].samples.every(s=>s.status==='complete'));
    assert.ok(b.roles[i].samples.every(s=>s.status==='complete' && Math.abs(s.ratio-1)<1e-9));
    assert.ok(a.roles[i].samples.filter(s=>s.category==='barrier-target').every(s=>s.ratio>1.5));
    assert.ok(metrics.roles[i].deadEndArea>100*48*48, `${metrics.roles[i].body} pocket area`);
    assert.equal(metrics.roles[i].components,1);
  }
});

test('bounded siting is deterministic and read-only, and unsupported masks are explicit', () => {
  const map=room(), original=structuredClone(map), a=placeBottle(map), b=placeBottle(map);
  assert.deepEqual(a,b); assert.ok(a.ok); assert.deepEqual(map,original);
  assert.deepEqual(validateBottle(map.results[0],a.element).fillErrors,[]);
  map.results[0].brief.cells=map.results[0].brief.cells.slice(0,10);
  assert.equal(placeBottle(map).ok,false);
});

test('retained loot is never moved or removed when the overlay blocks a site', () => {
  const map=room(); map.results[0].loot=[{x:6.5*48,y:10*48,tier:1}];
  const original=structuredClone(map.results[0].loot), element=bottleElement(6*48,6*48,48);
  map.results[0].elements.push(element);
  const p={category:'retained-loot',from:{x:22*48,y:13*48},to:map.results[0].loot[0]};
  const result=measureFixedRoutes(map,{contestant:[p],hunter:[p]});
  assert.deepEqual(map.results[0].loot,original);
  for(const r of result.roles) assert.equal(r.samples[0].status,'invalid-endpoint');
});
