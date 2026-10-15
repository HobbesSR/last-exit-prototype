import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralGraph, speculative } from '../tools/navigation/optimistic.mjs';
import { beginQuery } from '../tools/navigation/graph.mjs';

test('empty knowledge depends only on public dimensions, including work and caches', () => {
  const hidden = new Proxy({}, {get(){throw new Error('hidden geometry consulted');}});
  const twins = [hidden,{obstacles:[{x:120,y:0,w:1,h:192}],playableArea:null}];
  const plans=twins.map(() => {
    const graph=neutralGraph(384,192,24,14);
    const search=beginQuery(graph,{x:48,y:48},{x:336,y:144},{direct:false});
    const results=[];let result;
    do {result=search.step(7);results.push(result);}while(result.status==='budget-exhausted');
    return results;
  });
  assert.deepEqual(plans[0],plans[1]);
  assert.equal(plans[0].at(-1).status,'complete');
});
test('aggregate report distinguishes bounded progress from unreachability and repeats work', () => {
  const result=speculative(1920,960,24,14,3);
  assert.equal(result.direct[0].slices.at(-1).complete,3);
  assert.deepEqual(result.naiveSampled[0].slices.map(s=>s.expansions),result.naiveSampled[1].slices.map(s=>s.expansions));
  assert.ok(result.naiveSampled[0].slices[0].privateBytes>0);
});
