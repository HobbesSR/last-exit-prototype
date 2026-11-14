import assert from 'node:assert/strict';
import test from 'node:test';
import { shapeOf, rect } from '../shared/shape.ts';
import { createGenerationContext } from '../shared/map/context.ts';
import { placeElement } from '../shared/map/element.ts';
import { WAREHOUSE } from '../map/micro/placeables/warehouse.ts';
import { HOUSE } from '../map/micro/placeables/house.ts';
import { buildBlock } from '../map/micro/strategies/block.ts';
import { buildMarket, MARKET_STALL_PRESETS } from '../map/micro/strategies/market.ts';
import { buildCompound, createCompoundAppearance, COMPOUND_RESIDENTIAL_PRESETS } from '../map/micro/strategies/compound.ts';
import { rng } from '../map/micro/random.ts';
import { buildPlant, PLANT_SHED_APPEARANCE } from '../map/micro/strategies/plant.ts';
import {
  buildPark,
  PARK_PAVILION_PRESETS,
  PARK_TREE_APPEARANCE,
} from '../map/micro/strategies/park.ts';
import {
  buildCheckpoint,
  CHECKPOINT_POST_PRESETS,
  CHECKPOINT_BARRIER_APPEARANCE,
} from '../map/micro/strategies/checkpoint.ts';
import { buildRuins, RUINS_BUILDING_PRESETS } from '../map/micro/strategies/ruins.ts';
import { buildRubble } from '../map/micro/strategies/rubble.ts';
import { buildCover } from '../map/micro/strategies/cover.ts';
import {
  buildOpen,
  OPEN_PARCEL_PRESETS,
  createOpenParcelAppearance,
} from '../map/micro/strategies/open.ts';
import {
  buildHall,
  HALL_BUILDING_PRESETS,
  HALL_PILLAR_APPEARANCE,
} from '../map/micro/strategies/hall.ts';
import { buildArrival, ARRIVAL_PLAZA_PRESETS } from '../map/micro/strategies/arrival.ts';
import { buildDeparture, DEPARTURE_EXIT_PRESETS } from '../map/micro/strategies/departure.ts';
import { buildCharging, CHARGING_RIG_PRESETS } from '../map/micro/strategies/charging.ts';
import { buildTransit, TRANSIT_STATION_PRESETS } from '../map/micro/strategies/transit.ts';

import { chainBrief } from './helpers/chain-briefs.js';
import { cellsOf } from './helpers/cells.js';
import { buildDepot, DEPOT_WAREHOUSE_APPEARANCE } from '../map/micro/strategies/depot.ts';
import {
  buildHut,
  RETAIL_STOREFRONT_PRESETS,
  RETAIL_STOREFRONT_INTACT,
  RETAIL_STOREFRONT_WEATHERED,
  RETAIL_STOREFRONT_DAMAGED,
} from '../map/micro/strategies/hut.ts';
import {
  resolveBuildingAppearance,
  resolveDeclaredRoofs,
  resolveObstacleAppearance,
  resolveGroundAppearance,
} from '../public/appearance.js';
import { brief as depotBrief, MASKS as DEPOT_MASKS } from './helpers/depot-fixtures.js';

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
    assert.ok(allowedBuildingKeys.has(k), `warehouse appearance field ${k} is allowed`);
  }
  for (const preset of RETAIL_STOREFRONT_PRESETS) {
    for (const k of Object.keys(preset)) {
      assert.ok(allowedBuildingKeys.has(k), `storefront appearance field ${k} is allowed`);
    }
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
  // A stored depot brief (the fixtures' field mask), not a generated map's: building a map is slow-tier work (31, #1071).
  const region = buildDepot(depotBrief('field', 1, ...DEPOT_MASKS.field));
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
  // Resolved through the same function the scene draws roofs with (#725).
  const opts = { palette: 'signature', wear: true };
  const declared = resolveDeclaredRoofs(ctx.map, opts);
  assert.equal(declared.length, ctx.map.roofs.length);
  const buildingIds = new Set(ctx.map.buildings.map(b => b.id));
  for (const { roof, resolved } of declared) {
    assert.ok(buildingIds.has(roof.buildingId), 'declared roof has owning building');
    const neutralRoof = resolveBuildingAppearance({ id: roof.buildingId, ...roof.bounds, appearance: null }, null, opts);
    assert.notEqual(resolved.roofFill, neutralRoof.roofFill, 'declared roof resolves non-neutral authored roofFill');
    assert.ok(resolved.roofMarks.length > 0, 'declared roof resolves non-empty roofMarks');
  }
  for (const id of new Set(ctx.map.roofs.map(r => r.buildingId))) {
    assert.equal(declared.filter(d => d.roof.buildingId === id && d.primary).length, 1, 'each building has one primary roof');
  }

  // Shelf container obstacles inside warehouse carry obstacle appearance
  const shelfObstacles = ctx.map.obstacles.filter(o => o.kind === 'container' && o.appearance);
  assert.ok(shelfObstacles.length > 0, 'shelf obstacles have appearance');
  assert.equal(ctx.map.appearance, undefined, 'generated depot map carries no map-wide appearance');
  for (const shelf of shelfObstacles) {
    assert.equal(shelf.appearance.material, 'oxidizedMetal');
    const resolved = resolveObstacleAppearance(shelf, ctx.map.appearance, { palette: 'signature' });
    assert.ok(resolved.fill > 0);
    const unstyledCrate = { id: 'c-unstyled', kind: 'container', color: 0, x: shelf.x, y: shelf.y, w: shelf.w, h: shelf.h };
    const resolvedUnstyled = resolveObstacleAppearance(unstyledCrate, null, { palette: 'signature' });
    assert.notEqual(resolved.fill, resolvedUnstyled.fill, 'shelf oxidizedMetal fill differs from unstyled crate fill');
  }
});

test('HOUSE placeable attaches appearance when provided and leaves undefined when omitted', () => {
  const cellSize = 40;
  // 1. One-space house without appearance
  const unstyledOne = HOUSE.build({ w: 4, h: 4, door: 'S', spaces: 1, seed: 0 }, cellSize);
  assert.equal(unstyledOne.elements[0].template.appearance, undefined);

  // 2. One-space house with storefront intact appearance
  const styledOne = HOUSE.build({ w: 4, h: 4, door: 'S', spaces: 1, seed: 0, appearance: RETAIL_STOREFRONT_INTACT }, cellSize);
  assert.deepEqual(styledOne.elements[0].template.appearance, { building: RETAIL_STOREFRONT_INTACT });

  // 3. Multi-space house without appearance
  const unstyledMulti = HOUSE.build({ w: 6, h: 4, door: 'N', spaces: 2, seed: 5 }, cellSize);
  assert.equal(unstyledMulti.elements[0].template.appearance, undefined);

  // 4. Multi-space house with storefront weathered appearance
  const styledMulti = HOUSE.build({ w: 6, h: 4, door: 'N', spaces: 2, seed: 5, appearance: RETAIL_STOREFRONT_WEATHERED }, cellSize);
  assert.deepEqual(styledMulti.elements[0].template.appearance, { building: RETAIL_STOREFRONT_WEATHERED });
});

test('existing hut region strategy adopts commercial retail storefront appearance presets across decay tiers', () => {
  const tiersSeen = new Set();
  const allHutBuildings = [];
  const neglected = mark => new Set(allHutBuildings.map(b => b.template.appearance.building.neglect)
    .filter(neglect => neglect?.[mark] && (mark === 'scorchMark' || !neglect.scorchMark))
    .map(neglect => `${neglect[mark].dx},${neglect[mark].dy}`)).size;
  // Each building rolls its own tier, so the sample stops at the first seed whose buildings show
  // every tier and two distinct scorch and drain placements, rather than building ten regions (#807).
  const witnessed = () => tiersSeen.size === 3 && neglected('scorchMark') > 1 && neglected('roofDrainStain') > 1;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    if (witnessed()) break;
    const brief = chainBrief({
      id: `hut-test-${seed}`,
      type: 'hut',
      seed,
      cells: cellsOf(32, 24),
      portals: [
        { id: 'w', axis: 'v', x: 0, y: 8, length: 3 },
        { id: 'e', axis: 'v', x: 32, y: 12, length: 3 },
      ],
    });
    const region = buildHut(brief);
    const buildings = region.elements.filter(e => /^hut-building(?:-\d+)?$/.test(e.label));
    assert.ok(buildings.length > 0, `hut generates buildings for seed ${seed}`);

    for (const b of buildings) {
      const app = b.template.appearance?.building;
      assert.ok(app, `${b.label} carries building appearance`);
      assert.ok(app.roofSign, `${b.label} carries commercial roofSign`);
      allHutBuildings.push(b);

      if (!app.neglect) tiersSeen.add('intact');
      else if (app.neglect.scorchMark) tiersSeen.add('damaged');
      else tiersSeen.add('weathered');
    }
  }

  assert.equal(tiersSeen.size, 3, 'all 3 decay tiers (intact, weathered, damaged) appear across seed sample');

  // Verify non-repeating wear and scorch placement across buildings (no identical repeated coordinates):
  const damaged = allHutBuildings.filter(b => b.template.appearance?.building?.neglect?.scorchMark);
  assert.ok(damaged.length > 0, 'sample contains competition-damaged buildings');
  const scorchCoords = new Set(damaged.map(b => {
    const sc = b.template.appearance.building.neglect.scorchMark;
    return `${sc.dx},${sc.dy}:${sc.w}x${sc.h}`;
  }));
  assert.ok(scorchCoords.size > 1, 'damaged buildings do not repeat identical scorch mark coordinates/sizes');

  const weathered = allHutBuildings.filter(b => b.template.appearance?.building?.neglect?.roofDrainStain && !b.template.appearance?.building?.neglect?.scorchMark);
  assert.ok(weathered.length > 0, 'sample contains weathered buildings');
  const drainCoords = new Set(weathered.map(b => {
    const ds = b.template.appearance.building.neglect.roofDrainStain;
    return `${ds.dx},${ds.dy}`;
  }));
  assert.ok(drainCoords.size > 1, 'weathered buildings do not repeat identical drain stain coordinates');

  // Verify damaged storefront resolves scorch group on roof and soot mark on floor
  const damagedSample = damaged[0];
  const resolvedDamaged = resolveBuildingAppearance({ id: 'dmg-1', x: 100, y: 100, w: 200, h: 160, appearance: damagedSample.template.appearance.building }, {}, { wear: true });
  assert.ok(resolvedDamaged.roofMarks.some(m => m.layer === 'wear-scorch-halo'), 'damaged building resolves scorch halo on roof');
  assert.ok(resolvedDamaged.roofMarks.some(m => m.layer === 'wear-scorch-core'), 'damaged building resolves scorch core on roof');
  assert.ok(resolvedDamaged.roofMarks.some(m => m.layer === 'wear-scorch-streak'), 'damaged building resolves scorch blast streak on roof');
  assert.ok(resolvedDamaged.floorMarks.some(m => m.layer === 'neglect-stain'), 'damaged building resolves soot stain on floor');

  // Verify stamping and presentation resolution on a styled hut
  const sampleBrief = chainBrief({
    id: 'hut-sample',
    type: 'hut',
    seed: 1,
    cells: cellsOf(32, 24),
    portals: [
      { id: 'w', axis: 'v', x: 0, y: 8, length: 3 },
      { id: 'e', axis: 'v', x: 32, y: 12, length: 3 },
    ],
  });
  const sampleRegion = buildHut(sampleBrief);
  const ctx = createGenerationContext(99999);
  for (const elem of sampleRegion.elements) {
    placeElement(ctx, elem.template, elem.x, elem.y, { nodeId: sampleBrief.id });
  }

  assert.ok(ctx.map.buildings.length > 0);
  for (const b of ctx.map.buildings) {
    assert.ok(b.appearance, 'stamped hut building carries appearance');
    const resolved = resolveBuildingAppearance(b, {}, { palette: 'signature', wear: true });
    assert.ok(resolved.floorFill > 0);
    assert.ok(resolved.roofFill > 0);
    assert.ok(resolved.roofMarks.length > 0, 'stamped hut resolves roofMarks (sign backing / sign / stripe)');
  }
});

test('stamping styled HOUSE consumes zero simulation RNG, allocates identical IDs, and preserves shapes', () => {
  const cellSize = 40;
  const unstyled = HOUSE.build({ w: 6, h: 4, door: 'N', spaces: 2, seed: 17 }, cellSize);
  const styled = HOUSE.build({ w: 6, h: 4, door: 'N', spaces: 2, seed: 17, appearance: RETAIL_STOREFRONT_DAMAGED }, cellSize);

  const ctxFresh = createGenerationContext(54321);
  const baselineFirstRng = ctxFresh.random();

  const ctxU = createGenerationContext(54321);
  placeElement(ctxU, unstyled.elements[0].template, 120, 160, { nodeId: 'test-node', locked: false });
  const rngAfterU = ctxU.random();
  assert.equal(rngAfterU, baselineFirstRng, 'placeElement on HOUSE consumes 0 simulation RNG');

  const ctxS = createGenerationContext(54321);
  placeElement(ctxS, styled.elements[0].template, 120, 160, { nodeId: 'test-node', locked: false });
  const rngAfterS = ctxS.random();
  assert.equal(rngAfterS, baselineFirstRng, 'placeElement on styled HOUSE consumes 0 simulation RNG');
  assert.equal(rngAfterS, rngAfterU, 'styled and unstyled HOUSE advance simulation RNG identically');

  assert.equal(ctxU.map.buildings.length, ctxS.map.buildings.length);
  assert.equal(ctxU.map.obstacles.length, ctxS.map.obstacles.length);
  assert.equal(ctxU.map.gates.length, ctxS.map.gates.length);

  for (let i = 0; i < ctxU.map.buildings.length; i++) {
    assert.equal(ctxS.map.buildings[i].id, ctxU.map.buildings[i].id);
    assert.equal(ctxS.map.buildings[i].x, ctxU.map.buildings[i].x);
    assert.equal(ctxS.map.buildings[i].y, ctxU.map.buildings[i].y);
    assert.equal(ctxS.map.buildings[i].w, ctxU.map.buildings[i].w);
    assert.equal(ctxS.map.buildings[i].h, ctxU.map.buildings[i].h);
  }

  for (let i = 0; i < ctxU.map.obstacles.length; i++) {
    const oU = ctxU.map.obstacles[i];
    const oS = ctxS.map.obstacles[i];
    assert.equal(oS.id, oU.id);
    assert.deepEqual(shapeOf(oS), shapeOf(oU), `HOUSE obstacle ${i} collision shapeOf matches byte-for-byte`);
  }
});

test('block region strategy propagates storefront appearance to child hut lots', () => {
  const brief = chainBrief({
    id: 'block-retail-test',
    type: 'block',
    seed: 3,
    cells: cellsOf(28, 20),
    portals: [
      { id: 'w', axis: 'v', x: 0, y: 10, length: 2 },
      { id: 'e', axis: 'v', x: 28, y: 10, length: 2 },
    ],
  });
  const region = buildBlock(brief);
  const hutBuildings = region.elements.filter(e => e.label.includes('hut-building'));
  assert.ok(hutBuildings.length > 0, 'block region contains at least one hut building');
  for (const b of hutBuildings) {
    const app = b.template.appearance?.building;
    assert.ok(app, `block hut building ${b.label} carries appearance`);
    assert.ok(app.roofSign, `block hut building ${b.label} carries storefront roofSign`);
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

test('market region strategy adopts fabric awnings across decay tiers', () => {
  const allowedKeys = new Set(['floorMaterial', 'wallMaterial', 'roofPaint', 'roofRim', 'interiorTrim', 'roofSign', 'neglect']);
  for (const preset of MARKET_STALL_PRESETS) {
    for (const k of Object.keys(preset)) {
      assert.ok(allowedKeys.has(k), `market stall appearance field ${k} is allowed`);
    }
  }

  // A chain-like brief, not a generated map's: building a map is slow-tier work (31, #1071).
  const region = buildMarket(chainBrief({ type: 'market', cells: cellsOf(24, 24), parameters: { spacing: 6, roofed: true } }));
  assert.ok(region.elements.length > 0, 'market produces stall elements');

  // Stalls have appearance on roofs
  const stallsWithApp = region.elements.filter(e => e.template.roofs?.some(r => r.appearance));
  assert.ok(stallsWithApp.length > 0, 'market stalls have appearance on their awning roofs');


  // Stamping into context resolves cleanly
  const ctx = createGenerationContext(24680);
  for (const elem of region.elements) {
    placeElement(ctx, elem.template, elem.x, elem.y, { nodeId: 'market-node' });
  }
  assert.ok(ctx.map.roofs && ctx.map.roofs.length > 0, 'market emits roofs into map');
  for (const roof of ctx.map.roofs) {
    const resolved = resolveBuildingAppearance({ id: roof.id, ...roof.bounds, appearance: roof.appearance }, ctx.map.appearance, { palette: 'signature' });
    assert.ok(resolved.roofFill > 0, 'market stall awning resolves non-zero roof fill');
  }
});

test('compound region strategy adopts residential/office block appearance and courtyard paving', () => {
  const allowedKeys = new Set(['floorMaterial', 'wallMaterial', 'roofPaint', 'roofRim', 'interiorTrim', 'roofSign', 'neglect']);
  for (const preset of COMPOUND_RESIDENTIAL_PRESETS) {
    for (const k of Object.keys(preset)) {
      assert.ok(allowedKeys.has(k), `compound appearance field ${k} is allowed`);
    }
  }

  const brief = chainBrief({ type: 'compound', cells: cellsOf(20, 20), seed: 42, portals: [{ id: 'p1', side: 'N', axis: 'h', x: 8, y: 0, length: 4, partner: 'other' }] });
  const region = buildCompound(brief);
  assert.ok(region.elements.length > 0, 'compound produces ring and courtyard elements');

  // Courtyard paving surface on first element
  const firstElem = region.elements[0];
  assert.ok(firstElem.template.appearance?.surfaces?.some(s => s.id?.includes('court-paving')), 'courtyard paving surface emitted');

  // Stamping into context
  const ctx = createGenerationContext(35791);
  for (const elem of region.elements) {
    placeElement(ctx, elem.template, elem.x, elem.y, { nodeId: 'compound-node' });
  }
  assert.ok(ctx.map.roofs && ctx.map.roofs.length > 0, 'compound emits roofs');
  for (const roof of ctx.map.roofs) {
    const resolved = resolveBuildingAppearance({ id: roof.id, ...roof.bounds, appearance: roof.appearance }, ctx.map.appearance, { palette: 'signature' });
    assert.ok(resolved.roofFill > 0, 'compound room roof resolves non-zero fill');
  }

  // Damaged compound has scars on room pieces with non-repeating offsets across rooms:
  const damagedBrief = chainBrief({ type: 'compound', cells: cellsOf(20, 20), seed: 2, portals: [{ id: 'p1', side: 'N', axis: 'h', x: 8, y: 0, length: 4, partner: 'other' }] });
  const ringAppSeed = Math.floor(rng(damagedBrief.seed, `${damagedBrief.id}:compound-appearance`).next() * 2 ** 31);
  const tierRoll = rng(ringAppSeed, 'compound-tier').next();
  assert.ok(tierRoll >= 0.7, `seed 2 explicitly rolls damaged tier (${tierRoll.toFixed(3)} >= 0.7)`);
  const damagedRegion = buildCompound(damagedBrief);
  const damagedRooms = damagedRegion.elements.filter(e => e.label.startsWith('compound-room') && e.template.appearance?.building?.neglect?.scorchMark);
  assert.ok(damagedRooms.length > 0, 'damaged compound has at least one scorch scar on some room piece');
  const scorchOffsets = new Set(damagedRooms.map(r => `${r.template.appearance.building.neglect.scorchMark.dx},${r.template.appearance.building.neglect.scorchMark.dy}`));
  assert.equal(scorchOffsets.size, damagedRooms.length, 'no two compound room pieces share identical scorch mark offsets');

  // Direct helper test with explicit roll:
  const explicitDamaged = createCompoundAppearance({ seed: 42, roll: 0.85, w: 160, h: 120 });
  assert.equal(explicitDamaged.roofPaint, 'dirtyCream', 'explicit roll >= 0.7 selects damaged preset');
  assert.ok(explicitDamaged.neglect?.scorchMark, 'explicit roll >= 0.7 generates scorch mark');
  assert.ok(explicitDamaged.neglect.scorchMark.dx >= 0 && explicitDamaged.neglect.scorchMark.dx <= 160, 'scorch mark dx bounded by w');
  assert.ok(explicitDamaged.neglect.scorchMark.dy >= 0 && explicitDamaged.neglect.scorchMark.dy <= 120, 'scorch mark dy bounded by h');

  const explicitIntact = createCompoundAppearance({ seed: 42, roll: 0.1, w: 160, h: 120 });
  assert.equal(explicitIntact.roofPaint, 'fadedViolet', 'explicit roll < 0.35 selects intact preset');
  assert.equal(explicitIntact.neglect?.scorchMark, undefined, 'intact tier has no scorch mark');
});

test('plant region strategy adopts industrial shed appearance, cooling towers, and substation machinery', () => {
  const allowedKeys = new Set(['floorMaterial', 'wallMaterial', 'roofPaint', 'roofRim', 'interiorTrim', 'roofSign', 'neglect']);
  for (const k of Object.keys(PLANT_SHED_APPEARANCE)) {
    assert.ok(allowedKeys.has(k), `plant shed appearance field ${k} is allowed`);
  }

  const brief = chainBrief({ type: 'plant', cells: cellsOf(24, 24), seed: 42 });
  const region = buildPlant(brief);
  assert.ok(region.elements.length > 0, 'plant produces machines and shed');


  // Machinery with obstacle appearances
  const machines = region.elements.filter(e => e.label.startsWith('plant-machine'));
  assert.ok(machines.length > 0, 'plant produces machine elements');
  const styledMachines = machines.filter(e => e.template.parts.some(p => p.part === 'obstacle' && p.appearance));
  assert.ok(styledMachines.length > 0, 'plant machines carry obstacle appearance');

  // Stamping into context
  const ctx = createGenerationContext(46802);
  for (const elem of region.elements) {
    placeElement(ctx, elem.template, elem.x, elem.y, { nodeId: 'plant-node' });
  }
  const styledObstacles = ctx.map.obstacles.filter(o => o.appearance);
  assert.ok(styledObstacles.length > 0, 'stamped plant obstacles carry appearance');
  for (const o of styledObstacles) {
    const res = resolveObstacleAppearance(o, ctx.map.appearance, { palette: 'signature' });
    assert.ok(res.fill > 0, 'machine obstacle resolves non-zero fill');
  }
});

test('declared roofs: primary roof per building and appearance fallback (#725)', () => {
  const appearance = DEPOT_WAREHOUSE_APPEARANCE;
  const cell = { origin: { x: 0, y: 0 }, cellSize: 24, cells: [{ x: 0, y: 0 }] };
  const building = { id: 'b1', x: 100, y: 100, w: 96, h: 96, appearance };
  const map = {
    buildings: [building],
    roofs: [
      { id: 'far', buildingId: 'b1', bounds: { x: 300, y: 300, w: 48, h: 48 }, ...cell },
      { id: 'covering', buildingId: 'b1', bounds: { x: 96, y: 96, w: 48, h: 48 }, ...cell },
      { id: 'tie', buildingId: 'b1', bounds: { x: 90, y: 90, w: 48, h: 48 }, ...cell },
      { id: 'own', bounds: { x: 0, y: 0, w: 48, h: 48 }, appearance, ...cell },
      { id: 'orphan', buildingId: 'missing', bounds: { x: 0, y: 200, w: 48, h: 48 }, appearance, ...cell },
    ],
  };
  const opts = { palette: 'signature', wear: true };
  const byId = new Map(resolveDeclaredRoofs(map, opts).map(d => [d.roof.id, d]));
  assert.deepEqual([...byId.keys()], ['far', 'covering', 'tie', 'own', 'orphan'], 'map.roofs order');
  assert.equal(byId.get('covering').primary, true, 'covering roof is primary');
  assert.equal(byId.get('tie').primary, false, 'first covering roof wins a tie');
  assert.equal(byId.get('far').primary, false, 'distant roof is not primary');
  assert.equal(byId.get('own').primary, true, 'roof without a building is its own primary');
  assert.equal(byId.get('orphan').primary, false, 'roof of a missing building carries no marks');

  const neutral = resolveBuildingAppearance({ id: 'n', x: 0, y: 0, w: 48, h: 48, appearance: null }, null, opts);
  for (const id of ['far', 'own', 'orphan']) {
    assert.notEqual(byId.get(id).resolved.roofFill, neutral.roofFill, `${id} resolves an authored roofFill`);
  }
  // A building's appearance outranks the roof's own.
  const plain = { ...map, roofs: [{ ...map.roofs[1], appearance: null }] };
  assert.equal(resolveDeclaredRoofs(plain, opts)[0].resolved.roofFill, byId.get('covering').resolved.roofFill);
  const unstyled = { buildings: [{ ...building, appearance: null }], roofs: [map.roofs[1]] };
  assert.equal(resolveDeclaredRoofs(unstyled, opts)[0].resolved.roofFill, neutral.roofFill, 'no appearance anywhere stays neutral');
  assert.deepEqual(resolveDeclaredRoofs({ buildings: [] }, opts), []);
});

test('remaining region catalogue strategies adopt architectural appearance kits with zero simulation RNG draws (#770)', () => {
  const allowedBuildingKeys = new Set([
    'floorMaterial',
    'wallMaterial',
    'roofPaint',
    'roofRim',
    'interiorTrim',
    'roofSign',
    'neglect',
  ]);
  for (const preset of [
    ...PARK_PAVILION_PRESETS,
    ...CHECKPOINT_POST_PRESETS,
    ...RUINS_BUILDING_PRESETS,
    ...OPEN_PARCEL_PRESETS,
    ...HALL_BUILDING_PRESETS,
    ...ARRIVAL_PLAZA_PRESETS,
    ...DEPARTURE_EXIT_PRESETS,
    ...CHARGING_RIG_PRESETS,
    ...TRANSIT_STATION_PRESETS,
  ]) {
    for (const k of Object.keys(preset)) {
      assert.ok(allowedBuildingKeys.has(k), `preset field ${k} is allowed`);
    }
  }

  // 1. Park strategy: hedge blocks/runs, trees, and park pockets
  const parkBrief = chainBrief({ type: 'park', cells: cellsOf(24, 24), seed: 42 });
  const parkRegion = buildPark(parkBrief);
  assert.ok(parkRegion.elements.length > 0, 'park produces elements');
  const parkStyledObs = parkRegion.elements.flatMap(e => e.template.parts).filter(p => p.part === 'obstacle' && p.appearance);
  assert.ok(parkStyledObs.length > 0, 'park hedges and trees carry obstacle appearance');
  const treeObs = parkStyledObs.find(p => p.shape.kind === 'circle');
  assert.ok(treeObs, 'park tree obstacle carries appearance');
  assert.deepEqual(treeObs.appearance, PARK_TREE_APPEARANCE, 'park tree obstacle matches PARK_TREE_APPEARANCE');
  const unstyledTree = { id: 'tree-unstyled', kind: 'tree', x: 0, y: 0, r: 22 };
  const styledTree = { id: 'tree-styled', kind: 'tree', x: 0, y: 0, r: 22, appearance: PARK_TREE_APPEARANCE };
  const resUnstyled = resolveObstacleAppearance(unstyledTree, null, { palette: 'signature' });
  const resStyled = resolveObstacleAppearance(styledTree, null, { palette: 'signature' });
  assert.notEqual(resStyled.fill, resUnstyled.fill, 'styled tree resolves distinct authored fill from unstyled tree');
  assert.ok(resStyled.trunkTop > 0, 'styled tree resolves non-zero trunkTop highlight');

  // 2. Checkpoint strategy: tiered guard post and perimeter chicane barriers
  const cpBrief = chainBrief({
    type: 'checkpoint',
    cells: cellsOf(24, 18),
    seed: 1,
    portals: [
      { id: 'west', axis: 'v', x: 0, y: 7, length: 3 },
      { id: 'east', axis: 'v', x: 24, y: 12, length: 3 },
    ],
  });
  const cpRegion = buildCheckpoint(cpBrief);
  const cpPost = cpRegion.elements.find(e => e.label === 'checkpoint-post-1');
  assert.ok(cpPost?.template.appearance?.building, 'checkpoint guard post carries tiered building appearance');
  const cpBarriers = cpRegion.elements.filter(e => e.label.startsWith('checkpoint-barrier'));
  assert.ok(cpBarriers.length > 0, 'checkpoint emits chicane barriers');
  for (const b of cpBarriers) {
    const obsPart = b.template.parts.find(p => p.part === 'obstacle');
    assert.deepEqual(obsPart?.appearance, CHECKPOINT_BARRIER_APPEARANCE, 'checkpoint barrier carries appearance');
  }

  // 3. Ruins & Rubble strategies: fractured masonry, fallen slabs, debris
  const ruinsBrief = chainBrief({ type: 'ruins', cells: cellsOf(24, 24), seed: 42 });
  const ruinsRegion = buildRuins(ruinsBrief);
  const ruinsStyledObs = ruinsRegion.elements.flatMap(e => e.template.parts).filter(p => p.part === 'obstacle' && p.appearance);
  assert.ok(ruinsStyledObs.length > 0, 'ruins walls and slabs carry obstacle appearance');

  const rubbleBrief = chainBrief({ type: 'rubble', cells: cellsOf(24, 24), seed: 42 });
  const rubbleRegion = buildRubble(rubbleBrief);
  const rubbleStyledObs = rubbleRegion.elements.flatMap(e => e.template.parts).filter(p => p.part === 'obstacle' && p.appearance);
  assert.ok(rubbleStyledObs.length > 0, 'rubble debris and hint walls carry obstacle appearance');

  // 4. Cover, Open, and Hall strategies
  const coverBrief = chainBrief({ type: 'cover', cells: cellsOf(20, 20), seed: 42 });
  const coverRegion = buildCover(coverBrief);
  const coverStyledObs = coverRegion.elements.flatMap(e => e.template.parts).filter(p => p.part === 'obstacle' && p.appearance);
  assert.ok(coverStyledObs.length === coverRegion.elements.length, 'every cover piece carries obstacle appearance');

  const openBrief = chainBrief({ type: 'open', cells: cellsOf(16, 16), seed: 42 });
  const openRegion = buildOpen(openBrief);
  assert.deepEqual(openRegion.elements, [], 'buildOpen preserves empty elements contract');
  const openApp = createOpenParcelAppearance({ seed: openBrief.seed, w: 640, h: 640 });
  assert.ok(openApp.floorMaterial, 'createOpenParcelAppearance returns tiered BuildingAppearance');

  const hallBrief = chainBrief({ type: 'hall', cells: cellsOf(24, 24), seed: 42 });
  const hallRegion = buildHall(hallBrief);
  const hallBay = hallRegion.elements.find(e => e.template.appearance?.building);
  assert.ok(hallBay, 'hall bay carries tiered building appearance');
  const hallPillars = hallBay.template.parts.filter(pt => pt.part === 'obstacle');
  assert.ok(hallPillars.length > 0, 'hall bay emits pillar obstacles');
  for (const obsPart of hallPillars) {
    assert.deepEqual(obsPart.appearance, HALL_PILLAR_APPEARANCE, 'hall pillar carries appearance');
  }

  // 5. Arena core facilities: arrival, departure, charging, transit
  const arrivalBrief = chainBrief({ type: 'arrival', cells: cellsOf(20, 20), seed: 42, coreElements: { spawn: 2 } });
  const arrivalRegion = buildArrival(arrivalBrief);
  assert.ok(arrivalRegion.elements[0].template.appearance?.surfaces?.some(s => s.id?.includes('arrival-apron')), 'arrival emits civic apron surface');
  assert.ok(arrivalRegion.elements[0].template.appearance?.lighting?.fields?.length > 0, 'arrival emits concourse lighting');

  const departureBrief = chainBrief({ type: 'departure', cells: cellsOf(24, 24), seed: 42, coreElements: { exit: 1, 'hunter-spawn': 1 } });
  const departureRegion = buildDeparture(departureBrief);
  assert.ok(departureRegion.elements[0].template.appearance?.surfaces?.some(s => s.id?.includes('departure-threshold')), 'departure emits civic exit threshold surface');
  assert.ok(departureRegion.elements[0].template.appearance?.scars?.some(s => s.id?.includes('hunter-launch-scorch')), 'departure emits imposed hunter launch scorch');

  const chargingBrief = chainBrief({ type: 'charging', cells: cellsOf(20, 20), seed: 42, coreElements: { charger: 1 } });
  const chargingRegion = buildCharging(chargingBrief);
  assert.ok(chargingRegion.elements[0].template.appearance?.surfaces?.some(s => s.id?.includes('charging-rig-pad')), 'charging emits competition rig pad');
  assert.ok(chargingRegion.elements[0].template.appearance?.scars?.some(s => s.id?.includes('charging-rig-scorch')), 'charging emits arc scorch scars');

  const transitBrief = chainBrief({ type: 'transit', cells: cellsOf(20, 20), seed: 42, coreElements: { warp: 1 } });
  const transitRegion = buildTransit(transitBrief);
  assert.ok(transitRegion.elements[0].template.appearance?.surfaces?.some(s => s.id?.includes('transit-platform')), 'transit emits station platform surface');
  assert.ok(transitRegion.elements[0].template.appearance?.lighting?.fields?.length > 0, 'transit emits warp lighting');

  // 6. Stamp all regions into a context and verify 0 simulation RNG draws and clean resolution
  const ctx = createGenerationContext(97531);
  let rngDraws = 0;
  const origRandom = ctx.random;
  ctx.random = () => {
    rngDraws++;
    return origRandom();
  };
  for (const reg of [parkRegion, cpRegion, ruinsRegion, rubbleRegion, coverRegion, hallRegion, arrivalRegion, departureRegion, chargingRegion, transitRegion]) {
    for (const elem of reg.elements) {
      placeElement(ctx, elem.template, elem.x, elem.y, { nodeId: 'catalogue-node' });
    }
  }
  assert.equal(rngDraws, 0, 'stamping all remaining region catalogue kits performs zero simulation RNG draws');
  const groundOps = resolveGroundAppearance(ctx.map.appearance, { palette: 'signature', lighting: true, wear: true });
  assert.ok(groundOps.length > 0, 'stamped catalogue regions resolve ground appearance operations');
  for (const o of ctx.map.obstacles.filter(obs => obs.appearance)) {
    const shapeBefore = shapeOf(o);
    const res = resolveObstacleAppearance(o, ctx.map.appearance, { palette: 'signature', lighting: true, wear: true });
    assert.ok(res.fill > 0, `obstacle ${o.id} (${o.kind}) resolves non-zero fill`);
    assert.deepEqual(shapeOf(o), shapeBefore, 'obstacle collision shape is untouched');
  }
});
