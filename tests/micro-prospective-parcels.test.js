import test from 'node:test';
import assert from 'node:assert/strict';
import { createProspectiveParcels } from '../map/micro/prospective-parcels.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { rect, circle, polygon } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';
import { chainBrief } from './helpers/chain-briefs.js';
import { createBuilderCanvas } from '../map/micro/canvas.ts';

const cells = cellsOf(10, 8);
const portals = [{ id: 'left', axis: 'v', x: 0, y: 3, length: 2 }, { id: 'right', axis: 'v', x: 10, y: 3, length: 2 }];
const brief = (overrides = {}) => ({ id: 'prospective', seed: 1, type: 'test', cellSize: 32, cells, zones: [], portals: [], ...overrides });
const ready = (b = brief(), options) => { const result = createProspectiveParcels(b, options); assert.equal(result.ok, true, JSON.stringify(result)); return result.coordinator; };
const snapshot = c => ({ revision: c.revision, parcels: c.parcels, addressed: c.addressed.areas, elements: c.elements, witness: c.witness });
const element = (x=64, y=64) => ({ label: 'box', x, y, template: { w: 32, h: 32, parts: [{ part: 'obstacle', kind: 'crate', shape: rect(4,4,24,24) }] } });

test('long portals remain covered around an overlapping compound ring', () => {
  const b = brief({ cells: cellsOf(20,16),
    portals: [{id:'left',axis:'v',x:0,y:5,length:6},{id:'right',axis:'v',x:20,y:5,length:6}] });
  const initial = createProspectiveParcels(b), c = initial.coordinator;
  assert.deepEqual(initial.counters, {meshBuilds:0,sweeps:39,paths:19});
  const p = c.probeClaim([rect(240,160,160,32),rect(240,192,32,128),rect(368,192,32,128),rect(272,288,96,32),rect(240,160,64,32)]);
  assert.equal(p.ok,true);
  assert.deepEqual(p.counters, {meshBuilds:1,sweeps:181,paths:19});
  const h = c.acceptClaim(p.proposal).handle;
  const physical = p.proposal.area;
  assert.deepEqual(c.populate(h, { areas: physical, elements: [{label:'ring',x:0,y:0,template:{w:640,h:512,
    parts:physical.map(shape=>({part:'obstacle',kind:'wall',shape}))}}] }), {ok:true});
  assert.equal(validatePortalReach({...b,blockers:c.elements.flatMap(e=>elementShapes(e,true))},{search:'thorough'}).valid,true);
});

test('macro margins keep inherited internal clear strips distinct from retained fill', () => {
  const b = chainBrief({cells:cellsOf(12,10),cellSize:32,portals:[...portals.map(p=>p.id === 'right' ? {...p,x:12} : p)],
    internal:[{axis:'h',x:0,y:8,length:12}]});
  const c = ready(b);
  assert.equal(c.access.contains(rect(128,224,32,32)),true);
  assert.equal(c.fill.contains(rect(128,224,32,32)),false);
  const before = snapshot(c);
  assert.equal(c.tryClaim([rect(128,224,32,32)]).reason,'allocation');
  assert.deepEqual(snapshot(c),before);
  const claim = c.tryClaim([rect(128,64,64,128)]);
  assert.equal(claim.ok,true,JSON.stringify(claim));
  assert.equal(validatePortalReach({...b,blockers:c.parcels.flatMap(p=>p.area)},{search:'thorough'}).valid,true);
});

test('a useful island bends the cord; a separating cut fails atomically', () => {
  const b = brief({portals}), c = ready(b), before = c.witness;
  const claim = c.tryClaim([rect(120,64,80,128)]);
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.notDeepEqual(c.witness, before);
  assert.ok(c.witness.paths.some(p => p.length > 2));
  const assembly = { elements: [element(128,80)] };
  assert.deepEqual(c.populate(claim.handle, assembly), {ok:true});
  assert.deepEqual(c.settle(claim.handle,'populated'), {ok:true});
  assert.equal(validatePortalReach({ ...b, blockers: c.elements.flatMap(e => elementShapes(e, true)) }, {search:'thorough'}).valid, true);
  const saved = snapshot(c);
  assert.equal(c.tryClaim([rect(224,0,32,256)]).reason, 'external');
  assert.deepEqual(snapshot(c), saved);
});

test('interior terminals work without portals; an interior cut leaves state unchanged', () => {
  const c = ready(brief(), { terminals: [{x:48,y:128},{x:272,y:128}] });
  assert.equal(c.tryClaim([rect(120,64,80,128)]).ok, true);
  assert.ok(c.witness.paths.some(p => p.length > 2));
  const saved = snapshot(c);
  assert.equal(c.tryClaim([rect(224,0,32,256)]).reason, 'interior');
  assert.deepEqual(snapshot(c), saved);
});

test('proposals are detached, stale or forged proposals fail, and IDs advance only on acceptance', () => {
  const c = ready(), p = c.probeClaim([rect(32,32,32,32)]);
  assert.equal(p.ok,true);
  assert.equal(c.acceptClaim(structuredClone(p.proposal)).reason,'stale');
  p.proposal.area[0].x = 200;
  const accepted = c.acceptClaim(p.proposal);
  assert.equal(accepted.ok,true);
  assert.equal(accepted.handle.id,1);
  assert.equal(c.parcels[0].area[0].x,32);
  assert.equal(c.acceptClaim(p.proposal).reason,'stale');
  const old = c.probeClaim([rect(96,32,32,32)]);
  assert.equal(old.ok,true);
  assert.equal(c.tryClaim([rect(160,32,32,32)]).handle.id,2);
  const state = snapshot(c);
  assert.equal(c.acceptClaim(old.proposal).reason,'stale');
  assert.equal(c.tryClaim([rect(32,32,32,32)]).ok,false);
  assert.deepEqual(snapshot(c),state);
  assert.equal(c.tryClaim([rect(224,32,32,32)]).handle.id,3);
  const detached = c.addressed, saved = snapshot(c);
  detached.cells[0].x = 1000;
  detached.areas[0].x = 1000;
  assert.deepEqual(snapshot(c),saved);
});

test('extension preserves handle and populated content; settlement retains envelope', () => {
  const c = ready(), h = c.tryClaim([rect(64,64,32,32)]).handle;
  assert.equal(c.tryClaim([rect(64,96,32,32)],h).handle,h);
  assert.deepEqual(c.populate(h, {elements:[element()]}), {ok:true});
  const expanded = c.tryClaim([rect(96,64,32,32)],h);
  assert.equal(expanded.ok,true,JSON.stringify(expanded));
  assert.equal(expanded.handle,h);
  assert.equal(c.elements.length,1);
  assert.equal(c.cancel(h).reason,'populated');
  assert.deepEqual(c.settle(h,'populated'),{ok:true});
  assert.equal(c.tryClaim([rect(96,64,32,32)]).ok,false);
  assert.equal(c.parcels[0].settled,true);
});

test('empty settlement reserves its envelope and cancellation releases unpopulated allocation', () => {
  const c = ready(), h = c.tryClaim([rect(64,64,32,32)]).handle;
  assert.deepEqual(c.settle(h,'empty'),{ok:true});
  assert.equal(c.markEmpty([rect(64,64,32,32)]),false);
  assert.deepEqual(c.cancel(h),{ok:true});
  assert.equal(c.tryClaim([rect(64,64,32,32)]).ok,true);
});

test('populate checks physical roofs, enclosed bounds, spots, reserves and circles', () => {
  for (const change of [
    e => { e.template.roofs = [{cells:[{x:1,y:0}],cellSize:32}]; },
    e => { e.template.encloses = true; e.template.w = 64; },
    e => { e.template.parts.push({part:'spot',x:40,y:16}); },
    e => { e.template.parts.push({part:'reserve',x:32,y:0,w:8,h:8}); },
    e => { e.template.parts[0].shape = circle(31,16,3); },
  ]) {
    const c = ready(), h = c.tryClaim([rect(64,64,32,32)]).handle, e = element(); change(e);
    const saved = snapshot(c);
    assert.equal(c.populate(h,{elements:[e],areas:[rect(64,64,32,32)]}).ok,false);
    assert.deepEqual(snapshot(c),saved);
  }
  const c = ready(), h = c.tryClaim([rect(64,64,32,32)]).handle, e = element();
  e.template.parts[0].shape = circle(16,16,5);
  assert.deepEqual(c.populate(h,{elements:[e]}),{ok:true});
});

test('legacy canvas operations respect claims, fixed access and reduced fill', () => {
  const fillCells = cells.filter(c => c.x < 9), c = ready(brief({fillCells}), {fixedAccess:[rect(32,32,32,32)]});
  assert.equal(c.tryClaim([rect(32,32,32,32)]).ok,false);
  assert.equal(c.tryClaim([rect(288,32,32,32)]).ok,false);
  const h = c.tryClaim([rect(64,64,32,32)]).handle;
  assert.equal(c.commit({elements:[element()]}),false);
  assert.equal(c.markEmpty([rect(64,64,32,32)]),false);
  assert.deepEqual(c.cancel(h),{ok:true});
  assert.equal(c.commit({elements:[element()]}),true);
  assert.equal(c.tryClaim([rect(64,64,32,32)]).ok,false);
  const empty = ready();
  assert.equal(empty.markEmpty([circle(16,16,4)]),true);
  const state = snapshot(empty);
  assert.equal(empty.markEmpty([rect(32,32,32,32),rect(40,40,32,32)]),false);
  assert.deepEqual(snapshot(empty),state);
});

test('initialization and shuffling are deterministic', () => {
  assert.equal(createProspectiveParcels(brief({portals}), {budget:{maxSweeps:0}}).reason,'budget');
  assert.equal(createProspectiveParcels(brief({portals, cells:cells.filter(c => c.x !== 5 || c.y === 0)})).reason,'external');
  assert.equal(createProspectiveParcels(brief(), {terminals:[{x:-100,y:-100}]}).reason,'interior');
  const left = ready(), right = ready(brief({cells:[...cells].reverse()}));
  const a = [rect(32,32,32,32),rect(64,32,32,32)];
  assert.equal(left.tryClaim(a).ok,true);
  assert.equal(right.tryClaim([...a].reverse()).ok,true);
  assert.deepEqual(snapshot(left),snapshot(right));
});

test('extension cannot swallow populated access outside its envelope', () => {
  const c = ready(), h = c.tryClaim([rect(64,64,32,32)]).handle;
  assert.deepEqual(c.populate(h, {elements:[element()], access:[rect(104,64,16,32)]}), {ok:true});
  const before = snapshot(c);
  assert.equal(c.tryClaim([rect(96,64,32,32)],h).reason, 'allocation');
  assert.deepEqual(snapshot(c), before);
});

test('compound ring leaves its hole available; physical footprints cannot bridge it', () => {
  const c = ready(), ring = [rect(32,32,128,32), rect(32,128,128,32), rect(32,32,32,128), rect(128,32,32,128)];
  const claim = c.tryClaim(ring);
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(c.tryClaim([rect(80,80,32,32)]).ok, true);
  const crossing = element(32,32);
  crossing.template.parts[0].shape = rect(4,4,104,104);
  const before = snapshot(c);
  assert.equal(c.populate(claim.handle, {elements:[crossing], areas:[rect(32,32,16,16)]}).reason, 'allocation');
  assert.deepEqual(snapshot(c),before);
  const concave = ready();
  assert.equal(concave.tryClaim([polygon(32,32,[{x:0,y:0},{x:96,y:0},{x:96,y:32},{x:32,y:32},{x:32,y:96},{x:0,y:96}])]).ok,true);
  assert.equal(concave.tryClaim([rect(80,80,32,32)]).ok,true);
});

test('interior islands and boundary parcels bend physical routes at several cell scales', () => {
  for (const cellSize of [16,40,80]) for (const y of [2,0]) {
    const b = brief({cellSize, portals}), c = ready(b);
    const proposal = c.probeClaim([rect(3.75*cellSize,y*cellSize,2.5*cellSize,4*cellSize)]);
    assert.equal(proposal.ok,true,`${cellSize}, ${y}: ${JSON.stringify(proposal)}`);
    assert.ok(proposal.proposal.witness.paths.some(p => p.length > 2));
    assert.ok(proposal.counters.meshBuilds <= 1);
    assert.equal(c.acceptClaim(proposal.proposal).ok,true);
  }
});

test('a repair that exceeds its sweep budget refuses atomically with deterministic counters', () => {
  const initial = createProspectiveParcels(brief({portals}), {budget:{maxSweeps:20}});
  assert.equal(initial.ok,true);
  assert.deepEqual(initial.counters,{meshBuilds:0,sweeps:7,paths:3});
  const c = initial.coordinator, before = snapshot(c);
  const first = c.probeClaim([rect(120,64,80,128)]);
  assert.equal(first.reason,'budget');
  assert.deepEqual(first.counters,{meshBuilds:1,sweeps:20,paths:2});
  assert.deepEqual(c.probeClaim([rect(120,64,80,128)]),first);
  assert.deepEqual(snapshot(c),before);
});

test('oversized population is refused before expanding roof footprints', () => {
  const c = ready(), h = c.tryClaim([rect(64,64,32,32)]).handle, saved = snapshot(c);
  const e = element();
  e.template.roofs = [{cellSize:32,cells:Array.from({length:16385},()=>({x:0,y:0}))}];
  assert.deepEqual(c.populate(h,{elements:[e]}),{ok:false,reason:'budget'});
  assert.deepEqual(snapshot(c),saved);
});

test('incremental canvas writes publish only when canvas and routing both succeed', () => {
  const b = brief({portals}), c = ready(b);
  // A real cut passes the canvas but must not publish before routing refuses it.
  for (const part of [{part:'obstacle',kind:'wall',shape:rect(0,0,32,256)},
    {part:'reserve',x:0,y:0,w:32,h:256}]) {
    const cut = {elements:[{label:'cut',x:144,y:0,template:{w:32,h:256,parts:[part]}}]};
    assert.equal(createBuilderCanvas(b).commit(cut),true);
    const before = snapshot(c);
    assert.equal(c.commit(cut),false);
    assert.deepEqual(snapshot(c),before);
  }
  // Routing can repair this candidate, but its intent overlaps already empty intent.
  assert.equal(c.markEmpty([rect(120,64,80,128)]),true);
  const before = snapshot(c);
  assert.equal(c.commit({elements:[element(128,80)]}),false);
  assert.deepEqual(snapshot(c),before);
  const pending = c.probeClaim([rect(64,32,32,32)]);
  assert.equal(pending.ok,true);
  assert.equal(c.commit({elements:[element(224,64)]}),true);
  assert.equal(c.acceptClaim(pending.proposal).reason,'stale');
  const h = c.tryClaim([rect(64,64,32,32)]).handle;
  assert.deepEqual(c.populate(h,{elements:[element()]}),{ok:true});
  assert.deepEqual(c.cancel(c.tryClaim([rect(96,192,32,32)]).handle),{ok:true});
  assert.equal(c.elements.length,2); // Replay preserves all preceding incremental commits.
});

test('malformed fixed access is diagnosed before routing failure', () => {
  assert.throws(()=>createProspectiveParcels(brief({portals}),
    {fixedAccess:[rect(0,0,-1,1)],budget:{maxSweeps:0}}), {name:'TypeError',message:/Fixed access/});
});
