import test from 'node:test';
import assert from 'node:assert/strict';
import { createDepotExperimentCanvas } from '../map/micro/experiments/depot-canvas.ts';
import { rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const portals = [{id:'left',axis:'v',x:0,y:3,length:2},{id:'right',axis:'v',x:10,y:3,length:2}];
const brief = {id:'depot-test',seed:1,type:'test',cellSize:32,cells:cellsOf(10,8),zones:[],portals};
const element = (x,y,w,h) => ({label:'box',x,y,template:{w,h,parts:[{part:'obstacle',kind:'crate',shape:rect(0,0,w,h)}]}});
const assembly = (x,y,w,h,access) => ({elements:[element(x,y,w,h)], ...(access ? {access} : {})});
const make = (mode, b=brief) => { const result = createDepotExperimentCanvas(b,mode,[rect(0,124,320,8)]); assert.equal(result.ok,true,JSON.stringify(result)); return result.canvas; };
const snapshot = c => ({elements:c.elements, areas:c.addressed.areas, witness:c.diagnostics.finalWitness});

test('movable cord admits an island across a fixed route and rejects a true cut atomically', () => {
  const fixed = make('fixed'), movable = make('movable');
  const island = assembly(120,64,80,128);
  assert.equal(fixed.commit(island),false);
  assert.equal(movable.commit(island),true);
  assert.notDeepEqual(movable.diagnostics.initialWitness,movable.diagnostics.finalWitness);
  const before = snapshot(movable);
  assert.equal(movable.commit(assembly(224,0,32,256)),false);
  assert.deepEqual(snapshot(movable),before);
  assert.equal(movable.diagnostics.refusals['routing-or-canvas'],1);
});

test('new unreachable doorstep refuses without changing state, including with one portal', () => {
  const b = {...brief, portals:[portals[0]]}, c = make('movable',b);
  assert.equal(c.commit(assembly(144,0,32,256)),true);
  const before = snapshot(c);
  assert.equal(c.commit(assembly(224,96,32,32,[rect(192,96,32,32)])),false);
  assert.deepEqual(snapshot(c),before);
});

test('accepted operations replay deterministically, including empty areas', () => {
  for (const mode of ['fixed','movable']) {
    const a = make(mode), b = make(mode);
    for (const c of [a,b]) {
      assert.equal(c.markEmpty([rect(32,32,32,32)]),true);
      assert.equal(c.commit(assembly(64,32,32,32)),true);
      assert.equal(c.commit(assembly(224,192,32,32)),true);
    }
    assert.deepEqual(snapshot(a),snapshot(b));
  }
});

test('escaping physical geometry and a new obstructed doorstep leave accepted state untouched', () => {
  for (const mode of ['fixed', 'movable']) {
    const c = make(mode);
    assert.equal(c.markEmpty([rect(32,32,32,32)]),true);
    const before = snapshot(c);
    const escaping = {elements:[{label:'escape',x:64,y:64,template:{w:32,h:32,
      parts:[{part:'obstacle',kind:'crate',shape:rect(0,0,64,32)}]}}]};
    assert.equal(c.commit(escaping),false);
    assert.deepEqual(snapshot(c),before);
    assert.equal(c.commit(assembly(128,32,32,32,[rect(128,32,32,32)])),false);
    assert.deepEqual(snapshot(c),before);
  }
});
