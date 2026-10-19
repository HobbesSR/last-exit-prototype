import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralGraph, speculative } from '../tools/navigation/optimistic.mjs';
import { beginQuery } from '../tools/navigation/graph.mjs';

// neutralGraph takes dimensions, never a map, so hidden geometry cannot reach it by construction (42.1).
test('a dimensions-only empty-knowledge graph plans repeatably, including sliced work', () => {
  const plans=[0,1].map(() => {
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
