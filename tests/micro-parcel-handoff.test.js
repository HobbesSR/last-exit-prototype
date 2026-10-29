import test from 'node:test';
import assert from 'node:assert/strict';
import { createProspectiveParcels } from '../map/micro/prospective-parcels.ts';
import { prepareDelegation } from '../map/micro/delegation.ts';
import { cellsOf } from './helpers/cells.js';
import { chainBrief } from './helpers/chain-briefs.js';
import { rect } from '../shared/shape.ts';

const brief = chainBrief({cells:cellsOf(12,10),cellSize:32,portals:[]});
const offer = (key, x) => ({key,type:'empty',cells:cellsOf(3,3).map(c=>({x:c.x+x,y:c.y}))});
function setup() {
  const calls = [];
  const prepare = (offers, policy = {}) => prepareDelegation(brief, offers, {...policy, receiving:()=>null});
  const handoff = {prepareDelegation: prepare, delegate(offers,policy) { calls.push(structuredClone({offers,policy})); return {prepared:prepare(offers,policy),children:[]}; }};
  const result = createProspectiveParcels(brief,{handoff});
  assert.equal(result.ok,true);
  return {c:result.coordinator,calls};
}

test('handoff proposals are detached and revision-bound; cumulative plan executes once', () => {
  const {c,calls}=setup();
  const first=c.probeHandoff([offer('a',0)]);
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(c.acceptHandoff(structuredClone(first.proposal)).reason,'stale');
  first.proposal.prepared.retained.cells.length=0;
  assert.equal(c.acceptHandoff(first.proposal).ok,true);
  const stale=c.probeHandoff([offer('b',9)]);
  assert.equal(stale.ok,true,JSON.stringify(stale));
  assert.equal(c.markEmpty([rect(160,160,32,32)]),true);
  assert.equal(c.acceptHandoff(stale.proposal).reason,'stale');
  const second=c.probeHandoff([offer('b',9)]);
  assert.equal(second.ok,true,JSON.stringify(second));
  assert.equal(c.acceptHandoff(second.proposal).ok,true);
  assert.equal(c.executeHandoffs().ok,true);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].offers.map(o=>o.key),['a','b']);
  assert.equal(c.executeHandoffs().reason,'handoff');
});

test('handoff refuses partial preparation and protects parcel envelopes', () => {
  const {c,calls}=setup();
  assert.equal(c.tryClaim([rect(0,0,32,32)]).ok,true);
  const before=c.revision;
  const result=c.probeHandoff([offer('a',0)]);
  assert.equal(result.ok,false);
  assert.equal(c.revision,before);
  assert.equal(calls.length,0);
});

test('fixed access cannot move into child ownership, even where clear margins survive', () => {
  const prepare = (offers, policy = {}) => prepareDelegation(brief, offers, {...policy, receiving:()=>null});
  const handoff = {prepareDelegation:prepare, delegate:()=>{throw new Error('unexpected dispatch');}};
  const c = createProspectiveParcels(brief,{handoff,fixedAccess:[rect(32,32,16,16)]}).coordinator;
  const result = c.probeHandoff([offer('a',0)]);
  assert.equal(result.ok,false);
  assert.equal(c.revision,0);
});

test('content added after a handoff cannot anchor access in child threshold context', () => {
  const {c}=setup(), patch=offer('a',0);
  const p=c.probeHandoff([patch]);
  assert.equal(p.ok,true,JSON.stringify(p));
  assert.equal(c.acceptHandoff(p.proposal).ok,true);
  const child=new Set(patch.cells.map(p=>`${p.x},${p.y}`));
  const context=p.proposal.prepared.retained.clearCells.find(p=>child.has(`${p.x},${p.y}`));
  assert.ok(context);
  const before=state(c);
  assert.equal(c.commit({elements:[],access:[rect(context.x*32+8,context.y*32+8,8,8)]}),false);
  assert.deepEqual(state(c),before);
});

const state = c => ({revision:c.revision, witness:c.witness, parcels:c.parcels, elements:c.elements,
  addressed:c.addressed.areas, fill:c.fill.cells, access:c.access.cells});
const block = (x,y,w,h) => ({label:'wall',x,y,template:{w,h,parts:[{part:'obstacle',kind:'wall',shape:rect(0,0,w,h)}]}});

test('later offer rechecks the first receiver and rejects the whole trial atomically', () => {
  const parent=chainBrief({cells:cellsOf(9,6),cellSize:40});
  const seen=[], dispatched=[];
  const prepare=(offers,policy={})=>prepareDelegation(parent,offers,{...policy,receiving:(child,o)=>{
    seen.push([o.key,child.portals.length]);
    return o.key==='a' && child.portals.length>1 ? 'only accepts a pocket' : null;
  }});
  const handoff={prepareDelegation:prepare,delegate:(offers,policy)=>{dispatched.push(offers);return {prepared:prepare(offers,policy),children:[]};}};
  const c=createProspectiveParcels(parent,{handoff}).coordinator;
  const a={key:'a',type:'open',cells:cellsOf(3,3)};
  const b={key:'b',type:'open',cells:cellsOf(3,3).map(p=>({x:p.x,y:p.y+3}))};
  const first=c.probeHandoff([a]); assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(first.proposal.prepared.retained.portals.length,1);
  assert.deepEqual(first.proposal.witness.paths,[], 'one retained interface has no pairwise promise');
  assert.equal(c.acceptHandoff(first.proposal).ok,true);
  const before=state(c), result=c.probeHandoff([b]);
  assert.equal(result.reason,'rejected');
  assert.ok(seen.some(([key,count])=>key==='a' && count>1));
  assert.deepEqual(state(c),before);
  assert.equal(dispatched.length,0);
});

test('new crossing margins refuse both physical geometry and a pessimistic empty envelope', () => {
  const parent=chainBrief({cells:cellsOf(9,6),cellSize:40});
  const patch={key:'side',type:'open',cells:cellsOf(2,6).map(p=>({x:p.x+7,y:p.y}))};
  const baseline=prepareDelegation(parent,[patch],{receiving:()=>null});
  assert.equal(baseline.crossings[0].portal.y,2);
  for (const mode of ['physical','envelope']) {
    const calls=[];
    const prepare=(offers,policy={})=>prepareDelegation(parent,offers,{...policy,receiving:()=>null});
    const handoff={prepareDelegation:prepare,delegate:(...args)=>{calls.push(args); throw new Error('unexpected dispatch');}};
    const c=createProspectiveParcels(parent,{handoff}).coordinator;
    const obstruction=rect(240,40,40,40); // retained end cap of the new crossing, not offered ownership
    if (mode==='physical') assert.equal(c.commit({elements:[block(240,40,40,40)]}),true);
    else assert.equal(c.tryClaim([obstruction]).ok,true);
    const before=state(c), result=c.probeHandoff([patch]);
    assert.equal(result.reason,'rejected',mode);
    assert.deepEqual(state(c),before,mode);
    assert.equal(calls.length,0);
  }
});

test('a cell-connected retained region can still fail continuous hunter routing', () => {
  const {c,calls}=setup();
  // A ten-unit gap in this retained wall is narrower than a hunter. No portal
  // pair exists yet, so the first offer is valid under the one-interface exemption.
  assert.equal(c.tryClaim([rect(176,0,32,123),rect(176,133,32,187)]).ok,true);
  const first=c.probeHandoff([offer('a',0)]);
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(c.acceptHandoff(first.proposal).ok,true);
  const before=state(c), second=c.probeHandoff([offer('b',9)]);
  assert.equal(second.reason,'external',JSON.stringify(second));
  assert.deepEqual(state(c),before);
  assert.equal(calls.length,0);
});

test('a sole crossing must connect to an explicitly anchored interior terminal', () => {
  const calls=[];
  const prepare=(offers,policy={})=>prepareDelegation(brief,offers,{...policy,receiving:()=>null});
  const handoff={prepareDelegation:prepare,delegate:(...args)=>{calls.push(args);throw new Error('unexpected dispatch');}};
  const c=createProspectiveParcels(brief,{handoff,terminals:[{x:304,y:160}]}).coordinator;
  assert.equal(c.tryClaim([rect(176,0,32,123),rect(176,133,32,187)]).ok,true);
  const before=state(c), result=c.probeHandoff([offer('a',0)]);
  assert.equal(result.reason,'interior',JSON.stringify(result));
  assert.deepEqual(state(c),before);
  assert.equal(calls.length,0);
});

test('inherited child clear cells cannot become an interior bypass', async () => {
  const {discoverCordWitness}=await import('../map/micro/cord-witness.ts');
  const parent=chainBrief({cells:cellsOf(12,10),cellSize:32});
  // This inherited clear strip becomes child-owned, except for the crossing threshold.
  parent.clearCells=cellsOf(1,10).map(p=>({x:9,y:p.y}));
  parent.fillCells=parent.cells.filter(p=>p.x!==9);
  const terminals=[{x:100,y:40},{x:100,y:260}], wall=rect(0,70,256,20);
  const patch={key:'right',type:'open',cells:cellsOf(3,10).map(p=>({x:p.x+9,y:p.y}))};
  const prepare=(offers,policy={})=>prepareDelegation(parent,offers,{...policy,receiving:()=>null});
  const handoff={prepareDelegation:prepare,delegate:()=>{throw new Error('unexpected dispatch');}};
  const c=createProspectiveParcels(parent,{handoff,terminals}).coordinator;
  assert.equal(c.tryClaim([wall]).ok,true);
  const prepared=prepare([patch],{blockers:[wall]});
  assert.equal(prepared.rejected.length,0);
  assert.equal(discoverCordWitness(prepared.retained,[wall],terminals).ok,true, 'unfiltered child strip permits the bypass');
  const before=state(c), result=c.probeHandoff([patch]);
  assert.equal(result.reason,'interior',JSON.stringify(result));
  assert.deepEqual(state(c),before);
  const after=createProspectiveParcels(parent,{handoff,terminals}).coordinator;
  const proposal=after.probeHandoff([patch]);
  assert.equal(proposal.ok,true,JSON.stringify(proposal));
  assert.equal(after.acceptHandoff(proposal.proposal).ok,true);
  const accepted=state(after);
  assert.equal(after.tryClaim([wall]).reason,'interior', 'later claims keep the child-interior restriction');
  assert.deepEqual(state(after),accepted);
});
