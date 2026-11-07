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
  actorBaseTint,
  DEFAULT_KIT_COLORS,
  UNKNOWN_KIT_COLOR,
  CONTESTANT_IDENTITY_COLORS,
  resolveActorTint,
  resolvePropAppearance,
  applyLightSample,
} from '../public/appearance.js';
import { SWATCHES, THEMES, contrast, mix, U, L, T, G } from '../public/palette.js';
import { shapeOf } from '../shared/shape.ts';
import { defaultContent } from '../shared/simulation/content.ts';

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

test('resolveActorTint provides bounded virtual lighting on actor body material while preserving base tint when unlit (#736)', () => {
  const cobaltLight = {
    tint: resolveSwatch('cobaltBlue', 0x1b3b6f),
    weight: 0.42,
    neutral: 0.58,
    contributions: [{ id: 'cobalt-intersection', tint: 0x1b3b6f, weight: 0.42 }],
  };
  const unlitSample = { tint: 0x000000, weight: 0, neutral: 1, contributions: [] };

  const baseBody = 0xffffff;
  const bodyLit = resolveActorTint(baseBody, cobaltLight, { lighting: true });
  const bodyNoLight = resolveActorTint(baseBody, cobaltLight, { lighting: false });
  const bodyUnlit = resolveActorTint(baseBody, unlitSample, { lighting: true });

  assert.notEqual(bodyLit, baseBody, 'actor body in lit field blends with regional spatial light');
  assert.equal(bodyNoLight, baseBody, 'lighting:false returns base body tint');
  assert.equal(bodyUnlit, baseBody, 'zero light weight returns base body tint');

  // Bounded channel shift assertion (#736 review 605): shift <= ceil(weight * actorScale * |tint - base|) + 1
  const actorScale = 0.25;
  const rLit = (bodyLit >> 16) & 0xff, gLit = (bodyLit >> 8) & 0xff, bLit = bodyLit & 0xff;
  const rBase = (baseBody >> 16) & 0xff, gBase = (baseBody >> 8) & 0xff, bBase = baseBody & 0xff;
  const rCobalt = (cobaltLight.tint >> 16) & 0xff, gCobalt = (cobaltLight.tint >> 8) & 0xff, bCobalt = cobaltLight.tint & 0xff;
  const maxShiftR = Math.ceil(cobaltLight.weight * actorScale * Math.abs(rCobalt - rBase)) + 1;
  const maxShiftG = Math.ceil(cobaltLight.weight * actorScale * Math.abs(gCobalt - gBase)) + 1;
  const maxShiftB = Math.ceil(cobaltLight.weight * actorScale * Math.abs(bCobalt - bBase)) + 1;
  assert.ok(Math.abs(rLit - rBase) <= maxShiftR, 'red channel shift is mathematically bounded by actorScale * weight');
  assert.ok(Math.abs(gLit - gBase) <= maxShiftG, 'green channel shift is mathematically bounded by actorScale * weight');
  assert.ok(Math.abs(bLit - bBase) <= maxShiftB, 'blue channel shift is mathematically bounded by actorScale * weight');

  // Proportional scaling: actorScale = 0.50 strictly increases channel shift over actorScale = 0.25 across all channels
  const scaled = resolveActorTint(baseBody, cobaltLight, { lighting: true, actorScale: 0.5 });
  const rScaled = (scaled >> 16) & 0xff, gScaled = (scaled >> 8) & 0xff, bScaled = scaled & 0xff;
  assert.ok(Math.abs(rScaled - rBase) > Math.abs(rLit - rBase), 'actorScale proportionally scales red shift');
  assert.ok(Math.abs(gScaled - gBase) > Math.abs(gLit - gBase), 'actorScale proportionally scales green shift');
  assert.ok(Math.abs(bScaled - bBase) > Math.abs(bLit - bBase), 'actorScale proportionally scales blue shift');
});

test('DEFAULT_KIT_COLORS fallback table matches simulation MatchContent definitions (#736, #610)', () => {
  const content = defaultContent();
  for (const [kitId, kit] of Object.entries(content.kits)) {
    if (typeof kit.color === 'number') {
      assert.equal(
        DEFAULT_KIT_COLORS[kitId],
        kit.color,
        `DEFAULT_KIT_COLORS.${kitId} matches authoritative MatchContent kit color`
      );
    }
  }
});

test('actorBaseTint defines saturated kit and contestant identity colors meeting Tier 1 contrast and pairwise distinctness (#736)', () => {
  const wardenTint = actorBaseTint({ role: 'gladiator', kit: 'warden' }, 'me');
  const specterTint = actorBaseTint({ role: 'gladiator', kit: 'specter' }, 'me');
  const strikerTint = actorBaseTint({ role: 'gladiator', kit: 'striker' }, 'me');
  const hookTint = actorBaseTint({ role: 'gladiator', kit: 'hook' }, 'me');
  const fallbackTint = actorBaseTint({ role: 'gladiator', kit: 'unknown' }, 'me');

  assert.equal(wardenTint, 0xff6b70, 'warden gladiator has saturated coral red identity (#ff6b70)');
  assert.equal(specterTint, 0xb39aff, 'specter gladiator matches content kit color (#b39aff)');
  assert.equal(strikerTint, 0xffba62, 'striker gladiator matches content kit color (#ffba62)');
  assert.equal(hookTint, 0x77dddd, 'hook gladiator matches content kit color (#77dddd)');
  assert.equal(fallbackTint, UNKNOWN_KIT_COLOR, 'unknown gladiator falls back to neutral color rather than coral red');

  // Passing presentation kits array overrides default table:
  const mockKits = [{ id: 'custom', name: 'Custom', skill: 'dash', color: 0x123456 }];
  assert.equal(actorBaseTint({ role: 'gladiator', kit: 'custom' }, 'me', mockKits), 0x123456);

  const selfTint = actorBaseTint({ role: 'contestant', id: 'me', name: 'Player' }, 'me');
  assert.equal(selfTint, 0xffffff, 'self contestant has signature white identity (#ffffff)');

  // Content-1 roster seats c0..c7 distribute across variant hues with 0 non-self contestants receiving white (#610)
  const content = defaultContent();
  const rosterTints = content.roster.contestants.map((name, i) =>
    actorBaseTint({ role: 'contestant', id: `c${i}`, name }, 'me')
  );
  assert.ok(!rosterTints.includes(0xffffff), 'zero non-self contestants collapse to self white');
  const distinctHues = new Set(rosterTints);
  assert.equal(distinctHues.size, 3, 'all 3 variant hues are represented across the roster');
  for (let i = 0; i < rosterTints.length - 1; i++) {
    assert.notEqual(rosterTints[i], rosterTints[i + 1], `adjacent roster seats c${i} and c${i + 1} have distinct hues`);
  }

  // Arbitrary callsigns hash deterministically into variant hues, never self white
  for (const name of ['Runner', 'Striker', 'Shadow', 'Ace']) {
    const tint = actorBaseTint({ role: 'contestant', id: `user-${name}`, name }, 'me');
    assert.notEqual(tint, 0xffffff, 'non-self arbitrary callsign never receives self white');
    assert.ok(CONTESTANT_IDENTITY_COLORS.slice(1).includes(tint), 'non-self arbitrary callsign receives a variant hue');
  }

  // The transported roster place outranks the id heuristics and a callsign hash (#792), so a human
  // takeover keeps the hue the seat had, however the id or name changes.
  const variants = CONTESTANT_IDENTITY_COLORS.length - 1;
  for (let seat = 0; seat < 8; seat++) {
    const tint = actorBaseTint({ role: 'contestant', id: `human-${seat}`, name: 'Runner', seat }, 'me');
    assert.equal(tint, CONTESTANT_IDENTITY_COLORS[1 + (seat % variants)], `seat ${seat} picks its variant hue`);
  }
  assert.equal(actorBaseTint({ role: 'contestant', id: 'c1', name: 'Runner', seat: 4 }, 'me'),
    actorBaseTint({ role: 'contestant', id: 'human', name: 'Runner', seat: 4 }, 'me'),
    'a roster-bot-shaped id does not override the seat');
  assert.equal(actorBaseTint({ role: 'contestant', id: 'me', name: 'Me', seat: 3 }, 'me'), 0xffffff,
    'the viewer stays self white with a seat');
  assert.equal(actorBaseTint({ role: 'contestant', id: 'x', name: 'X', seat: -1 }, 'me'),
    actorBaseTint({ role: 'contestant', id: 'x', name: 'X' }, 'me'),
    'a negative place falls through to the id and callsign fallbacks');

  // Tier 1 contrast requirement: all identity hues maintain WCAG contrast >= 1.80 against street and ground across all themes
  const gladiatorKits = [wardenTint, specterTint, strikerTint, hookTint];
  const allHues = [...gladiatorKits, UNKNOWN_KIT_COLOR, ...CONTESTANT_IDENTITY_COLORS];
  for (const [themeId, theme] of Object.entries(THEMES)) {
    for (const hue of allHues) {
      const streetContrast = contrast(hue, theme.street);
      const groundContrast = contrast(hue, theme.ground);
      assert.ok(streetContrast >= 1.80, `[${themeId}] hue 0x${hue.toString(16)} meets Tier 1 street contrast (${streetContrast.toFixed(2)} >= 1.80)`);
      assert.ok(groundContrast >= 1.80, `[${themeId}] hue 0x${hue.toString(16)} meets Tier 1 ground contrast (${groundContrast.toFixed(2)} >= 1.80)`);
    }
  }

  // Pairwise distinctness check between gladiator kits (Euclidean RGB distance >= 80):
  const rgbDist = (c1, c2) => {
    const r1 = (c1 >> 16) & 0xff, g1 = (c1 >> 8) & 0xff, b1 = c1 & 0xff;
    const r2 = (c2 >> 16) & 0xff, g2 = (c2 >> 8) & 0xff, b2 = c2 & 0xff;
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  };
  for (let i = 0; i < gladiatorKits.length; i++) {
    for (let j = i + 1; j < gladiatorKits.length; j++) {
      const d = rgbDist(gladiatorKits[i], gladiatorKits[j]);
      assert.ok(d >= 80, `gladiator kit ${i} vs ${j} distance ${d.toFixed(1)} >= 80`);
    }
  }

  // Cross-role distinctness check: contestant hues must be distinct from ALL gladiator kits (distance >= 90)
  for (const cHue of CONTESTANT_IDENTITY_COLORS) {
    for (const gHue of gladiatorKits) {
      const d = rgbDist(cHue, gHue);
      assert.ok(d >= 90, `contestant 0x${cHue.toString(16)} vs gladiator 0x${gHue.toString(16)} distance ${d.toFixed(1)} >= 90`);
    }
  }

  // Distinctness among non-self contestant hues (distance >= 100)
  assert.ok(rgbDist(CONTESTANT_IDENTITY_COLORS[1], CONTESTANT_IDENTITY_COLORS[2]) >= 100);
  assert.ok(rgbDist(CONTESTANT_IDENTITY_COLORS[1], CONTESTANT_IDENTITY_COLORS[3]) >= 100);
  assert.ok(rgbDist(CONTESTANT_IDENTITY_COLORS[2], CONTESTANT_IDENTITY_COLORS[3]) >= 100);
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

// Helper to derive the rendered substrate directly from resolveGroundAppearance ops:
// - Authored material surfaces (slatePaving) take the 0.38 light scaling from step 1.
// - All substrates under lighting fields receive the translucent theatrical wash fillRect from step 5.
function renderSubstrate(sub, theme, field) {
  const baseColor = sub.colorOf(theme);
  const items = resolveGroundAppearance({
    surfaces: sub.isMaterial ? [{ id: 'mat', bounds: field.bounds, material: sub.key }] : [],
    lighting: { fields: [field] },
  }, { lighting: true });

  const pavingOp = items.find(i => i.layer === 'paving')?.ops.find(op => op.op === 'fillRect');
  const surfaceColor = pavingOp ? pavingOp.color : baseColor;

  const washOp = items.find(i => i.layer === 'lighting')?.ops.find(op => op.op === 'fillRect');
  return washOp ? mix(surfaceColor, washOp.color, washOp.alpha) : surfaceColor;
}

test('palette x field contrast sweep for dynamic object virtual lighting (#737, Step 5)', () => {
  // Evaluates all three lighting fields authored in the witness slice (cobalt, magenta, amber).
  // Uses canonical sampleSpatialLight with fields centered on the evaluation point.
  const fields = [
    { id: 'cobalt-intersection', bounds: { x: 0, y: 0, w: 100, h: 100 }, tint: 'cobaltBlue', intensity: 0.42, falloff: 0 },
    { id: 'magenta-transit-wash', bounds: { x: 0, y: 0, w: 100, h: 100 }, tint: 'showtimeMagenta', intensity: 0.40, falloff: 0 },
    { id: 'amber-focal-edge', bounds: { x: 0, y: 0, w: 100, h: 100 }, tint: 'sodiumAmber', intensity: 0.45, falloff: 0 },
  ];

  const basePropFill = 0x8fa9a0;
  const basePropStroke = 0xdce8d7;

  const substrates = [
    { key: 'slatePaving', isMaterial: true, colorOf: () => MATERIAL_SWATCH.slatePaving },
    { key: 'ground', isMaterial: false, colorOf: theme => theme.colors.ground },
    { key: 'street', isMaterial: false, colorOf: theme => theme.colors.street },
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

    // 2. Lit mode across regional lighting fields and substrates (Tier 2 readability: 29.4)
    for (const field of fields) {
      const sample = sampleSpatialLight([field], 50, 50, { lighting: true });
      const propLit = resolvePropAppearance(basePropFill, basePropStroke, sample, { lighting: true });

      for (const sub of substrates) {
        const renderedSub = renderSubstrate(sub, theme, field);
        const fillRatio = Number(contrast(propLit.fill, renderedSub).toFixed(3));
        const strokeRatio = Number(contrast(propLit.stroke, renderedSub).toFixed(3));
        const passesTier2 = fillRatio >= 1.50 || (fillRatio >= 1.35 && strokeRatio >= 2.00);
        assert.ok(
          passesTier2,
          `[${themeId}] lit prop in ${field.id} satisfies Tier 2 physical separation against ${sub.key} (fill ${fillRatio}, stroke ${strokeRatio})`
        );
      }
    }
  }
});

test('palette x field contrast sweep: signature amber over street satisfies Tier 2 composite separation (41.2 Step 5)', () => {
  const field = { id: 'amber-focal-edge', bounds: { x: 0, y: 0, w: 100, h: 100 }, tint: 'sodiumAmber', intensity: 0.45, falloff: 0 };
  const sample = sampleSpatialLight([field], 50, 50, { lighting: true });
  const propLit = resolvePropAppearance(0x8fa9a0, 0xdce8d7, sample, { lighting: true });
  const renderedSub = renderSubstrate({ key: 'street', isMaterial: false, colorOf: t => t.colors.street }, THEMES.signature, field);
  const fillRatio = Number(contrast(propLit.fill, renderedSub).toFixed(3));
  const strokeRatio = Number(contrast(propLit.stroke, renderedSub).toFixed(3));

  // Tier 2 composite rule (29.4): fill >= 1.35 accompanied by high-contrast stroke >= 2.00
  assert.equal(fillRatio, 1.475, 'signature amber over street records documented 1.475 fill contrast');
  assert.ok(fillRatio >= 1.35, `fill ratio maintains Tier 2 floor (${fillRatio} >= 1.35)`);
  assert.ok(strokeRatio >= 2.00, `stroke ratio maintains high-contrast edge separation (${strokeRatio} >= 2.00)`);
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

test('hedge and ruin-wall obstacles satisfy Tier 2 contrast separation across all authored palettes (#770)', () => {
  for (const [themeId, theme] of Object.entries(THEMES)) {
    const c = theme.colors;
    const substrates = [
      { name: 'ground', hex: c.ground },
      { name: 'street', hex: c.street },
      { name: 'floor', hex: c.floor },
    ];

    // 1. Unstyled and styled hedge obstacle:
    for (const appearance of [undefined, { material: 'fadedMint' }]) {
      const hedgeObs = { id: 'h-test', kind: 'hedge', x: 100, y: 100, w: 52, h: 28, appearance };
      const res = resolveObstacleAppearance(hedgeObs, null, { palette: themeId, lighting: false, wear: true });
      for (const sub of substrates) {
        const fillRatio = Number(contrast(res.fill, sub.hex).toFixed(2));
        const edgeRatio = Number(contrast(res.hedgeEdge, sub.hex).toFixed(2));
        const bestRatio = Math.max(fillRatio, edgeRatio);
        // Prototype theme defines its own historical baseline (~1.08 on floor); all 5 night palettes satisfy Tier 2 (>= 1.50 fill or composite).
        if (themeId !== 'prototype') {
          assert.ok(
            fillRatio >= 1.50 || (fillRatio >= 1.35 && edgeRatio >= 2.00),
            `${themeId} hedge (${appearance ? 'styled' : 'unstyled'}) on ${sub.name}: fill=${fillRatio}, edge=${edgeRatio} must satisfy Tier 2 separation`
          );
        } else {
          assert.ok(bestRatio >= 1.08, `prototype hedge on ${sub.name} preserves baseline separation`);
        }
      }
    }

    // 2. Unstyled and styled ruin-wall obstacle:
    for (const appearance of [undefined, { material: 'warmSandstone' }, { material: 'coolConcrete' }]) {
      const ruinObs = { id: 'r-test', kind: 'ruin-wall', x: 200, y: 100, w: 52, h: 24, appearance };
      const res = resolveObstacleAppearance(ruinObs, null, { palette: themeId, lighting: false, wear: true });
      for (const sub of substrates) {
        const fillRatio = Number(contrast(res.fill, sub.hex).toFixed(2));
        const edgeRatio = Number(contrast(res.ruinEdge, sub.hex).toFixed(2));
        if (themeId !== 'prototype') {
          assert.ok(
            fillRatio >= 1.50 || (fillRatio >= 1.35 && edgeRatio >= 2.00),
            `${themeId} ruin-wall (${appearance?.material ?? 'unstyled'}) on ${sub.name}: fill=${fillRatio}, edge=${edgeRatio} must satisfy Tier 2 separation`
          );
        } else {
          assert.ok(Math.max(fillRatio, edgeRatio) >= 1.20, `prototype ruin-wall on ${sub.name} preserves baseline separation`);
        }
      }
    }
  }
});
