// Palettes for the arena renderer (11.1, 29.4). Presentation only: nothing here reaches the
// simulation, the wire, a recording or a saved map, so switching a palette changes pixels and nothing else.

/** Color Palette v1.0, 11.1's swatches as Corey supplied them; a test holds this equal to the document. */
export const SWATCHES = Object.freeze({
  version: '1.0-working',
  urban: { nightAsphalt: '#49535A', coolConcrete: '#7C8088', slateShadow: '#5B6169', weatheredBrick: '#7A5A54', dirtySidewalk: '#9A9389', structuralVoid: '#29333D', dustyStucco: '#B0A497', oxidizedMetal: '#99664C', urbanVegetation: '#68735C' },
  legacy: { storefrontTeal: '#4F8C92', oldSignRed: '#B5544F', awningsYellow: '#C69A49', dirtyCream: '#CFC5AF', weatheredCoral: '#C9775F', fadedViolet: '#766B87', motelTurquoise: '#69AAA3', oldAdvertBlue: '#5579A8', fadedMint: '#91A98C' },
  theatrical: { cobaltBlue: '#305EC4', showtimeMagenta: '#B642B6', hotOrange: '#E87C42', electricTurquoise: '#19BDD3', crimsonRose: '#D8445C', ultraviolet: '#7760C8', deepStageBlue: '#243B82', hotPink: '#EB4B9A', toxicLime: '#A4DF47' },
  gameplay: { signalCyan: '#36D6E7', hazardRed: '#E04545', sodiumAmber: '#F0B43A', prizeGold: '#FFE06B', extractionMint: '#55F0B1', broadcastPink: '#D94BC6' },
});

export const { urban: U, legacy: L, theatrical: T, gameplay: G } = Object.fromEntries(Object.entries(SWATCHES).filter(([, v]) => typeof v === 'object')
  .map(([group, colors]) => [group, Object.fromEntries(Object.entries(colors).map(([key, hex]) => [key, parseInt(hex.slice(1), 16)]))]));

const channels = c => [c >> 16 & 255, c >> 8 & 255, c & 255];
/** `a` moved a share `t` of the way to `b`, per channel, rounded. */
export function mix(a, b, t) {
  const [ar, ag, ab] = channels(a), [br, bg, bb] = channels(b);
  return Math.round(ar + (br - ar) * t) << 16 | Math.round(ag + (bg - ag) * t) << 8 | Math.round(ab + (bb - ab) * t);
}
/** WCAG relative luminance of an sRGB color. */
export function luminance(c) {
  const [r, g, b] = channels(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio, 1 to 21, whichever color is lighter. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A theme maps the renderer's roles to colors. The roles are what the art is of (ground, street, wall,
// roof), never which swatch fills them, so a palette is swapped without touching a draw call.
// Objectives, items, actors, traps and hazards keep their own colors: their meanings are #587's.

/** The colors the arena was drawn in before 11.1; the default until a night palette is chosen to replace it. */
const PROTOTYPE = {
  background: 0x162a29, ground: 0x39454c, groundEdge: 0x729b9e, street: 0x596269, streetLine: 0xa5bbc0,
  marking: 0x9daab0, garden: 0x44584e, zoneLabel: 0x91b9bc, interior: 0x50505d, tuft: 0x568f60, floor: 0x77717a,
  shadow: 0x264439, outline: 0x344d48, wall: 0x92929e, wallInset: 0x798d8c, wallLine: 0x586b6b,
  fence: 0x53636b, fenceLine: 0x354c44, crates: [0x8d5669, 0x526f80, 0x8c815a], crateLine: 0x354e44,
  hedge: 0x3f7a47, hedgeEdge: 0x79a95d, ruin: 0x77828a, ruinShadow: 0x303740, ruinEdge: 0xa2a9af,
  pipe: 0x7d6a52, pipeEdge: 0xc2a57c, glass: 0x77dbe3, glassEdge: 0xc1f4f6,
  circleShadow: 0x294d39, rock: 0x5c6e68, rockMid: 0x899b91, rockTop: 0xb0bdb0, trunk: 0x4b392c, trunkTop: 0x766047,
  canopy: [0x244b39, 0x3f7747, 0x78a962],
  roofEave: 0x323a4b, roof: 0x4b586b, roofRim: 0x8091a8, roofRidge: 0x748298, roofVent: 0x273240,
  shade: 0x123330,
};

/**
 * A night theme from a dozen choices; the rest derive from them. Each keeps the prototype's value
 * order (dark ground, lighter streets, light walls on dark outlines), which already reads at play zoom.
 */
function night({ background = U.structuralVoid, ground, street, streetLine, floor, wall, outline = U.structuralVoid, fence = U.oxidizedMetal,
  crates, vegetation = U.urbanVegetation, metal = U.oxidizedMetal, glass = L.motelTurquoise, roof, roofRim, shadeTint }) {
  const white = 0xffffff;
  return {
    background, ground, groundEdge: roofRim, street, streetLine,
    marking: streetLine, garden: mix(vegetation, ground, 0.35), zoneLabel: mix(streetLine, white, 0.3), interior: mix(floor, background, 0.35),
    tuft: mix(vegetation, white, 0.12), floor,
    shadow: background, outline, wall, wallInset: mix(wall, outline, 0.22), wallLine: mix(wall, outline, 0.55),
    fence, fenceLine: mix(fence, outline, 0.6), crates, crateLine: outline,
    hedge: vegetation, hedgeEdge: mix(vegetation, white, 0.3), ruin: mix(wall, ground, 0.15), ruinShadow: background, ruinEdge: mix(wall, white, 0.25),
    pipe: metal, pipeEdge: mix(metal, white, 0.35), glass, glassEdge: mix(glass, white, 0.5),
    circleShadow: background, rock: mix(U.dustyStucco, ground, 0.35), rockMid: U.dustyStucco, rockTop: mix(U.dustyStucco, white, 0.3),
    trunk: mix(U.weatheredBrick, background, 0.4), trunkTop: U.weatheredBrick,
    canopy: [mix(vegetation, background, 0.5), vegetation, mix(vegetation, U.dustyStucco, 0.35)],
    roofEave: mix(roof, background, 0.45), roof, roofRim, roofRidge: mix(roof, roofRim, 0.3), roofVent: background,
    // Out-of-sight dimming is a dark wash tinted by the scene's light; a saturated wash at full value
    // flattened obstacles into the ground beneath it, which the palette test now refuses.
    shade: mix(shadeTint, 0x0e1620, 0.6),
  };
}

/**
 * Selectable palettes, in menu order. `signature` is Corey's favored combination (11.1 §5.3); the four
 * scene identities after it are his suggestions, each with roles assigned from its six swatches here.
 */
export const THEMES = Object.freeze({
  prototype: { label: 'Prototype', colors: PROTOTYPE },
  signature: {
    label: 'Signature night',
    // Cool slate asphalt, weathered coral and brick, cobalt illumination, hot amber highlights.
    colors: night({ ground: mix(U.nightAsphalt, U.structuralVoid, 0.45), street: mix(U.coolConcrete, T.cobaltBlue, 0.2), streetLine: G.sodiumAmber,
      floor: U.weatheredBrick, wall: L.weatheredCoral, crates: [L.oldSignRed, L.storefrontTeal, L.awningsYellow],
      roof: mix(U.slateShadow, T.cobaltBlue, 0.3), roofRim: T.hotOrange, shadeTint: T.deepStageBlue }),
  },
  neonAftermath: {
    label: 'Neon Aftermath',
    colors: night({ ground: mix(U.nightAsphalt, U.structuralVoid, 0.45), street: mix(U.coolConcrete, T.cobaltBlue, 0.3), streetLine: G.broadcastPink,
      floor: mix(U.nightAsphalt, L.storefrontTeal, 0.35), wall: U.coolConcrete, crates: [L.storefrontTeal, mix(G.broadcastPink, U.nightAsphalt, 0.2), T.hotOrange],
      roof: mix(U.nightAsphalt, T.cobaltBlue, 0.4), roofRim: T.hotOrange, shadeTint: mix(T.cobaltBlue, U.structuralVoid, 0.5) }),
  },
  sodiumGraveyard: {
    label: 'Sodium Graveyard',
    colors: night({ ground: mix(U.structuralVoid, U.weatheredBrick, 0.2), street: mix(U.weatheredBrick, U.structuralVoid, 0.2), streetLine: G.sodiumAmber,
      floor: U.weatheredBrick, wall: mix(U.oxidizedMetal, L.awningsYellow, 0.6), fence: U.oxidizedMetal, crates: [L.awningsYellow, mix(T.electricTurquoise, U.structuralVoid, 0.3), U.oxidizedMetal],
      roof: mix(U.structuralVoid, U.oxidizedMetal, 0.4), roofRim: T.electricTurquoise, shadeTint: U.structuralVoid }),
  },
  deadMall: {
    label: 'Dead Mall District',
    colors: night({ ground: mix(U.slateShadow, U.structuralVoid, 0.6), street: mix(U.slateShadow, L.fadedViolet, 0.4), streetLine: T.hotPink,
      floor: mix(L.weatheredCoral, U.slateShadow, 0.45), wall: L.dirtyCream, crates: [L.weatheredCoral, L.motelTurquoise, mix(L.fadedViolet, L.dirtyCream, 0.3)], vegetation: L.fadedMint,
      roof: mix(U.slateShadow, L.fadedViolet, 0.5), roofRim: L.motelTurquoise, shadeTint: mix(L.fadedViolet, U.structuralVoid, 0.55) }),
  },
  broadcastLockdown: {
    label: 'Broadcast Lockdown',
    colors: night({ ground: mix(U.structuralVoid, T.deepStageBlue, 0.15), street: mix(U.coolConcrete, T.deepStageBlue, 0.8), streetLine: G.prizeGold,
      floor: mix(U.coolConcrete, T.deepStageBlue, 0.25), wall: U.coolConcrete, crates: [T.crimsonRose, mix(T.deepStageBlue, U.coolConcrete, 0.6), mix(G.prizeGold, U.structuralVoid, 0.3)],
      roof: mix(U.structuralVoid, T.deepStageBlue, 0.6), roofRim: G.signalCyan, shadeTint: T.deepStageBlue }),
  },
});

export const DEFAULT_THEME = 'prototype';
/** A theme's colors by id, or the default's for an id that names none. */
export const themeColors = id => (Object.hasOwn(THEMES, id) ? THEMES[id] : THEMES[DEFAULT_THEME]).colors;
/** `#rrggbb` for CSS and Phaser's string APIs. */
export const css = c => `#${c.toString(16).padStart(6, '0')}`;
