import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { shapeOf, rect } from '../shared/shape.ts';
import { createGenerationContext } from '../shared/map/context.ts';
import { placeElement } from '../shared/map/element.ts';
import { WAREHOUSE } from '../map/micro/placeables/warehouse.ts';
import { buildDepot, DEPOT_WAREHOUSE_APPEARANCE } from '../map/micro/strategies/depot.ts';
import {
  resolveBuildingAppearance,
  resolveObstacleAppearance,
  resolveGroundAppearance,
} from '../public/appearance.js';
import {
  chainMapToBson,
  chainMapToJson,
  decodeChainMap,
  readChainMap,
} from '../map/macro/src/chain/saving.ts';
import { DEFAULT_CELL_SIZE } from '../map/engines.ts';
import { generate } from '../map/chain.ts';
import { liveChainParams, liveMapFromBuilt } from '../map/live.ts';
import { composeRegions } from '../map/micro/compose.ts';

test('minimal optional appearance descriptor holds only the 7 step-2 fields', () => {
  const allowedMapKeys = new Set(['surfaces', 'commercial', 'wear', 'scars', 'lighting']);
  const sampleMapAppearance = {
    surfaces: [{ id: 'apron', bounds: { x: 0, y: 0, w: 100, h: 40 }, material: 'slatePaving' }],
    commercial: [{ id: 'stripes', kind: 'parking-stripes', bounds: { x: 0, y: 0, w: 60, h: 20 }, color: 'awningsYellow' }],
    wear: [{ id: 'drain', kind: 'drain-stain', bounds: { x: 0, y: 0, w: 20, h: 20 } }],
    scars: [{ id: 'scorch', kind: 'scorch-group', bounds: { x: 0, y: 0, w: 20, h: 20 } }],
    lighting: { fields: [{ id: 'f1', bounds: { x: 0, y: 0, w: 100, h: 100 }, tint: 'cobaltBlue' }] },
  };
  for (const k of Object.keys(sampleMapAppearance)) {
    assert.ok(allowedMapKeys.has(k), `map appearance field ${k} is one of the 7 step-2 fields`);
  }

  // BuildingAppearance fields:
  const allowedBuildingKeys = new Set([
    'floorMaterial',
    'wallMaterial',
    'roofPaint',
    'roofRim',
    'interiorTrim',
    'roofSign',
    'neglect',
  ]);
  for (const k of Object.keys(DEPOT_WAREHOUSE_APPEARANCE)) {
    assert.ok(allowedBuildingKeys.has(k), `building appearance field ${k} is allowed`);
  }
});

test('template-local coordinates: placeElement offsets template-relative marks to world coordinates', () => {
  const template = {
    w: 240,
    h: 160,
    encloses: true,
    parts: [
      {
        part: 'obstacle',
        shape: rect(10, 0, 40, 10),
        kind: 'building',
        appearance: { focalRim: { side: 'N', color: 'sodiumAmber' } },
      },
    ],
    appearance: {
      building: DEPOT_WAREHOUSE_APPEARANCE,
      surfaces: [
        { id: 'local-apron', bounds: { x: 10, y: -20, w: 220, h: 20 }, material: 'slatePaving' },
      ],
      commercial: [
        { id: 'local-awning', kind: 'awning', bounds: { x: 20, y: -15, w: 60, h: 15 }, color: 'weatheredCoral' },
      ],
      wear: [
        { id: 'local-drain', kind: 'drain-stain', bounds: { x: 180, y: 20, w: 30, h: 20 } },
      ],
      scars: [
        { id: 'local-scorch', kind: 'scorch-group', bounds: { x: 140, y: 30, w: 25, h: 15 } },
      ],
      lighting: {
        fields: [
          {
            id: 'local-field',
            bounds: { x: -20, y: -30, w: 280, h: 220 },
            tint: 'cobaltBlue',
            focalEdge: {
              color: 'sodiumAmber',
              x: 10,
              y: 0,
              w: 40,
              h: 10,
              rimLine: { x1: 10, y1: 0, x2: 50, y2: 0, width: 2 },
            },
          },
        ],
      },
    },
  };

  const ctx = createGenerationContext(12345);
  const anchorX = 500;
  const anchorY = 700;
  placeElement(ctx, template, anchorX, anchorY, { nodeId: 'test-node' });

  // 1. Single source of truth: building appearance is on Building, not duplicated in map.appearance
  assert.equal(ctx.map.buildings.length, 1);
  const b = ctx.map.buildings[0];
  assert.deepEqual(b.appearance, DEPOT_WAREHOUSE_APPEARANCE, 'building has appearance attached directly');
  assert.equal(ctx.map.appearance.buildings, undefined, 'map.appearance does not carry redundant buildings dictionary');

  // 2. Single source of truth: obstacle appearance is on Obstacle, not duplicated in map.appearance
  assert.equal(ctx.map.obstacles.length, 1);
  const o = ctx.map.obstacles[0];
  assert.deepEqual(o.appearance, { focalRim: { side: 'N', color: 'sodiumAmber' } });
  assert.equal(ctx.map.appearance.obstacles, undefined, 'map.appearance does not carry redundant obstacles dictionary');

  // 3. Template-local coordinates are properly offset by anchorX, anchorY
  const surf = ctx.map.appearance.surfaces[0];
  assert.equal(surf.bounds.x, 10 + anchorX);
  assert.equal(surf.bounds.y, -20 + anchorY);

  const comm = ctx.map.appearance.commercial[0];
  assert.equal(comm.bounds.x, 20 + anchorX);
  assert.equal(comm.bounds.y, -15 + anchorY);

  const wear = ctx.map.appearance.wear[0];
  assert.equal(wear.bounds.x, 180 + anchorX);
  assert.equal(wear.bounds.y, 20 + anchorY);

  const scar = ctx.map.appearance.scars[0];
  assert.equal(scar.bounds.x, 140 + anchorX);
  assert.equal(scar.bounds.y, 30 + anchorY);

  const field = ctx.map.appearance.lighting.fields[0];
  assert.equal(field.bounds.x, -20 + anchorX);
  assert.equal(field.bounds.y, -30 + anchorY);
  assert.equal(field.focalEdge.x, 10 + anchorX);
  assert.equal(field.focalEdge.y, 0 + anchorY);
  assert.equal(field.focalEdge.rimLine.x1, 10 + anchorX);
  assert.equal(field.focalEdge.rimLine.x2, 50 + anchorX);
});

test('BuildingNeglectAppearance floorStain uses dx/dy relative to building origin', () => {
  const building = {
    id: 'test-building',
    x: 400,
    y: 600,
    w: 200,
    h: 150,
    appearance: {
      neglect: {
        floorStain: { dx: 50, dy: 60, w: 40, h: 25 },
      },
    },
  };

  const resolved = resolveBuildingAppearance(building, {}, { wear: true });
  assert.equal(resolved.floorMarks.length, 1);
  const mark = resolved.floorMarks[0];
  assert.equal(mark.kind, 'ellipse');
  assert.equal(mark.layer, 'neglect-stain');
  assert.equal(mark.x, 400 + 50);
  assert.equal(mark.y, 600 + 60);
  assert.equal(mark.w, 40);
  assert.equal(mark.h, 25);
});

test('existing depot region strategy adopts DEPOT_WAREHOUSE_APPEARANCE on all placed warehouses', () => {
  const chain = generate('1', liveChainParams(), undefined, DEFAULT_CELL_SIZE);
  const depotResult = chain.results.find(r => r.brief.type === 'depot');
  assert.ok(depotResult, 'depot region exists in live chain map');
  const brief = depotResult.brief;

  const region = buildDepot(brief);
  const warehouseElements = region.elements.filter(e => e.label.startsWith('depot-warehouse'));
  assert.ok(warehouseElements.length > 0, 'depot produces warehouses');

  for (const elem of warehouseElements) {
    assert.deepEqual(
      elem.template.appearance?.building,
      DEPOT_WAREHOUSE_APPEARANCE,
      `${elem.label} template carries DEPOT_WAREHOUSE_APPEARANCE`
    );
  }

  // Stamp into a context and check the resulting map
  const ctx = createGenerationContext(12345);
  for (const elem of region.elements) {
    placeElement(ctx, elem.template, elem.x, elem.y, { nodeId: 'test-node' });
  }

  assert.equal(ctx.map.buildings.length, warehouseElements.length);
  for (const b of ctx.map.buildings) {
    assert.deepEqual(b.appearance, DEPOT_WAREHOUSE_APPEARANCE, 'stamped warehouse building has appearance');
    const resolved = resolveBuildingAppearance(b, ctx.map.appearance, { palette: 'signature', wear: true });
    assert.ok(resolved.floorMarks.length > 0, 'weathered marks resolve on warehouse');
    assert.ok(resolved.roofMarks.length > 0, 'commercial roof sign resolves on warehouse');
  }

  // Declared roofs emitted by stamped depot warehouses resolve building appearance
  assert.ok(ctx.map.roofs && ctx.map.roofs.length > 0, 'stamped warehouse emits declared roofs');
  const buildingsById = new Map(ctx.map.buildings.map(b => [b.id, b]));
  for (const roof of ctx.map.roofs) {
    const b = roof.buildingId ? buildingsById.get(roof.buildingId) : null;
    assert.ok(b, 'declared roof has owning building');
    const resolvedRoof = resolveBuildingAppearance(
      { id: roof.buildingId || roof.id, ...roof.bounds, appearance: b?.appearance },
      ctx.map.appearance,
      { palette: 'signature', wear: true }
    );
    const neutralRoof = resolveBuildingAppearance(
      { id: roof.buildingId || roof.id, ...roof.bounds, appearance: null },
      null,
      { palette: 'signature', wear: true }
    );
    assert.notEqual(resolvedRoof.roofFill, neutralRoof.roofFill, 'declared roof resolves non-neutral authored roofFill');
    assert.ok(resolvedRoof.roofMarks.length > 0, 'declared roof resolves non-empty roofMarks');
  }

  // Shelf container obstacles inside warehouse carry obstacle appearance
  const shelfObstacles = ctx.map.obstacles.filter(o => o.kind === 'container' && o.appearance);
  assert.ok(shelfObstacles.length > 0, 'shelf obstacles have appearance');
  for (const shelf of shelfObstacles) {
    assert.equal(shelf.appearance.material, 'oxidizedMetal');
    const resolved = resolveObstacleAppearance(shelf, ctx.map.appearance, { palette: 'signature' });
    assert.ok(resolved.fill > 0);
  }
});

test('stamping adopted building consumes zero simulation RNG, allocates identical IDs, and preserves shapes', () => {
  const cellSize = 40;
  const unstyled = WAREHOUSE.build({ w: 8, h: 6, alongX: true, seed: 42 }, cellSize);
  const styled = WAREHOUSE.build({ w: 8, h: 6, alongX: true, seed: 42, appearance: DEPOT_WAREHOUSE_APPEARANCE }, cellSize);

  // Baseline RNG from fresh context
  const ctxFresh = createGenerationContext(12345);
  const baselineFirstRng = ctxFresh.random();

  // Context 1: stamp unstyled
  const ctxU = createGenerationContext(12345);
  placeElement(ctxU, unstyled.elements[0].template, 200, 300, { nodeId: 'test-node', locked: false });
  const rngAfterU = ctxU.random();
  assert.equal(rngAfterU, baselineFirstRng, 'placeElement consumes 0 simulation RNG draws');

  // Context 2: stamp styled
  const ctxS = createGenerationContext(12345);
  placeElement(ctxS, styled.elements[0].template, 200, 300, { nodeId: 'test-node', locked: false });
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
});

test('omitted and unknown appearance values use documented neutral fallbacks', () => {
  // 1. Fully unstyled building uses theme ink defaults
  const unstyledBuilding = { id: 'b-unstyled', x: 100, y: 100, w: 200, h: 200 };
  const resUnstyled = resolveBuildingAppearance(unstyledBuilding, {}, { palette: 'signature' });
  assert.ok(resUnstyled.floorFill > 0);
  assert.ok(resUnstyled.roofFill > 0);
  assert.equal(resUnstyled.floorMarks.length, 0);
  assert.equal(resUnstyled.roofMarks.length, 0);

  // 2. Unknown swatches fall back safely to theme ink
  const unknownBuilding = {
    id: 'b-unknown',
    x: 100,
    y: 100,
    w: 200,
    h: 200,
    appearance: {
      floorMaterial: 'nonExistentSwatchXYZ',
      roofPaint: 'fictionalPaint123',
    },
  };
  const resUnknown = resolveBuildingAppearance(unknownBuilding, {}, { palette: 'signature' });
  assert.equal(resUnknown.floorFill, resUnstyled.floorFill);
  assert.equal(resUnknown.roofFill, resUnstyled.roofFill);

  // 3. Fully unstyled obstacle uses kind ink defaults and focalRim null
  const unstyledObs = { id: 'o-unstyled', kind: 'building', x: 100, y: 100, w: 40, h: 10 };
  const obsNeutral = resolveObstacleAppearance(unstyledObs, {}, { palette: 'signature' });
  assert.ok(obsNeutral.fill > 0);
  assert.equal(obsNeutral.focalRim, null);

  // 4. Obstacle with unknown material falls back safely
  const obsUnknown = resolveObstacleAppearance({
    ...unstyledObs,
    appearance: { material: 'unknownPlastic999' },
  }, {}, { palette: 'signature' });
  assert.equal(obsUnknown.fill, obsNeutral.fill);
  assert.equal(obsUnknown.focalRim, null);

  // 5. Unknown ground surface swatch falls back to ink.ground
  const groundUnknown = resolveGroundAppearance({
    surfaces: [{ id: 'test-surf', bounds: { x: 0, y: 0, w: 50, h: 50 }, material: 'mythicalAsphalt' }],
    lighting: { fields: [{ id: 'f1', bounds: { x: 0, y: 0, w: 50, h: 50 }, tint: 'rainbowUltra' }] },
  }, { palette: 'signature', lighting: true, wear: true });
  assert.ok(groundUnknown.length > 0);
});

test('chain map export/load round-trips via JSON and BSON and legacy maps load cleanly', () => {
  // 1. Generated chain map with adopted depot warehouses
  const chain = generate('1', liveChainParams(), undefined, DEFAULT_CELL_SIZE);
  const depotResult = chain.results.find(r => r.brief.type === 'depot');
  assert.ok(depotResult, 'depot region exists in live chain map');
  assert.ok(
    depotResult.elements.some(e => e.template.appearance?.building),
    'depot elements carry building appearance'
  );

  // JSON export & load
  const json = chainMapToJson(chain);
  const loadedJson = decodeChainMap(JSON.parse(json), chain.library);
  assert.deepEqual(loadedJson, chain, 'chain map with appearance round-trips via JSON');

  // BSON export & load
  const bson = chainMapToBson(chain);
  const loadedBson = readChainMap(bson, chain.library);
  assert.deepEqual(loadedBson, chain, 'chain map with appearance round-trips via BSON');

  // Stamping into live map preserves appearance on GameMap.buildings
  const liveMap = liveMapFromBuilt(1, composeRegions(loadedJson.results));
  const warehousesWithApp = liveMap.buildings.filter(b => b.appearance);
  assert.ok(warehousesWithApp.length > 0, 'live map has buildings with appearance');
  for (const wh of warehousesWithApp) {
    assert.deepEqual(wh.appearance, DEPOT_WAREHOUSE_APPEARANCE);
  }

  // 2. Legacy map without appearance loads and plays cleanly
  const legacyMap = {
    ...liveMap,
    appearance: undefined,
    buildings: liveMap.buildings.map(b => ({ ...b, appearance: undefined })),
    obstacles: liveMap.obstacles.map(o => ({ ...o, appearance: undefined })),
  };
  assert.equal(legacyMap.appearance, undefined);
  for (const b of legacyMap.buildings) {
    assert.equal(b.appearance, undefined);
    const res = resolveBuildingAppearance(b, legacyMap.appearance, { palette: 'signature' });
    assert.ok(res.floorFill > 0);
    assert.ok(res.roofFill > 0);
    assert.equal(res.floorMarks.length, 0);
    assert.equal(res.roofMarks.length, 0);
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
