import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { shapeOf } from '../shared/shape.ts';
import { createGenerationContext } from '../shared/map/context.ts';
import { placeElement } from '../shared/map/element.ts';
import {
  buildServiceFrontage,
  RETAIL_FRONTAGE_APPEARANCE,
  SERVICE_FRONTAGE_SLICE_APPEARANCE,
} from '../map/micro/building/service-frontage.ts';
import { HOUSE } from '../map/micro/placeables/house.ts';
import { WAREHOUSE } from '../map/micro/placeables/warehouse.ts';
import { buildDepot } from '../map/micro/strategies/depot.ts';
import {
  APPEARANCE_RECIPE_VERSION,
  resolveBuildingAppearance,
  resolveObstacleAppearance,
  resolveGroundAppearance,
} from '../public/appearance.js';
import {
  CHAIN_WIRE_VERSION,
  chainMapToBson,
  chainMapToJson,
  decodeChainMap,
  readChainMap,
} from '../map/macro/src/chain/saving.ts';
import { MACRO_VERSION } from '../map/macro/src/chain/map.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { SCHEMA, MIN_SCHEMA } from '../shared/recording.ts';
import { DEFAULT_CELL_SIZE } from '../map/engines.ts';
import { generate } from '../map/chain.ts';
import { liveChainParams, liveMapFromBuilt } from '../map/live.ts';
import { composeRegions } from '../map/micro/compose.ts';

test('minimal optional appearance descriptor holds only the 7 step-2 fields', () => {
  const allowedKeys = new Set(['surfaces', 'buildings', 'obstacles', 'commercial', 'wear', 'scars', 'lighting']);
  const sliceKeys = Object.keys(SERVICE_FRONTAGE_SLICE_APPEARANCE);
  for (const k of sliceKeys) {
    assert.ok(allowedKeys.has(k), `descriptor contains only approved slice fields: found '${k}'`);
  }
  assert.equal(sliceKeys.length, 7, 'holds exactly the 7 fields consumed by the step-2 slice');

  // Verify building descriptor fields
  const buildingKeys = new Set(['floorMaterial', 'wallMaterial', 'roofPaint', 'roofRim', 'interiorTrim', 'roofSign', 'neglect']);
  for (const k of Object.keys(RETAIL_FRONTAGE_APPEARANCE)) {
    assert.ok(buildingKeys.has(k), `building descriptor field '${k}' is in the minimal slice`);
  }
});

test('service frontage adopter produces identical collision geometry with and without appearance', () => {
  const cellSize = 40;
  const unstyled = buildServiceFrontage({ w: 6, h: 4, door: 'N' }, cellSize);
  const styled = buildServiceFrontage({ w: 6, h: 4, door: 'N', appearance: RETAIL_FRONTAGE_APPEARANCE }, cellSize);
  const fullSliceStyled = buildServiceFrontage({ w: 6, h: 4, door: 'N', appearance: SERVICE_FRONTAGE_SLICE_APPEARANCE }, cellSize);

  // Unstyled has no appearance metadata
  assert.equal(unstyled.template.appearance, undefined);
  // Styled carries the appearance descriptor
  assert.deepEqual(styled.template.appearance, RETAIL_FRONTAGE_APPEARANCE);
  assert.deepEqual(fullSliceStyled.template.appearance, SERVICE_FRONTAGE_SLICE_APPEARANCE);

  // Dimensions and footprint are byte-for-byte identical
  assert.equal(styled.template.w, unstyled.template.w);
  assert.equal(styled.template.h, unstyled.template.h);
  assert.deepEqual(styled.footprint, unstyled.footprint);
  assert.equal(styled.template.parts.length, unstyled.template.parts.length);

  // Every single part shape, kind, and offset is identical
  for (let i = 0; i < unstyled.template.parts.length; i++) {
    const pU = unstyled.template.parts[i];
    const pS = styled.template.parts[i];
    assert.equal(pS.part, pU.part);
    if (pU.part === 'obstacle' && pS.part === 'obstacle') {
      assert.equal(pS.kind, pU.kind);
      assert.deepEqual(shapeOf(pS.shape), shapeOf(pU.shape), `part ${i} collision shape unchanged`);
    } else if (pU.part === 'gate' && pS.part === 'gate') {
      assert.equal(pS.x, pU.x);
      assert.equal(pS.y, pU.y);
      assert.equal(pS.w, pU.w);
      assert.equal(pS.h, pU.h);
    }
  }

  // Roof cells, overhangs, and thresholds are identical
  assert.deepEqual(styled.template.roofs, unstyled.template.roofs);
  // Door decals are identical
  assert.deepEqual(styled.template.decals, unstyled.template.decals);
});

test('stamping adopted building consumes zero simulation RNG, allocates identical IDs, and preserves shapes', () => {
  const cellSize = 40;
  const unstyled = buildServiceFrontage({ w: 6, h: 4, door: 'N' }, cellSize);
  const styled = buildServiceFrontage({ w: 6, h: 4, door: 'N', appearance: SERVICE_FRONTAGE_SLICE_APPEARANCE }, cellSize);

  // Baseline RNG from fresh context
  const ctxFresh = createGenerationContext(12345);
  const baselineFirstRng = ctxFresh.random();

  // Context 1: stamp unstyled
  const ctxU = createGenerationContext(12345);
  placeElement(ctxU, unstyled.template, 200, 300, { nodeId: 'test-node', locked: false });
  const rngAfterU = ctxU.random();
  assert.equal(rngAfterU, baselineFirstRng, 'placeElement consumes 0 simulation RNG draws');

  // Context 2: stamp styled
  const ctxS = createGenerationContext(12345);
  placeElement(ctxS, styled.template, 200, 300, { nodeId: 'test-node', locked: false });
  const rngAfterS = ctxS.random();
  assert.equal(rngAfterS, baselineFirstRng, 'placeElement with appearance consumes 0 simulation RNG draws');
  assert.equal(rngAfterS, rngAfterU, 'styled and unstyled advance simulation RNG identically (0 draws)');

  // Verify nextId allocation order and sequence are identical:
  assert.equal(ctxU.map.buildings.length, ctxS.map.buildings.length);
  assert.equal(ctxU.map.obstacles.length, ctxS.map.obstacles.length);
  assert.equal(ctxU.map.gates.length, ctxS.map.gates.length);

  for (let i = 0; i < ctxU.map.buildings.length; i++) {
    assert.equal(ctxS.map.buildings[i].id, ctxU.map.buildings[i].id, `building ${i} ID matches`);
    assert.equal(ctxS.map.buildings[i].x, ctxU.map.buildings[i].x);
    assert.equal(ctxS.map.buildings[i].y, ctxU.map.buildings[i].y);
    assert.equal(ctxS.map.buildings[i].w, ctxU.map.buildings[i].w);
    assert.equal(ctxS.map.buildings[i].h, ctxU.map.buildings[i].h);
  }

  for (let i = 0; i < ctxU.map.obstacles.length; i++) {
    const oU = ctxU.map.obstacles[i];
    const oS = ctxS.map.obstacles[i];
    assert.equal(oS.id, oU.id, `obstacle ${i} ID matches`);
    assert.deepEqual(shapeOf(oS), shapeOf(oU), `obstacle ${i} collision shapeOf matches byte-for-byte`);
  }

  for (let i = 0; i < ctxU.map.gates.length; i++) {
    assert.equal(ctxS.map.gates[i].id, ctxU.map.gates[i].id, `gate ${i} ID matches`);
  }

  // Unstyled map has appearance undefined
  assert.equal(ctxU.map.appearance, undefined);

  // Styled map has appearance populated
  assert.ok(ctxS.map.appearance, 'map.appearance is populated when template carries appearance');
  assert.ok(ctxS.map.appearance.surfaces?.length, 'surfaces populated');
  assert.ok(ctxS.map.appearance.commercial?.length, 'commercial populated');
  assert.ok(ctxS.map.appearance.wear?.length, 'wear populated');
  assert.ok(ctxS.map.appearance.scars?.length, 'scars populated');
  assert.ok(ctxS.map.appearance.lighting?.fields?.length, 'lighting populated');

  // Coordinates are properly offset by placement position (200, 300)
  const surf = ctxS.map.appearance.surfaces[0];
  assert.equal(surf.bounds.x, 845 + 200);
  assert.equal(surf.bounds.y, 495 + 300);

  // Building appearance is registered on building and map.appearance.buildings
  const bId = ctxS.map.buildings[0].id;
  assert.ok(ctxS.map.appearance.buildings?.[bId], 'registered under building ID');
  assert.deepEqual(ctxS.map.buildings[0].appearance, ctxS.map.appearance.buildings[bId]);
});

test('existing HOUSE and WAREHOUSE building placeables accept optional appearance', () => {
  const cellSize = 40;

  // 1. HOUSE
  const houseUnstyled = HOUSE.build({ w: 4, h: 4, door: 'N', spaces: 1, seed: 0 }, cellSize);
  const houseStyled = HOUSE.build({ w: 4, h: 4, door: 'N', spaces: 1, seed: 0, appearance: RETAIL_FRONTAGE_APPEARANCE }, cellSize);
  assert.ok('elements' in houseUnstyled && 'elements' in houseStyled);
  assert.equal(houseUnstyled.elements[0].template.appearance, undefined);
  assert.deepEqual(houseStyled.elements[0].template.appearance, RETAIL_FRONTAGE_APPEARANCE);
  assert.deepEqual(shapeOf(houseStyled.elements[0].template.parts[0].shape), shapeOf(houseUnstyled.elements[0].template.parts[0].shape));

  // 2. WAREHOUSE
  const whUnstyled = WAREHOUSE.build({ w: 8, h: 6, alongX: true, seed: 1 }, cellSize);
  const whStyled = WAREHOUSE.build({ w: 8, h: 6, alongX: true, seed: 1, appearance: RETAIL_FRONTAGE_APPEARANCE }, cellSize);
  assert.ok('elements' in whUnstyled && 'elements' in whStyled);
  assert.equal(whUnstyled.elements[0].template.appearance, undefined);
  assert.deepEqual(whStyled.elements[0].template.appearance, RETAIL_FRONTAGE_APPEARANCE);
  assert.deepEqual(shapeOf(whStyled.elements[0].template.parts[0].shape), shapeOf(whUnstyled.elements[0].template.parts[0].shape));
});

test('depot region strategy adopts appearance descriptor when provided on brief', () => {
  const brief = {
    id: 'test-depot',
    seed: 42,
    type: 'depot',
    cellSize: 40,
    cells: Array.from({ length: 16 * 16 }, (_, i) => ({ x: i % 16, y: Math.floor(i / 16) })),
    portals: [{ id: 'p1', axis: 'h', x: 2, y: 0, length: 2 }],
    zones: [{ tier: 1, bonus: 0, lootChance: 0.1, cells: Array.from({ length: 16 * 16 }, (_, i) => ({ x: i % 16, y: Math.floor(i / 16) })) }],
  };

  const unstyled = buildDepot(brief);
  const styled = buildDepot({ ...brief, appearance: RETAIL_FRONTAGE_APPEARANCE });

  // Collision shapes and manifests match
  assert.equal(styled.elements.length, unstyled.elements.length);
  assert.deepEqual(styled.manifest, unstyled.manifest);
  for (let i = 0; i < unstyled.elements.length; i++) {
    assert.equal(styled.elements[i].label, unstyled.elements[i].label);
    assert.equal(styled.elements[i].x, unstyled.elements[i].x);
    assert.equal(styled.elements[i].y, unstyled.elements[i].y);
  }

  // The warehouse element in the styled build carries appearance
  const styledWh = styled.elements.find(e => e.label.startsWith('depot-warehouse-'));
  const unstyledWh = unstyled.elements.find(e => e.label.startsWith('depot-warehouse-'));
  assert.ok(styledWh?.template.appearance);
  assert.equal(unstyledWh?.template.appearance, undefined);
});

test('omitted and unknown appearance values use documented neutral fallbacks', () => {
  const building = { id: 'shop-test', x: 100, y: 100, w: 240, h: 160 };

  // 1. Omitted appearance (null/undefined)
  const neutral = resolveBuildingAppearance(building, null, { palette: 'signature', lighting: true, wear: true });
  assert.equal(neutral.floorMarks.length, 0);
  assert.equal(neutral.roofMarks.length, 0);

  // 2. Empty appearance object {}
  const empty = resolveBuildingAppearance(building, { buildings: { 'shop-test': {} } }, { palette: 'signature', lighting: true, wear: true });
  assert.equal(empty.floorFill, neutral.floorFill);
  assert.equal(empty.roofFill, neutral.roofFill);
  assert.equal(empty.roofEave, neutral.roofEave);
  assert.equal(empty.roofRim, neutral.roofRim);
  assert.equal(empty.floorMarks.length, 0);
  assert.equal(empty.roofMarks.length, 0);

  // 3. Unknown material and paint swatches fall back to active theme colors
  const unknownSwatches = resolveBuildingAppearance(building, {
    buildings: {
      'shop-test': {
        floorMaterial: 'fantasyMarbleGlow',
        wallMaterial: 'alienCrystal',
        roofPaint: 'laserMagentaGradient',
        roofRim: 'invisibleTrim',
      },
    },
  }, { palette: 'signature', lighting: false, wear: false });

  assert.equal(unknownSwatches.floorFill, neutral.floorFill);
  assert.equal(unknownSwatches.roofFill, neutral.roofFill);
  assert.equal(unknownSwatches.roofRim, neutral.roofRim);

  // 4. Unknown obstacle swatch falls back to base obstacle fill
  const obs = { id: 'wall-1', kind: 'building', x: 100, y: 100, w: 40, h: 14 };
  const obsNeutral = resolveObstacleAppearance(obs, null, { palette: 'signature', lighting: false, wear: false });
  const obsUnknown = resolveObstacleAppearance(obs, {
    obstacles: { 'wall-1': { material: 'nonexistentPlastic' } },
  }, { palette: 'signature', lighting: false, wear: false });
  assert.equal(obsUnknown.fill, obsNeutral.fill);
  assert.equal(obsUnknown.focalRim, null);

  // 5. Unknown ground surface swatch falls back to ink.ground
  const groundUnknown = resolveGroundAppearance({
    surfaces: [{ id: 'test-surf', bounds: { x: 0, y: 0, w: 50, h: 50 }, material: 'mythicalAsphalt' }],
    lighting: { fields: [{ id: 'f1', bounds: { x: 0, y: 0, w: 50, h: 50 }, tint: 'rainbowUltra' }] },
  }, { palette: 'signature', lighting: true, wear: true });
  assert.ok(groundUnknown.length > 0);
});

test('chain map export/load round-trips via JSON and BSON without wire version bump', () => {
  // Generate a chain map using liveChainParams so liveMapFromBuilt accepts it
  const chain = generate('1', liveChainParams(), undefined, DEFAULT_CELL_SIZE);
  assert.equal(CHAIN_WIRE_VERSION, 8, 'wire version stays at 8 without premature bump');
  assert.equal(REGION_TYPES_VERSION, 'types-56', 'region types version stays types-56');
  assert.equal(SCHEMA, 15, 'recording schema stays 15');
  assert.equal(MIN_SCHEMA, 0, 'recording minSchema stays 0');
  assert.equal(APPEARANCE_RECIPE_VERSION, 1, 'appearance recipe version stays 1');

  // Attach an element with appearance to the first result
  const frontage = buildServiceFrontage({ w: 6, h: 4, door: 'N', appearance: RETAIL_FRONTAGE_APPEARANCE }, DEFAULT_CELL_SIZE);
  chain.results[0].elements.push({
    label: 'retail-frontage-test',
    x: 0,
    y: 0,
    template: frontage.template,
  });

  // 1. JSON export & load
  const json = chainMapToJson(chain);
  const wireObj = JSON.parse(json);
  assert.equal(wireObj.layout.macro, MACRO_VERSION, 'wire format records MACRO_VERSION');
  assert.equal(wireObj.wire, CHAIN_WIRE_VERSION, 'wire format records CHAIN_WIRE_VERSION');
  const loadedJson = decodeChainMap(wireObj, chain.library);
  assert.deepEqual(loadedJson, chain, 'chain map with appearance round-trips via JSON');
  assert.deepEqual(
    loadedJson.results[0].elements.find(e => e.label === 'retail-frontage-test')?.template.appearance,
    RETAIL_FRONTAGE_APPEARANCE,
    'appearance descriptor survives JSON serialization and decode'
  );

  // 2. BSON export & load
  const bson = chainMapToBson(chain);
  const loadedBson = readChainMap(bson, chain.library);
  assert.deepEqual(loadedBson, chain, 'chain map with appearance round-trips via BSON');
  assert.deepEqual(
    loadedBson.results[0].elements.find(e => e.label === 'retail-frontage-test')?.template.appearance,
    RETAIL_FRONTAGE_APPEARANCE,
    'appearance descriptor survives BSON binary serialization and decode'
  );

  // 3. Live map stamping preserves appearance on GameMap
  const liveMap = liveMapFromBuilt(1, composeRegions(loadedJson.results));
  assert.ok(liveMap.appearance, 'live map inherits appearance from stamped elements');
  assert.ok(liveMap.buildings.some(b => b.appearance), 'live map buildings inherit appearance descriptor');
});

test('legacy maps without appearance load and play cleanly', () => {
  // Clean generated chain map with no appearance metadata
  const legacyChain = generate('1', liveChainParams(), undefined, DEFAULT_CELL_SIZE);
  const json = chainMapToJson(legacyChain);
  const loaded = decodeChainMap(JSON.parse(json), legacyChain.library);
  assert.deepEqual(loaded, legacyChain);

  const liveLegacy = liveMapFromBuilt(1, composeRegions(loaded.results));
  assert.equal(liveLegacy.appearance, undefined, 'legacy map has appearance undefined');
  for (const b of liveLegacy.buildings) {
    assert.equal(b.appearance, undefined);
  }

  // Resolvers on legacy map produce neutral appearance
  for (const b of liveLegacy.buildings) {
    const resolved = resolveBuildingAppearance(b, liveLegacy.appearance, { palette: 'signature' });
    assert.ok(resolved.floorFill > 0);
    assert.ok(resolved.roofFill > 0);
    assert.equal(resolved.floorMarks.length, 0);
    assert.equal(resolved.roofMarks.length, 0);
  }
});

test('presentation boundary invariant: shared, server, and map never import public/appearance.js', () => {
  for (const dir of ['shared', 'server', 'map']) {
    for (const file of readdirSync(dir, { recursive: true })) {
      if (!/\.(m?[jt]s)$/.test(file) || file.includes('node_modules')) continue;
      assert.ok(
        !/appearance\.js/.test(readFileSync(path.join(dir, file), 'utf8')),
        `${dir}/${file} must not import public/appearance.js`
      );
    }
  }
});
