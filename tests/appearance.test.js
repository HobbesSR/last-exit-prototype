import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  APPEARANCE_RECIPE_VERSION,
  MATERIAL_SWATCH,
  TINT_SWATCH,
  resolveSwatch,
  appearanceHash,
  appearanceUnit,
  sampleSpatialLight,
  resolveBuildingAppearance,
  resolveObstacleAppearance,
  resolveGroundAppearance,
  getCanonicalFields,
  resolvePropAppearance,
  applyLightSample,
} from '../public/appearance.js';
import { SWATCHES, THEMES, contrast, U, L, T, G } from '../public/palette.js';
import { shapeOf } from '../shared/shape.ts';

test('resolveSwatch resolves all authored palette swatches and uses fallback only for unknown names', () => {
  // All urban swatches resolve
  for (const [key, hex] of Object.entries(SWATCHES.urban)) {
    const expected = parseInt(hex.slice(1), 16);
    assert.equal(resolveSwatch(key, -1), expected, `urban swatch '${key}' resolves`);
  }
  // All legacy swatches resolve
  for (const [key, hex] of Object.entries(SWATCHES.legacy)) {
    const expected = parseInt(hex.slice(1), 16);
    assert.equal(resolveSwatch(key, -1), expected, `legacy swatch '${key}' resolves`);
  }
  // All theatrical swatches resolve
  for (const [key, hex] of Object.entries(SWATCHES.theatrical)) {
    const expected = parseInt(hex.slice(1), 16);
    assert.equal(resolveSwatch(key, -1), expected, `theatrical swatch '${key}' resolves`);
  }
  // All gameplay swatches resolve
  for (const [key, hex] of Object.entries(SWATCHES.gameplay)) {
    const expected = parseInt(hex.slice(1), 16);
    assert.equal(resolveSwatch(key, -1), expected, `gameplay swatch '${key}' resolves`);
  }
  // Aliased material swatches resolve
  assert.equal(resolveSwatch('warmMasonry', -1), MATERIAL_SWATCH.warmMasonry);
  assert.equal(resolveSwatch('slatePaving', -1), MATERIAL_SWATCH.slatePaving);
  // Numeric hex values pass through
  assert.equal(resolveSwatch(0x123456, -1), 0x123456);
  // Unknown names return the specified fallback
  assert.equal(resolveSwatch('unknownNeonGradient', 0x999999), 0x999999);
});

test('appearanceHash is deterministic, versioned, and independent of ambient state', () => {
  const h1 = appearanceHash('shop-room', 'wear');
  const h2 = appearanceHash('shop-room', 'wear');
  const hDiffChannel = appearanceHash('shop-room', 'scars');
  const hDiffVersion = appearanceHash('shop-room', 'wear', APPEARANCE_RECIPE_VERSION + 1);
  assert.equal(h1, h2);
  assert.notEqual(h1, hDiffChannel);
  assert.notEqual(h1, hDiffVersion);

  const u = appearanceUnit('shop-room', 'wear');
  assert.ok(u >= 0 && u < 1, `unit hash in [0, 1): ${u}`);
});

test('sampleSpatialLight blends normalized influences with a neutral remainder and is order-independent', () => {
  const fieldA = { id: 'cobalt-intersection', bounds: { x: 700, y: 360, w: 420, h: 200 }, tint: 'cobaltBlue', intensity: 0.48, falloff: 80 };
  const fieldB = { id: 'amber-focal-edge', bounds: { x: 800, y: 520, w: 260, h: 90 }, tint: 'sodiumAmber', intensity: 0.44, falloff: 60 };

  const forward = sampleSpatialLight([fieldA, fieldB], 880, 540, { lighting: true });
  const reverse = sampleSpatialLight([fieldB, fieldA], 880, 540, { lighting: true });
  assert.deepEqual(forward, reverse, 'spatial light resolution does not depend on field array order');
  assert.ok(forward.weight > 0 && forward.weight <= 0.65, `normalized weight capped at 0.65 (${forward.weight})`);
  assert.equal(Number((forward.weight + forward.neutral).toFixed(4)), 1, 'normalized weight + neutral remainder equals 1');

  const disabled = sampleSpatialLight([fieldA, fieldB], 880, 540, { lighting: false });
  assert.equal(disabled.weight, 0);
  assert.equal(disabled.neutral, 1);
  assert.deepEqual(disabled.contributions, []);
});

test('resolveBuildingAppearance and resolveObstacleAppearance compose in fixed order and preserve collision shapes', () => {
  const buildingAppearance = {
    floorMaterial: 'warmMasonry',
    wallMaterial: 'warmMasonry',
    roofPaint: 'storefrontTeal',
    roofRim: 'weatheredCoral',
    interiorTrim: 'storefrontTeal',
    roofSign: { color: 'weatheredCoral', backing: 'structuralVoid', stripe: 'dirtyCream', dx: 28, dy: 16, w: 120, h: 24 },
    neglect: {
      fadedPanel: { dx: 30, dy: 52, w: 88, h: 42 },
      roofDrainStain: { dx: 168, dy: 42, w: 44, h: 28 },
      floorStain: { dx: 150, dy: 70, w: 46, h: 28 },
    },
  };
  const building = { id: 'shop-room', x: 810, y: 580, w: 240, h: 170, appearance: buildingAppearance };
  const wallNorth = { id: 'shop-wall-n-east', kind: 'building', buildingId: 'shop-room', x: 950, y: 574, w: 100, h: 16, appearance: { focalRim: { side: 'N', color: 'sodiumAmber' } } };
  const wallSouth = { id: 'shop-wall-s', kind: 'building', buildingId: 'shop-room', x: 810, y: 736, w: 240, h: 16 };
  const shapeBefore = structuredClone(shapeOf(wallNorth));

  const mapAppearance = {
    lighting: {
      fields: [
        { id: 'cobalt-intersection', bounds: { x: 720, y: 360, w: 440, h: 195 }, tint: 'cobaltBlue', intensity: 0.42, falloff: 70 },
        { id: 'amber-focal-edge', bounds: { x: 800, y: 540, w: 260, h: 75 }, tint: 'sodiumAmber', intensity: 0.45, falloff: 55 },
      ],
    },
  };

  // Neutral fallback when appearance metadata is omitted:
  const neutral = resolveBuildingAppearance({ id: 'shop-room', x: 810, y: 580, w: 240, h: 170 }, null, { palette: 'signature', lighting: true, wear: true });
  const styledFull = resolveBuildingAppearance(building, mapAppearance, { palette: 'signature', lighting: true, wear: true });
  const styledNoLight = resolveBuildingAppearance(building, mapAppearance, { palette: 'signature', lighting: false, wear: true });
  const styledNoWear = resolveBuildingAppearance(building, mapAppearance, { palette: 'signature', lighting: true, wear: false });

  assert.notEqual(styledFull.roofFill, neutral.roofFill, 'authored legacy-teal roof differs from default theme roof');
  assert.notEqual(styledFull.roofFill, styledNoLight.roofFill, 'switching off lighting changes lit roof fill while retaining material identity');
  assert.notEqual(styledNoLight.roofFill, neutral.roofFill, 'with lighting off, legacy-teal roof retains its material identity');
  assert.ok(styledFull.roofMarks.some(m => m.layer === 'wear-faded-panel'), 'wear=true includes faded roof panel');
  assert.ok(styledFull.roofMarks.some(m => m.layer === 'wear-drain-pool'), 'wear=true includes roof drain stain');
  assert.ok(!styledNoWear.roofMarks.some(m => m.layer.startsWith('wear-')), 'wear=false omits neglect marks while keeping commercial roof sign');
  assert.ok(styledNoWear.roofMarks.some(m => m.layer === 'commercial-sign'), 'wear=false keeps commercial roof sign');

  // North wall has focalRim authored per obstacle; south wall does not:
  const buildingsById = new Map([[building.id, building]]);
  const obsNorthFull = resolveObstacleAppearance(wallNorth, mapAppearance, { buildingsById, palette: 'signature', lighting: true, wear: true });
  const obsNorthNoLight = resolveObstacleAppearance(wallNorth, mapAppearance, { buildingsById, palette: 'signature', lighting: false, wear: true });
  const obsNorthNoWear = resolveObstacleAppearance(wallNorth, mapAppearance, { buildingsById, palette: 'signature', lighting: true, wear: false });
  const obsSouthFull = resolveObstacleAppearance(wallSouth, mapAppearance, { buildingsById, palette: 'signature', lighting: true, wear: true });

  assert.ok(obsNorthFull.focalRim, 'exposed north wall receives amber focal rim');
  assert.equal(obsNorthFull.focalRim.side, 'N', 'focal rim side matches authored descriptor');
  assert.equal(obsNorthNoLight.focalRim, null, 'switching off lighting removes theatrical focal rim');
  assert.equal(obsSouthFull.focalRim, null, 'interior south wall never receives north focal rim');
  assert.notEqual(obsNorthFull.fill, obsNorthNoWear.fill, 'switching off wear removes weathering shift from wall fill');
  assert.deepEqual(shapeOf(wallNorth), shapeBefore, 'appearance resolution never mutates obstacle collision shape');
});

test('resolveGroundAppearance emits layers in fixed order and gates wear/scars and lighting independently', () => {
  const mapAppearance = {
    surfaces: [
      { id: 'service-lane-apron', bounds: { x: 780, y: 515, w: 390, h: 62 }, material: 'slatePaving', weathered: true, curb: true },
    ],
    commercial: [
      { id: 'ochre-parking-stripes', kind: 'parking-stripes', bounds: { x: 800, y: 465, w: 180, h: 42 }, color: 'awningsYellow', count: 3 },
      { id: 'coral-awning', kind: 'awning', bounds: { x: 822, y: 536, w: 146, h: 18 }, color: 'weatheredCoral', stripeColor: 'dirtyCream' },
      { id: 'faded-panel', kind: 'sign-panel', bounds: { x: 982, y: 536, w: 58, h: 18 }, color: 'storefrontTeal' },
    ],
    wear: [
      { id: 'lane-drain-stain', kind: 'drain-stain', bounds: { x: 1015, y: 504, w: 46, h: 28 } },
    ],
    scars: [
      { id: 'service-scorch', kind: 'scorch-group', bounds: { x: 885, y: 502, w: 68, h: 30 } },
    ],
    lighting: {
      fields: [
        {
          id: 'cobalt-intersection',
          bounds: { x: 740, y: 365, w: 430, h: 185 },
          tint: 'cobaltBlue',
          intensity: 0.42,
          falloff: 60,
          focalEdge: {
            color: 'sodiumAmber',
            x: 805,
            y: 546,
            w: 248,
            h: 14,
            alpha: 0.34,
            rimLine: { x1: 810, y1: 554, x2: 1050, y2: 554, width: 3, alpha: 0.82 },
          },
        },
      ],
    },
  };

  const allOn = resolveGroundAppearance(mapAppearance, { palette: 'signature', lighting: true, wear: true });
  const layersAllOn = allOn.map(item => item.layer);
  assert.deepEqual(layersAllOn, ['paving', 'commercial', 'commercial', 'commercial', 'wear', 'scars', 'lighting']);

  const wearOff = resolveGroundAppearance(mapAppearance, { palette: 'signature', lighting: true, wear: false });
  assert.ok(!wearOff.some(item => item.layer === 'wear' || item.layer === 'scars'), 'wear=false omits neglect stains and scorch scars');
  assert.ok(wearOff.some(item => item.layer === 'paving') && wearOff.some(item => item.layer === 'commercial'), 'wear=false retains paving and commercial markings');

  const lightingOff = resolveGroundAppearance(mapAppearance, { palette: 'signature', lighting: false, wear: true });
  assert.ok(!lightingOff.some(item => item.layer === 'lighting'), 'lighting=false omits theatrical washes and focal edge');
  assert.ok(lightingOff.some(item => item.layer === 'wear') && lightingOff.some(item => item.layer === 'scars'), 'lighting=false retains wear and scars');
});

test('resolvePropAppearance provides bounded virtual lighting on physics props and getCanonicalFields memoizes', () => {
  const cobaltLight = {
    tint: resolveSwatch('cobaltBlue', 0x1b3b6f),
    weight: 0.42,
    neutral: 0.58,
    contributions: [{ id: 'cobalt-intersection', tint: 0x1b3b6f, weight: 0.42 }],
  };

  const basePropFill = 0x8fa9a0;
  const basePropStroke = 0xdce8d7;
  const propLit = resolvePropAppearance(basePropFill, basePropStroke, cobaltLight, { lighting: true });
  const propNoLight = resolvePropAppearance(basePropFill, basePropStroke, cobaltLight, { lighting: false });

  assert.notEqual(propLit.fill, basePropFill, 'prop fill in lit field blends with regional spatial light');
  assert.notEqual(propLit.stroke, basePropStroke, 'prop stroke in lit field blends with regional spatial light');
  assert.equal(propNoLight.fill, basePropFill, 'lighting:false returns base prop fill');
  assert.equal(propNoLight.stroke, basePropStroke, 'lighting:false returns base prop stroke');

  // getCanonicalFields memoization:
  const rawFields = [
    { id: 'field-b', bounds: { x: 0, y: 0, w: 10, h: 10 } },
    { id: 'field-a', bounds: { x: 0, y: 0, w: 10, h: 10 } },
  ];
  const c1 = getCanonicalFields(rawFields);
  const c2 = getCanonicalFields(rawFields);
  assert.equal(c1[0].id, 'field-a');
  assert.equal(c1[1].id, 'field-b');
  assert.equal(c1, c2, 'getCanonicalFields returns cached sorted array for identical array reference');
});

test('palette x field contrast sweep for dynamic object virtual lighting maintains >= 1.50 floor (#737, Step 5)', () => {
  const fields = [
    { id: 'cobalt-intersection', tint: 'cobaltBlue', intensity: 0.42 },
    { id: 'magenta-transit-wash', tint: 'showtimeMagenta', intensity: 0.40 },
    { id: 'amber-focal-edge', tint: 'sodiumAmber', intensity: 0.45 },
  ];

  const basePropFill = 0x8fa9a0;
  const basePropStroke = 0xdce8d7;
  const substrates = [
    { key: 'slatePaving', colorOf: () => MATERIAL_SWATCH.slatePaving },
    { key: 'ground', colorOf: theme => theme.colors.ground },
    { key: 'street', colorOf: theme => theme.colors.street },
  ];

  for (const [themeId, theme] of Object.entries(THEMES)) {
    // 1. Unlit mode across substrates
    for (const sub of substrates) {
      const substrateColor = sub.colorOf(theme);
      const unlitRatio = Number(contrast(basePropFill, substrateColor).toFixed(2));
      assert.ok(
        unlitRatio >= 1.50,
        `[${themeId}] unlit prop maintains contrast floor against ${sub.key} (${unlitRatio} >= 1.50)`
      );
    }

    // 2. Lit mode across regional lighting fields and substrates
    for (const field of fields) {
      const sample = {
        tint: resolveSwatch(field.tint),
        weight: field.intensity,
        neutral: 1 - field.intensity,
        contributions: [{ id: field.id, tint: resolveSwatch(field.tint), weight: field.intensity }],
      };
      const propLit = resolvePropAppearance(basePropFill, basePropStroke, sample, { lighting: true });

      for (const sub of substrates) {
        const baseSub = sub.colorOf(theme);
        const subLit = applyLightSample(baseSub, sample, 0.38);
        const litRatio = Number(contrast(propLit.fill, subLit).toFixed(2));
        assert.ok(
          litRatio >= 1.50,
          `[${themeId}] lit prop in ${field.id} maintains contrast floor against ${sub.key} (${litRatio} >= 1.50)`
        );
      }
    }
  }
});

test('spatial composition across two neighboring areas: normalized blending, boundary transition, and long surface splitting (41.2 step 4)', () => {
  const field1 = {
    id: 'cobalt-intersection',
    bounds: { x: 850, y: 365, w: 320, h: 185 },
    tint: 'cobaltBlue',
    intensity: 0.42,
    falloff: 70,
  };
  const field2 = {
    id: 'magenta-transit-wash',
    bounds: { x: 1170, y: 365, w: 330, h: 185 },
    tint: 'showtimeMagenta',
    intensity: 0.40,
    falloff: 70,
  };
  const fields = [field1, field2];

  // 1. Solidly in Field 1 (x: 960, y: 420)
  const sample1 = sampleSpatialLight(fields, 960, 420, { lighting: true });
  assert.equal(sample1.contributions.length, 1);
  assert.equal(sample1.contributions[0].id, 'cobalt-intersection');

  // 2. Solidly in Field 2 (x: 1350, y: 420)
  const sample2 = sampleSpatialLight(fields, 1350, 420, { lighting: true });
  assert.equal(sample2.contributions.length, 1);
  assert.equal(sample2.contributions[0].id, 'magenta-transit-wash');

  // 3. Right at boundary (x: 1170, y: 420)
  const sampleBoundary = sampleSpatialLight(fields, 1170, 420, { lighting: true });
  assert.equal(sampleBoundary.contributions.length, 2, 'boundary sample blends both neighboring fields');
  assert.ok(sampleBoundary.weight > 0 && sampleBoundary.weight <= 0.65, 'boundary weight stays capped');
  assert.equal(Number((sampleBoundary.weight + sampleBoundary.neutral).toFixed(4)), 1, 'neutral remainder maintained');

  // Tie-handling & order independence:
  const sampleBoundaryReversed = sampleSpatialLight([field2, field1], 1170, 420, { lighting: true });
  assert.deepEqual(sampleBoundary, sampleBoundaryReversed, 'field evaluation is order-independent and tie-stable');

  // 4. Long surface crossing fields is split into segments and spatially sampled
  const mapAppearance = {
    surfaces: [
      { id: 'crossing-apron', bounds: { x: 1050, y: 440, w: 300, h: 50 }, material: 'coolConcrete', weathered: true, curb: true, segmentSpan: 100 },
      { id: 'short-pad', bounds: { x: 900, y: 440, w: 100, h: 50 }, material: 'coolConcrete' },
    ],
    lighting: { fields },
  };

  const groundItems = resolveGroundAppearance(mapAppearance, { palette: 'signature', lighting: true, wear: true });
  const crossingItem = groundItems.find(i => i.id === 'crossing-apron');
  assert.ok(crossingItem, 'crossing-apron item found');
  const fillOps = crossingItem.ops.filter(op => op.op === 'fillRect');
  assert.equal(fillOps.length, 3, 'long surface with w:300 and segmentSpan:100 splits into 3 fillRect segments');
  assert.notEqual(fillOps[0].color, fillOps[2].color, 'segment 1 (Field 1 side) differs in color from segment 3 (Field 2 side)');
  assert.notEqual(fillOps[0].color, fillOps[1].color, 'segment 1 differs from transition segment 2');

  const shortItem = groundItems.find(i => i.id === 'short-pad');
  const shortFills = shortItem.ops.filter(op => op.op === 'fillRect');
  assert.equal(shortFills.length, 1, 'surface within span threshold emits exactly 1 fillRect');

  // Conditional splitting: surfaces only split when lighting:true and field influence overlaps
  const unlitGround = resolveGroundAppearance(mapAppearance, { palette: 'signature', lighting: false, wear: true });
  const unlitCrossing = unlitGround.find(i => i.id === 'crossing-apron');
  const unlitFills = unlitCrossing.ops.filter(op => op.op === 'fillRect');
  assert.equal(unlitFills.length, 1, 'when lighting is false, long surface emits exactly 1 fillRect without splitting');

  const remoteAppearance = {
    surfaces: [
      { id: 'remote-apron', bounds: { x: 3000, y: 3000, w: 400, h: 50 }, material: 'coolConcrete' },
    ],
    lighting: { fields },
  };
  const remoteGround = resolveGroundAppearance(remoteAppearance, { palette: 'signature', lighting: true, wear: true });
  const remoteFills = remoteGround.find(i => i.id === 'remote-apron').ops.filter(op => op.op === 'fillRect');
  assert.equal(remoteFills.length, 1, 'surface outside all lighting fields emits exactly 1 fillRect without splitting');
});

test('appearance resolver stays presentation-only: no simulation, server or map code imports it', () => {
  for (const dir of ['shared', 'server', 'map']) for (const file of readdirSync(dir, { recursive: true })) {
    if (!/\.(m?[jt]s)$/.test(file) || file.includes('node_modules')) continue;
    assert.ok(!/appearance\.js/.test(readFileSync(path.join(dir, file), 'utf8')), `${dir}/${file} imports appearance.js`);
  }
});

test('reusable cosmetic destruction and material vocabulary (#585): impact craters, cracks, patches, and vegetation', () => {
  const mapAppearance = {
    wear: [
      { id: 'asphalt-patch', kind: 'patch-repair', bounds: { x: 100, y: 100, w: 40, h: 30 } },
      { id: 'pavement-crack', kind: 'pavement-crack', bounds: { x: 150, y: 100, w: 30, h: 20 } },
      { id: 'edge-veg', kind: 'vegetation-patch', bounds: { x: 200, y: 100, w: 30, h: 15 } },
    ],
    scars: [
      { id: 'kinetic-crater', kind: 'impact-crater', bounds: { x: 250, y: 100, w: 36, h: 28 } },
    ],
  };

  const building = {
    id: 'b-damaged',
    x: 0,
    y: 0,
    w: 200,
    h: 150,
    appearance: {
      roofPaint: 'storefrontTeal',
      neglect: {
        impactCrater: { dx: 60, dy: 50, w: 34, h: 26 },
        vegetationEdge: { dx: 30, dy: 140, w: 40, h: 12, along: 'S' },
      },
    },
  };

  const groundFull = resolveGroundAppearance(mapAppearance, { wear: true });
  assert.equal(groundFull.length, 4);
  assert.equal(groundFull[0].id, 'asphalt-patch');
  assert.equal(groundFull[1].id, 'pavement-crack');
  assert.equal(groundFull[2].id, 'edge-veg');
  assert.equal(groundFull[3].id, 'kinetic-crater');
  assert.equal(groundFull[3].layer, 'scars');

  // Verify wear: false omits all ground wear & scars:
  const groundNoWear = resolveGroundAppearance(mapAppearance, { wear: false });
  assert.equal(groundNoWear.length, 0);

  // Building marks:
  const bFull = resolveBuildingAppearance(building, null, { wear: true });
  assert.ok(bFull.roofMarks.some(m => m.layer === 'wear-crater-halo'), 'roof includes crater halo');
  assert.ok(bFull.roofMarks.some(m => m.layer === 'wear-crater-core'), 'roof includes crater core');
  assert.ok(bFull.roofMarks.some(m => m.layer === 'wear-crater-streak'), 'roof includes crater fracture streaks');
  assert.ok(bFull.roofMarks.some(m => m.layer === 'wear-vegetation'), 'roof includes vegetation edge');
  assert.ok(bFull.floorMarks.some(m => m.layer === 'neglect-stain'), 'floor includes interior crater stain');

  const bNoWear = resolveBuildingAppearance(building, null, { wear: false });
  assert.ok(!bNoWear.roofMarks.some(m => m.layer.startsWith('wear-')), 'wear: false strips all crater and vegetation marks');
  assert.equal(bNoWear.floorMarks.length, 0);
});
