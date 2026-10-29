import test from 'node:test';
import assert from 'node:assert/strict';
import { parcelArea, parcelCells, areaContains } from '../map/micro/parcel-area.ts';
import { rect, polygon, circle, sharesArea } from '../shared/shape.ts';

test('union is disjoint, deterministic, and preserves holes and concavity', () => {
  const inputs = [rect(0,0,4,1), rect(0,1,1,3), rect(3,1,1,3), rect(1,3,2,1), rect(0,0,2,1)];
  const area = parcelArea(inputs);
  assert.deepEqual(area, parcelArea([...inputs].reverse()));
  for (let i=0;i<area.length;i++) for(let j=0;j<i;j++) assert.equal(sharesArea(area[i],area[j],1e-7),false);
  assert.equal(areaContains(area,[rect(0,0,4,1)]),true);
  assert.equal(areaContains(area,[rect(1,1,1,1)]),false);
  const l = parcelArea([polygon(0,0,[{x:0,y:0},{x:3,y:0},{x:3,y:1},{x:1,y:1},{x:1,y:3},{x:0,y:3}])]);
  assert.equal(areaContains(l,[rect(0,0,1,3)]),true);
  assert.equal(areaContains(l,[rect(1,1,1,1)]),false);
});

test('cell union and conservative physical containment', () => {
  const area = parcelCells([{x:0,y:0},{x:1,y:0}], 10);
  assert.equal(areaContains(area,[rect(9,1,2,8)]),true);
  assert.equal(areaContains(area,[rect(19.999,1,0.002,1)]),false);
  assert.equal(areaContains(area,[circle(10,5,4)]),true);
  assert.equal(areaContains(area,[circle(19,5,2)]),false);
});

test('malformed and unsupported input is distinguished from refusal', () => {
  assert.throws(() => parcelArea([circle(0,0,1)]), /unsupported/);
  assert.throws(() => parcelArea([rect(0,0,-1,1)]), /Invalid/);
  assert.equal(areaContains(parcelArea([rect(0,0,1.001,1)]), [rect(0,0,1.001,1)]), true);
  assert.throws(() => parcelCells([{x:0.5,y:0}],1), /Invalid/);
  assert.throws(() => parcelArea([polygon(0,0,[{x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0}])]), /polygon/);
});

test('containment remains physical at large translated coordinates', () => {
  const world = 32_000_000_000, area = parcelArea([rect(world,world,32,32)]);
  assert.equal(areaContains(area,[rect(world+4,world+4,24,24)]),true);
  assert.equal(areaContains(area,[rect(world+31,world+4,2,24)]),false);
});
