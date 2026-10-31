import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actualStarts, wholeGridStarts } from '../tools/route-start-bench.mjs';

const starts=actualStarts(readFileSync(new URL('../map/micro/geometry.ts',import.meta.url),'utf8'));

test('local start enumeration preserves captured entrance candidates and exact tie ordering',()=>{
  const cases=JSON.parse(readFileSync(new URL('../docs/reports/issue-722/cases.json',import.meta.url),'utf8'));
  assert.equal(cases.length,129);
  for(const c of cases)assert.deepEqual(starts(c.mask,c.a),wholeGridStarts(c.mask,c.a),c.id);
});

test('local starts preserve negative, off-grid, clipped and outside-domain candidates',()=>{
  for(const cellSize of [1,40,48])for(const origin of [-480,0,1000000]) {
    const mask={cellSize,bounds:{x:origin,y:origin,w:cellSize*12,h:cellSize*10}};
    for(const [x,y]of [[0,0],[-.33,.27],[.5,.5],[5.13,4.73],[12,10],[13,11],[-4,-4],[16,15]]) {
      const a={x:origin+x*cellSize,y:origin+y*cellSize};
      assert.deepEqual(starts(mask,a),wholeGridStarts(mask,a),`${cellSize}/${origin}/${x},${y}`);
    }
  }
});
