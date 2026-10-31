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
} from '../public/appearance.js';
import { SWATCHES, U, L, T, G } from '../public/palette.js';
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
  const obsNorthFull = resolveObstacleAppearance(wallNorth, mapAppearance, { building, palette: 'signature', lighting: true, wear: true });
  const obsNorthNoLight = resolveObstacleAppearance(wallNorth, mapAppearance, { building, palette: 'signature', lighting: false, wear: true });
  const obsNorthNoWear = resolveObstacleAppearance(wallNorth, mapAppearance, { building, palette: 'signature', lighting: true, wear: false });
  const obsSouthFull = resolveObstacleAppearance(wallSouth, mapAppearance, { building, palette: 'signature', lighting: true, wear: true });

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

test('appearance resolver stays presentation-only: no simulation, server or map code imports it', () => {
  for (const dir of ['shared', 'server', 'map']) for (const file of readdirSync(dir, { recursive: true })) {
    if (!/\.(m?[jt]s)$/.test(file) || file.includes('node_modules')) continue;
    assert.ok(!/appearance\.js/.test(readFileSync(path.join(dir, file), 'utf8')), `${dir}/${file} imports appearance.js`);
  }
});
