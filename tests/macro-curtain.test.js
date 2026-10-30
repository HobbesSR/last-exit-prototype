import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../map/chain.ts';
import { readMap } from '../map/tools/core.ts';
import { GAME_ENGINES, GAME_REGION_TYPES } from '../map/engines.ts';
import { libraryFingerprint } from '../map/macro/src/coding.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { validateLibrary } from '../map/macro/src/chain/library.ts';
import { layoutViolations } from '../map/macro/src/chain/declared-grid.ts';
import { portalViolations } from '../map/macro/src/chain/regions.ts';
import { proofViolations } from '../map/macro/src/chain/proof.ts';
import { encodeChainMap, decodeChainMap, chainMapToBson, readChainMap } from '../map/macro/src/chain/saving.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { experimentCurtain } from '../tools/experiments/macro-curtain.mjs';

function fixture() {
  const map=generate('a',{mode:'playground',zoneWidth:1,zoneHeight:1});
  map.library=structuredClone(map.library);
  map.library.tiles.push({id:'test-plain',defaultCellClass:'open',orientations:[0]});
  map.layout.slots.forEach(slot => {slot.design='test-plain';slot.orientation=0;});
  map.layout.library=libraryFingerprint(map.library);
  map.results=mapViews(map).briefs.map(b => GAME_ENGINES.build(b));
  return map;
}

test('curtain authors a source-bound wall, valid portals and deterministic results', () => {
  const before=fixture(), frozen=structuredClone(before), out=experimentCurtain(before);
  assert.deepEqual(before,frozen); assert.equal(out.refusal,undefined);
  const {map,policy}=out, views=mapViews(map,GAME_ENGINES.compose);
  assert.equal(map.layout.library,libraryFingerprint(map.library));
  assert.deepEqual(validateLibrary(map.library,new Set([...GAME_REGION_TYPES,'experiment-curtain'])).errors,[]);
  assert.deepEqual(layoutViolations(views.declaredGrid),[]);
  assert.deepEqual(portalViolations(views.regions),[]);
  assert.deepEqual(proofViolations(views.proof,views.regions,map.library),[]);
  const curtain=map.results.find(r=>r.brief.type==='experiment-curtain');
  assert.equal(curtain.loot.length,0); assert.equal(curtain.elements.length,1);
  assert.equal(curtain.elements[0].template.parts.length,2);
  const shapes=elementShapes(curtain.elements[0],true);
  assert.deepEqual(validateFillConstraints(curtain.brief,shapes),[]);
  assert.equal(validatePortalReach({...curtain.brief,blockers:shapes},{search:'thorough'}).valid,true);
  assert.equal(policy.gateHeight,4);
  assert.deepEqual(decodeChainMap(encodeChainMap(map)),map);
  assert.deepEqual(readChainMap(chainMapToBson(map)),map);
  assert.throws(() => readMap(chainMapToBson(map)), /unknown|known region type|invalid/i);
  assert.throws(() => decodeChainMap(encodeChainMap(map,{results:false}),undefined,GAME_ENGINES), /not .*regenerate/);
  const reversed=structuredClone(before);
  reversed.layout.slots.reverse(); reversed.layout.setPieces.reverse();
  reversed.library.tiles.reverse(); reversed.library.tileSets.reverse(); reversed.library.setPieces.reverse(); reversed.library.setPieceClasses.reverse();
  const again=experimentCurtain(reversed);
  assert.deepEqual(again,out);
});

test('trims newly short portal remnants left beside the strip', () => {
  const before=generate('a',{mode:'playground',zoneWidth:1,zoneHeight:1});
  const {map,policy}=experimentCurtain(before);
  assert.ok(policy.trimmedSegments.length>0);
  assert.deepEqual(portalViolations(mapViews(map).regions),[]);
  const original=mapViews(before).resolved, after=mapViews(map).resolved;
  assert.deepEqual(after.cells.map(Boolean),original.cells.map(Boolean));
  for (let i=0;i<after.cells.length;i++) {
    const x=i%after.width;
    if (x<policy.x || x>=policy.x+policy.width) assert.equal(after.cells[i],original.cells[i]);
  }
});

test('refuses a core class in the strip and a nonrectangular strip', () => {
  const core=fixture(); core.library.cellClasses.open.coreElements={spawn:1};
  assert.equal(experimentCurtain(core).refusal,'core-class-intersection');
  const clipped=fixture(), x=Math.floor(mapViews(clipped).resolved.width/2)-2;
  const i=clipped.layout.slots.findIndex(s=>s.col===Math.floor(x/6) && s.row===1);
  clipped.layout.slots.splice(i,1);
  assert.equal(experimentCurtain(clipped).refusal,'nonrectangular-strip');
});
