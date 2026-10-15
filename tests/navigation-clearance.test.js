import test from 'node:test';
import assert from 'node:assert/strict';
import { createClearance } from '../tools/navigation/clearance.mjs';
import { segmentShapeDistance, rect, circle, polygon } from '../shared/shape.ts';
import { bakeGraph, queryGraph } from '../tools/navigation/graph.mjs';
import { reachClear } from '../shared/movement.ts';

const p = (x,y) => ({x,y});
const map = (obstacles=[],gates=[]) => ({width:384,height:192,obstacles,gates,playableArea:{cellSize:192,rows:[{y:0,runs:[[0,2]]}]}});
test('continuous sweep catches thin off-grid walls and filled containment', () => {
  const clear = createClearance(map([{x:101,y:0,w:0.1,h:192}]),14);
  assert.equal(clear(p(70,80),p(130,80)),false);
  assert.equal(clear(p(70,80),p(80,80)),true);
  assert.equal(clear(p(101.05,80),p(101.05,80)),false);
  assert.equal(segmentShapeDistance(p(80,80),p(120,80),rect(100,50,1,60)),0);
});
test('circle and polygon tangencies are analytic and conservative', () => {
  assert.equal(segmentShapeDistance(p(20,60),p(180,60),circle(100,100,20)),20);
  const clear = createClearance(map([{x:100,y:100,r:20,w:40,h:40}]),14);
  assert.equal(clear(p(20,66),p(180,66)),false);
  assert.equal(clear(p(20,65.9),p(180,65.9)),true);
  const triangle = polygon(100,50,[p(0,0),p(40,0),p(0,40)]);
  assert.equal(segmentShapeDistance(p(80,70),p(150,70),triangle),0);
  assert.equal(segmentShapeDistance(p(120,70),p(120,70),triangle),0);
  const polygonClear=createClearance(map([{x:100,y:50,w:40,h:40,points:[p(0,0),p(40,0),p(0,40)]}]),14);
  assert.equal(polygonClear(p(80,36),p(160,36)),false);
  assert.equal(polygonClear(p(80,35.9),p(160,35.9)),true);
});
test('diagonal corner clipping, void holes and endpoint walls fail', () => {
  assert.equal(createClearance(map([{x:100,y:80,w:20,h:20}]),14)(p(80,100),p(100,120)),true);
  assert.equal(createClearance(map([{x:100,y:80,w:20,h:20}]),15)(p(80,100),p(100,120)),false);
  const hole = map(); hole.playableArea={cellSize:48,rows:Array.from({length:4},(_,y)=>({y,runs:y===1?[[0,3],[4,8]]:[[0,8]]}))};
  assert.equal(createClearance(hole,14)(p(100,72),p(240,72)),false);
  assert.equal(createClearance(map([{x:100,y:0,w:1,h:192}]),14)(p(90,80),p(60,80)),false);
});
test('contestant squeeze, hunter doorway and gate snapshot revisions', () => {
  const walls = gap => [{x:180,y:0,w:10,h:96-gap/2},{x:180,y:96+gap/2,w:10,h:96-gap/2}];
  assert.equal(createClearance(map(walls(40)),14)(p(130,96),p(230,96)),true);
  assert.equal(createClearance(map(walls(40)),25)(p(130,96),p(230,96)),false);
  assert.equal(createClearance(map(walls(60)),25)(p(130,96),p(230,96)),true);
  const m=map(walls(60),[{x:185,y:96,w:10,h:60,open:false}]);
  const before=createClearance(m,14); m.gates[0].open=true;
  assert.equal(before(p(130,96),p(230,96)),false);
  assert.equal(createClearance(m,14)(p(130,96),p(230,96)),true);
});

test('both navigation profiles have physical passages missed by 24 and recovered locally at 6', () => {
  for (const [radius,gap] of [[14,40],[25,60]]) {
    const scene=map([{x:180,y:0,w:10,h:48-gap/2},{x:180,y:48+gap/2,w:10,h:192-48-gap/2}]);
    const witness=createClearance(scene,radius);
    assert.equal(witness(p(130,48),p(230,48)),true,'continuous passage witness');
    const from=p(130,130),to=p(230,130);
    assert.equal(queryGraph(bakeGraph(scene,{radius,spacing:24}),from,to).status,'no-known-route');
    assert.equal(queryGraph(bakeGraph(scene,{radius,spacing:6}),from,to).status,'complete');
  }
});

test('interaction target near a wall uses a reachable stand with a valid hand reach', () => {
  const scene=map([{x:180,y:0,w:10,h:192,kind:'window'}]);
  const graph=bakeGraph(scene,{radius:14}),target=p(200,96),from=p(300,96),stand=p(218,96);
  assert.equal(queryGraph(graph,from,target).status,'invalid-endpoint');
  assert.equal(queryGraph(graph,from,stand).status,'complete');
  assert.ok(Math.hypot(target.x-stand.x,target.y-stand.y)<45);
  assert.equal(reachClear(scene,stand,target),true);
  assert.equal(reachClear(scene,p(165,96),target),false,'window blocks hands across wall');
});
