// Client presentation resolver for static material, wear/scars, and spatial lighting (29.4, 41.2).
// Presentation only: resolves existing geometry records, optional appearance descriptors, and the
// viewer's art mode into material fills, structural edges, and a bounded list of decorative marks.
// Never allocates game IDs, consumes simulation RNG, modifies `shapeOf`, or reads dynamic state.

import { SWATCHES, themeColors, mix, U, L, T, G } from './palette.js';

export const APPEARANCE_RECIPE_VERSION = 1;

export const MATERIAL_SWATCH = Object.freeze({
  // Urban foundations
  asphalt: U.nightAsphalt,
  nightAsphalt: U.nightAsphalt,
  slatePaving: mix(U.nightAsphalt, U.slateShadow, 0.45),
  slateShadow: U.slateShadow,
  concrete: U.coolConcrete,
  coolConcrete: U.coolConcrete,
  sidewalk: U.dirtySidewalk,
  dirtySidewalk: U.dirtySidewalk,
  warmMasonry: mix(U.weatheredBrick, L.weatheredCoral, 0.35),
  brick: U.weatheredBrick,
  weatheredBrick: U.weatheredBrick,
  stucco: U.dustyStucco,
  dustyStucco: U.dustyStucco,
  metal: U.oxidizedMetal,
  oxidizedMetal: U.oxidizedMetal,
  vegetation: U.urbanVegetation,
  urbanVegetation: U.urbanVegetation,
  structuralVoid: U.structuralVoid,

  // Legacy commercial colors
  storefrontTeal: L.storefrontTeal,
  weatheredCoral: L.weatheredCoral,
  awningsYellow: L.awningsYellow,
  oldSignRed: L.oldSignRed,
  dirtyCream: L.dirtyCream,
  fadedViolet: L.fadedViolet,
  motelTurquoise: L.motelTurquoise,
  oldAdvertBlue: L.oldAdvertBlue,
  fadedMint: L.fadedMint,
});

export const TINT_SWATCH = Object.freeze({
  cobaltBlue: T.cobaltBlue,
  deepStageBlue: T.deepStageBlue,
  hotOrange: T.hotOrange,
  sodiumAmber: G.sodiumAmber,
  showtimeMagenta: T.showtimeMagenta,
  electricTurquoise: T.electricTurquoise,
  crimsonRose: T.crimsonRose,
  ultraviolet: T.ultraviolet,
  hotPink: T.hotPink,
  toxicLime: T.toxicLime,
  signalCyan: G.signalCyan,
  hazardRed: G.hazardRed,
  sodiumAmber: G.sodiumAmber,
  prizeGold: G.prizeGold,
  extractionMint: G.extractionMint,
  broadcastPink: G.broadcastPink,
});

/** Resolve a named swatch or raw 24-bit integer color, falling back to `fallback`. */
export function resolveSwatch(nameOrHex, fallback) {
  if (typeof nameOrHex === 'number' && Number.isInteger(nameOrHex) && nameOrHex >= 0 && nameOrHex <= 0xffffff) {
    return nameOrHex;
  }
  if (typeof nameOrHex === 'string') {
    if (Object.hasOwn(MATERIAL_SWATCH, nameOrHex)) return MATERIAL_SWATCH[nameOrHex];
    if (Object.hasOwn(TINT_SWATCH, nameOrHex)) return TINT_SWATCH[nameOrHex];
  }
  return fallback;
}

/**
 * Deterministic versioned presentation-only hash (FNV-1a 32-bit over recipe version + stable id + channel).
 * Returns an unsigned 32-bit integer; never depends on camera position, frame time, or traversal order.
 */
export function appearanceHash(id, channel = 'default', version = APPEARANCE_RECIPE_VERSION) {
  const input = `v${version}:${String(id ?? '')}:${String(channel)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic unit float in [0, 1) from a presentation hash. */
export function appearanceUnit(id, channel = 'default', version = APPEARANCE_RECIPE_VERSION) {
  return (appearanceHash(id, channel, version) >>> 8) / 0x01000000;
}

/**
 * Normalize art mode options (`lighting` and `wear` default to `true`; `palette` defaults to `'prototype'`).
 */
export function resolveArtOptions(options = {}) {
  const palette = typeof options.palette === 'string' ? options.palette : 'prototype';
  const lighting = options.lighting !== false;
  const wear = options.wear !== false;
  return {
    version: APPEARANCE_RECIPE_VERSION,
    palette,
    lighting,
    wear,
    ink: themeColors(palette),
  };
}

function pointToBoxDistance(x, y, box) {
  const dx = x < box.x ? box.x - x : x > box.x + box.w ? x - (box.x + box.w) : 0;
  const dy = y < box.y ? box.y - y : y > box.y + box.h ? y - (box.y + box.h) : 0;
  return Math.hypot(dx, dy);
}

/**
 * Deterministic spatial lighting resolver (29.4 "Spatial coherence precedes random variety").
 * Evaluates authored fields at `(x, y)` in canonical `id` order, blending normalized influences
 * with a neutral remainder so overlapping fields never exceed unit weight or depend on array order.
 */
export function sampleSpatialLight(fields, x, y, options = {}) {
  if (options.lighting === false || !Array.isArray(fields) || !fields.length) {
    return { tint: 0x000000, weight: 0, neutral: 1, contributions: [] };
  }
  const ordered = [...fields]
    .filter(f => f && f.bounds && typeof f.id === 'string')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const active = [];
  let rawSum = 0;
  for (const f of ordered) {
    const b = f.bounds;
    const falloff = typeof f.falloff === 'number' && f.falloff > 0 ? f.falloff : 0;
    const dist = pointToBoxDistance(x, y, b);
    if (dist > falloff) continue;
    const falloffFactor = falloff > 0 ? 1 - dist / falloff : 1;
    const maxIntensity = Math.max(0, Math.min(0.85, Number(f.intensity ?? 0.35)));
    const w = maxIntensity * falloffFactor;
    if (w <= 1e-4) continue;
    const tint = resolveSwatch(f.tint, T.cobaltBlue);
    active.push({ id: f.id, tint, weight: w });
    rawSum += w;
  }
  if (!active.length) {
    return { tint: 0x000000, weight: 0, neutral: 1, contributions: [] };
  }
  // Normalized influence with a neutral remainder: total theatrical weight is capped at 0.65 so base
  // material value separation always survives.
  const cap = 0.65;
  const scale = rawSum > cap ? cap / rawSum : 1;
  let r = 0, g = 0, b = 0, totalWeight = 0;
  const contributions = [];
  for (const item of active) {
    const w = item.weight * scale;
    r += ((item.tint >> 16) & 255) * w;
    g += ((item.tint >> 8) & 255) * w;
    b += (item.tint & 255) * w;
    totalWeight += w;
    contributions.push({ id: item.id, tint: item.tint, weight: Number(w.toFixed(4)) });
  }
  const blendedTint = (Math.round(r / totalWeight) << 16) | (Math.round(g / totalWeight) << 8) | Math.round(b / totalWeight);
  return {
    tint: blendedTint,
    weight: Number(totalWeight.toFixed(4)),
    neutral: Number((1 - totalWeight).toFixed(4)),
    contributions,
  };
}

/** Apply a sampled spatial light to a base material color (`compose in a fixed order`, 29.4). */
export function applyLightSample(baseColor, sample, roleScale = 1) {
  if (!sample || sample.weight <= 0 || roleScale <= 0) return baseColor;
  return mix(baseColor, sample.tint, Math.min(0.75, sample.weight * roleScale));
}

/**
 * Resolve a building's floor, roof, and ground/roof decorative marks from optional `map.appearance`
 * (or neutral theme fallback when omitted).
 * Composition order (29.4):
 *   1. Base material and surviving commercial paint (e.g., warm masonry floor, legacy-teal roof, weathered coral awning, ochre stripes).
 *   2. Long-term neglect / wear and competition scars (e.g., faded paint panel, drain stain, scorch group) — gated by `options.wear`.
 *   3. Static theatrical treatment (cobalt field + amber focal edge) — gated by `options.lighting`.
 *   4. Structural edge preservation after lighting treatment.
 */
export function resolveBuildingAppearance(building, mapAppearance, options = {}) {
  const art = resolveArtOptions(options);
  const ink = art.ink;
  const desc = building?.appearance || null;
  const fields = mapAppearance?.lighting?.fields || [];
  const cx = building.x + building.w / 2;
  const cy = building.y + building.h / 2;
  const centerLight = sampleSpatialLight(fields, cx, cy, art);

  // 1. Base material & surviving paint
  const baseFloor = desc?.floorMaterial ? resolveSwatch(desc.floorMaterial, ink.floor) : ink.floor;
  const baseRoof = desc?.roofPaint ? resolveSwatch(desc.roofPaint, ink.roof) : ink.roof;
  const baseRoofEave = desc?.roofPaint ? mix(baseRoof, ink.background, 0.42) : ink.roofEave;
  const baseRoofRim = desc?.roofRim ? resolveSwatch(desc.roofRim, ink.roofRim) : ink.roofRim;
  const baseRoofRidge = desc?.roofPaint ? mix(baseRoof, baseRoofRim, 0.32) : ink.roofRidge;

  // 2. Wear / neglect transform on base material
  const weatheredRoof = art.wear && desc?.neglect
    ? mix(baseRoof, U.slateShadow, 0.16)
    : baseRoof;
  const weatheredFloor = art.wear && desc?.neglect
    ? mix(baseFloor, U.slateShadow, 0.12)
    : baseFloor;

  // 3. Static theatrical treatment on interior/roof surfaces
  const floorFill = applyLightSample(weatheredFloor, centerLight, 0.35);
  const roofFill = applyLightSample(weatheredRoof, centerLight, 0.32);
  const roofEave = applyLightSample(baseRoofEave, centerLight, 0.28);
  // 4. Preserve structural edge after theatrical treatment
  const roofRim = applyLightSample(baseRoofRim, centerLight, 0.25);
  const roofRidge = applyLightSample(baseRoofRidge, centerLight, 0.25);

  // Decorative marks on the ground and roof planes, strictly bounded inside their owning surfaces
  const floorMarks = [];
  const roofMarks = [];

  if (desc?.interiorTrim) {
    const trimColor = applyLightSample(resolveSwatch(desc.interiorTrim, L.storefrontTeal), centerLight, 0.3);
    floorMarks.push({
      kind: 'rect',
      layer: 'commercial',
      x: building.x + 22,
      y: building.y + 22,
      w: building.w - 44,
      h: 14,
      color: trimColor,
      alpha: 0.72,
    });
  }

  if (art.wear && desc?.neglect?.floorStain) {
    const st = desc.neglect.floorStain;
    const stainX = Math.max(building.x + 24, Math.min(building.x + building.w - 24, st.dx !== undefined ? building.x + st.dx : (st.x ?? (building.x + building.w * 0.72))));
    const stainY = Math.max(building.y + 24, Math.min(building.y + building.h - 24, st.dy !== undefined ? building.y + st.dy : (st.y ?? (building.y + building.h * 0.36))));
    floorMarks.push({
      kind: 'ellipse',
      layer: 'neglect-stain',
      x: stainX,
      y: stainY,
      w: st.w ?? 46,
      h: st.h ?? 28,
      color: mix(U.structuralVoid, U.weatheredBrick, 0.25),
      alpha: 0.42,
    });
  }

  // Roof commercial graphic (large color-blocked sign backing / service block)
  if (desc?.roofSign) {
    const rs = desc.roofSign;
    const signColor = applyLightSample(resolveSwatch(rs.color, L.weatheredCoral), centerLight, 0.25);
    const backingColor = applyLightSample(resolveSwatch(rs.backing, U.structuralVoid), centerLight, 0.2);
    const sw = Math.min(rs.w ?? 120, Math.max(20, building.w - 32));
    const sh = Math.min(rs.h ?? 24, Math.max(12, building.h - 32));
    const sx = Math.max(building.x + 12, Math.min(building.x + building.w - sw - 12, building.x + (rs.dx ?? 26)));
    const sy = Math.max(building.y + 12, Math.min(building.y + building.h - sh - 12, building.y + (rs.dy ?? 18)));
    roofMarks.push(
      { kind: 'rect', layer: 'commercial-backing', x: sx - 3, y: sy - 3, w: sw + 6, h: sh + 6, color: backingColor, alpha: 0.9 },
      { kind: 'rect', layer: 'commercial-sign', x: sx, y: sy, w: sw, h: sh, color: signColor, alpha: 0.92 },
      { kind: 'rect', layer: 'commercial-stripe', x: sx + 8, y: sy + sh - 8, w: sw - 16, h: 4, color: resolveSwatch(rs.stripe, L.dirtyCream), alpha: 0.82 },
    );
  }

  // Roof wear: faded panel & roof drain stain (11.1 §5.6, 41.2)
  if (art.wear && desc?.neglect?.fadedPanel) {
    const fp = desc.neglect.fadedPanel;
    const pw = Math.min(fp.w ?? 88, Math.max(16, building.w - 32));
    const ph = Math.min(fp.h ?? 42, Math.max(12, building.h - 32));
    const px = Math.max(building.x + 12, Math.min(building.x + building.w - pw - 12, building.x + (fp.dx ?? 28)));
    const py = Math.max(building.y + 12, Math.min(building.y + building.h - ph - 12, building.y + (fp.dy ?? 56)));
    const fadedColor = applyLightSample(mix(baseRoof, U.coolConcrete, 0.48), centerLight, 0.25);
    const exposedUnderlay = applyLightSample(mix(U.slateShadow, U.oxidizedMetal, 0.38), centerLight, 0.2);
    roofMarks.push(
      { kind: 'rect', layer: 'wear-faded-panel', x: px, y: py, w: pw, h: ph, color: fadedColor, alpha: 0.85 },
      { kind: 'rect', layer: 'wear-exposed-seam', x: px + 8, y: py + 8, w: Math.max(16, pw * 0.42), h: Math.max(12, ph * 0.45), color: exposedUnderlay, alpha: 0.78 },
    );
  }

  if (art.wear && desc?.neglect?.roofDrainStain) {
    const ds = desc.neglect.roofDrainStain;
    const dw = Math.min(ds.w ?? 44, Math.max(16, building.w - 32));
    const dh = Math.min(ds.h ?? 28, Math.max(12, building.h - 32));
    const dx = Math.max(building.x + dw / 2 + 12, Math.min(building.x + building.w - dw / 2 - 12, building.x + (ds.dx ?? 155)));
    const dy = Math.max(building.y + dh / 2 + 12, Math.min(building.y + building.h - dh / 2 - 12, building.y + (ds.dy ?? 38)));
    roofMarks.push(
      { kind: 'ellipse', layer: 'wear-drain-pool', x: dx, y: dy, w: dw, h: dh, color: U.structuralVoid, alpha: 0.48 },
      { kind: 'rect', layer: 'wear-drain-streak', x: dx - 6, y: dy - 20, w: 12, h: 34, color: mix(U.structuralVoid, U.oxidizedMetal, 0.35), alpha: 0.44 },
    );
  }

  return {
    floorFill,
    roofFill,
    roofEave,
    roofRim,
    roofRidge,
    roofVent: ink.roofVent,
    floorMarks,
    roofMarks,
    lightSample: centerLight,
  };
}

/**
 * Resolve obstacle material fill, structural outline, highlight/rim, and bounded surface wear marks
 * in fixed order (base material -> wear -> static lighting -> structural edge).
 * Never alters `shapeOf(o)`.
 */
export function resolveObstacleAppearance(obstacle, mapAppearance, options = {}) {
  const art = resolveArtOptions(options);
  const ink = art.ink;
  const desc = obstacle?.appearance || null;
  const building = obstacle.buildingId ? (options.buildingsById?.get(obstacle.buildingId) || options.buildings?.find(b => b.id === obstacle.buildingId)) : null;
  const buildingDesc = building?.appearance || obstacle.buildingAppearance || null;
  const fields = mapAppearance?.lighting?.fields || [];

  const cx = obstacle.r ? obstacle.x : obstacle.x + (obstacle.w || 0) / 2;
  const cy = obstacle.r ? obstacle.y : obstacle.y + (obstacle.h || 0) / 2;
  const light = sampleSpatialLight(fields, cx, cy, art);

  let baseFill = obstacle.kind === 'fence' ? ink.fence
    : obstacle.kind === 'building' ? ink.wall
    : obstacle.kind === 'window' ? ink.glass
    : obstacle.kind === 'pipe' ? ink.pipe
    : obstacle.kind === 'hedge' ? ink.hedge
    : obstacle.kind === 'ruin-wall' ? ink.ruin
    : obstacle.kind === 'tree' ? ink.trunk
    : obstacle.kind === 'rock' ? ink.rock
    : ink.crates[obstacle.color || 0];

  if (desc?.material) {
    baseFill = resolveSwatch(desc.material, baseFill);
  } else if (obstacle.kind === 'building' && buildingDesc?.wallMaterial) {
    baseFill = resolveSwatch(buildingDesc.wallMaterial, baseFill);
  }

  if (art.wear && (desc?.weathered || buildingDesc?.neglect)) {
    baseFill = mix(baseFill, U.slateShadow, 0.14);
  }

  const fill = applyLightSample(baseFill, light, 0.32);
  const outline = ink.outline;
  const wallInset = mix(fill, outline, 0.22);
  const wallLine = mix(fill, outline, 0.55);

  // Directional focal rim:
  // "A colored rim belongs to an exposed, deliberately lit edge; the full structural perimeter must remain readable without it" (11.1 §5.5).
  // Authored strictly per obstacle via desc.focalRim so interior wall faces never inherit it.
  let focalRim = null;
  if (art.lighting && desc?.focalRim) {
    const rimSide = desc.focalRim.side || 'N';
    const rimColor = resolveSwatch(desc.focalRim.color, G.sodiumAmber);
    focalRim = { side: rimSide, color: rimColor, alpha: 0.84 };
  }

  return {
    fill,
    outline,
    wallInset,
    wallLine,
    focalRim,
    lightSample: light,
  };
}

/**
 * Resolve ground-plane authored slice features (paving aprons, ochre parking stripes, weathered coral
 * storefront awnings, faded commercial panels, drain stains, competition scorch groups, and static
 * theatrical wash fields).
 *
 * Returns an ordered list of bounded ground drawings with explicit bounding boxes so `recordStatic()`
 * records them into `staticAt(...)` in exact layer order:
 *   1. `paving` — ordinary slate/concrete paving pads and service-lane aprons
 *   2. `commercial` — ochre parking stripes, loading bay markings, weathered coral storefront awnings/signage
 *   3. `wear` — long-term neglect (faded panels, water/drain stains, pavement cracks) [when `art.wear` is true]
 *   4. `scars` — accumulated competition damage (plausible scorch group with soot halo + dark core + directional blast streaks) [when `art.wear` is true]
 *   5. `lighting` — static theatrical wash fields and warm focal edge highlights [when `art.lighting` is true]
 */
export function resolveGroundAppearance(mapAppearance, options = {}) {
  const art = resolveArtOptions(options);
  if (!mapAppearance) return [];
  const fields = mapAppearance.lighting?.fields || [];
  const items = [];

  // 1. Base paving surfaces (service lane, loading apron, sidewalk)
  for (const surf of mapAppearance.surfaces || []) {
    const b = surf.bounds;
    if (!b) continue;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const light = sampleSpatialLight(fields, cx, cy, art);
    const base = resolveSwatch(surf.material, art.ink.ground);
    const weathered = art.wear && surf.weathered ? mix(base, U.slateShadow, 0.14) : base;
    const fill = applyLightSample(weathered, light, 0.38);
    const seamColor = mix(fill, U.structuralVoid, 0.35);
    items.push({
      layer: 'paving',
      id: surf.id || 'surface',
      bounds: { x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 },
      ops: [
        { op: 'fillRect', x: b.x, y: b.y, w: b.w, h: b.h, color: fill, alpha: surf.alpha ?? 1 },
        ...(surf.curb ? [{ op: 'strokeRect', x: b.x, y: b.y, w: b.w, h: b.h, width: 2, color: seamColor, alpha: 0.65 }] : []),
      ],
    });
  }

  // 2. Commercial graphics & awnings (ochre parking stripes, weathered coral awnings, faded sign panel)
  for (const mark of mapAppearance.commercial || []) {
    const b = mark.bounds;
    if (!b) continue;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const light = sampleSpatialLight(fields, cx, cy, art);
    if (mark.kind === 'parking-stripes') {
      const baseColor = resolveSwatch(mark.color, L.awningsYellow);
      const stripeColor = applyLightSample(art.wear ? mix(baseColor, U.nightAsphalt, 0.18) : baseColor, light, 0.25);
      const count = mark.count ?? 4;
      const step = b.w / count;
      const ops = [];
      for (let i = 0; i <= count; i++) {
        const sx = Math.round(b.x + i * step);
        ops.push({ op: 'line', x1: sx, y1: b.y, x2: sx, y2: b.y + b.h, width: 3, color: stripeColor, alpha: 0.78 });
      }
      // Front wheel-stop bar across each bay
      for (let i = 0; i < count; i++) {
        const bx = Math.round(b.x + i * step + 8);
        const bw = Math.max(8, Math.round(step - 16));
        ops.push({ op: 'fillRect', x: bx, y: b.y + b.h - 7, w: bw, h: 4, color: stripeColor, alpha: 0.72 });
      }
      items.push({
        layer: 'commercial',
        id: mark.id || 'parking-stripes',
        bounds: { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 },
        ops,
      });
    } else if (mark.kind === 'awning') {
      const baseCoral = resolveSwatch(mark.color, L.weatheredCoral);
      const stripeAlt = resolveSwatch(mark.stripeColor, L.dirtyCream);
      const coralFill = applyLightSample(art.wear ? mix(baseCoral, U.weatheredBrick, 0.22) : baseCoral, light, 0.28);
      const creamFill = applyLightSample(art.wear ? mix(stripeAlt, U.dirtySidewalk, 0.25) : stripeAlt, light, 0.28);
      const trimColor = mix(coralFill, U.structuralVoid, 0.45);
      const ops = [
        { op: 'fillRect', x: b.x + 2, y: b.y + 3, w: b.w, h: b.h, color: U.structuralVoid, alpha: 0.32 },
        { op: 'fillRect', x: b.x, y: b.y, w: b.w, h: b.h, color: coralFill, alpha: 0.92 },
      ];
      const stripeStep = 14;
      for (let sx = b.x + 6; sx < b.x + b.w - 6; sx += stripeStep) {
        ops.push({ op: 'fillRect', x: sx, y: b.y + 2, w: 5, h: b.h - 4, color: creamFill, alpha: 0.78 });
      }
      if (art.wear && mark.weatheredPatch !== false) {
        ops.push({
          op: 'fillRect',
          x: b.x + Math.round(b.w * 0.58),
          y: b.y + 2,
          w: Math.max(10, Math.round(b.w * 0.22)),
          h: b.h - 4,
          color: applyLightSample(U.oxidizedMetal, light, 0.25),
          alpha: 0.85,
        });
      }
      ops.push({ op: 'strokeRect', x: b.x, y: b.y, w: b.w, h: b.h, width: 2, color: trimColor, alpha: 0.85 });
      items.push({
        layer: 'commercial',
        id: mark.id || 'awning',
        bounds: { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 },
        ops,
      });
    } else if (mark.kind === 'sign-panel') {
      const baseColor = resolveSwatch(mark.color, L.storefrontTeal);
      const fill = applyLightSample(baseColor, light, 0.28);
      const border = mix(fill, U.structuralVoid, 0.45);
      const ops = [
        { op: 'fillRect', x: b.x, y: b.y, w: b.w, h: b.h, color: fill, alpha: 0.86 },
        { op: 'strokeRect', x: b.x, y: b.y, w: b.w, h: b.h, width: 2, color: border, alpha: 0.8 },
      ];
      if (art.wear) {
        const fadedPatch = applyLightSample(mix(baseColor, U.coolConcrete, 0.52), light, 0.25);
        const rustEdge = applyLightSample(U.oxidizedMetal, light, 0.25);
        ops.push(
          { op: 'fillRect', x: b.x + 6, y: b.y + 4, w: Math.round(b.w * 0.48), h: b.h - 8, color: fadedPatch, alpha: 0.88 },
          { op: 'fillRect', x: b.x + Math.round(b.w * 0.52), y: b.y + 5, w: Math.round(b.w * 0.22), h: Math.max(4, b.h - 10), color: rustEdge, alpha: 0.78 },
        );
      }
      items.push({
        layer: 'commercial',
        id: mark.id || 'sign-panel',
        bounds: { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 },
        ops,
      });
    }
  }

  // 3. Long-term neglect / wear marks on ground (drain stain, faded panel)
  if (art.wear) {
    for (const w of mapAppearance.wear || []) {
      const b = w.bounds;
      if (!b) continue;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const light = sampleSpatialLight(fields, cx, cy, art);
      if (w.kind === 'drain-stain') {
        const stainOuter = applyLightSample(mix(U.structuralVoid, U.oxidizedMetal, 0.35), light, 0.2);
        const stainCore = U.structuralVoid;
        items.push({
          layer: 'wear',
          id: w.id || 'drain-stain',
          bounds: { x: b.x - 6, y: b.y - 6, w: b.w + 12, h: b.h + 12 },
          ops: [
            { op: 'fillEllipse', x: cx, y: cy, w: b.w, h: b.h, color: stainOuter, alpha: 0.44 },
            { op: 'fillEllipse', x: cx - 3, y: cy - 2, w: b.w * 0.58, h: b.h * 0.55, color: stainCore, alpha: 0.52 },
            { op: 'fillRect', x: cx - 5, y: b.y, w: 10, h: Math.round(b.h * 0.55), color: stainCore, alpha: 0.48 },
          ],
        });
      } else if (w.kind === 'faded-panel') {
        const panelBase = applyLightSample(resolveSwatch(w.color, L.storefrontTeal), light, 0.25);
        const faded = applyLightSample(mix(panelBase, U.coolConcrete, 0.5), light, 0.25);
        items.push({
          layer: 'wear',
          id: w.id || 'faded-panel',
          bounds: { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 },
          ops: [
            { op: 'fillRect', x: b.x, y: b.y, w: b.w, h: b.h, color: faded, alpha: 0.72 },
            { op: 'fillRect', x: b.x + 6, y: b.y + 4, w: Math.round(b.w * 0.45), h: Math.max(6, b.h - 8), color: panelBase, alpha: 0.76 },
          ],
        });
      }
    }

    // 4. Cosmetic competition scars (single scorch group: soot halo + charred core + directional blast streaks, 11.1 §5.5 & 41.2)
    for (const scar of mapAppearance.scars || []) {
      const b = scar.bounds;
      if (!b) continue;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (scar.kind === 'scorch-group') {
        const soot = U.structuralVoid;
        const ash = mix(U.structuralVoid, U.weatheredBrick, 0.32);
        const ember = mix(U.oxidizedMetal, U.structuralVoid, 0.45);
        items.push({
          layer: 'scars',
          id: scar.id || 'scorch-group',
          bounds: { x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16 },
          ops: [
            { op: 'fillEllipse', x: cx, y: cy, w: b.w, h: b.h, color: ash, alpha: 0.46 },
            { op: 'fillEllipse', x: cx - 4, y: cy + 2, w: b.w * 0.62, h: b.h * 0.58, color: soot, alpha: 0.66 },
            { op: 'fillEllipse', x: cx + b.w * 0.24, y: cy - b.h * 0.16, w: b.w * 0.34, h: b.h * 0.3, color: soot, alpha: 0.52 },
            { op: 'line', x1: cx - b.w * 0.38, y1: cy - b.h * 0.18, x2: cx + b.w * 0.36, y2: cy + b.h * 0.22, width: 3, color: ember, alpha: 0.55 },
            { op: 'line', x1: cx - b.w * 0.28, y1: cy + b.h * 0.24, x2: cx + b.w * 0.3, y2: cy - b.h * 0.2, width: 2, color: soot, alpha: 0.6 },
          ],
        });
      }
    }
  }

  // 5. Static theatrical lighting washes and focal edge rims (recorded once into tiles; never per-frame Graphics)
  if (art.lighting) {
    for (const f of fields) {
      const b = f.bounds;
      if (!b) continue;
      const tint = resolveSwatch(f.tint, T.cobaltBlue);
      const washAlpha = Math.max(0.06, Math.min(0.28, (f.intensity ?? 0.32) * 0.52));
      const ops = [
        { op: 'fillRect', x: b.x, y: b.y, w: b.w, h: b.h, color: tint, alpha: washAlpha },
      ];
      if (f.focalEdge) {
        const edge = f.focalEdge;
        const edgeColor = resolveSwatch(edge.color, G.sodiumAmber);
        ops.push({
          op: 'fillRect',
          x: edge.x ?? b.x,
          y: edge.y ?? b.y,
          w: edge.w ?? b.w,
          h: edge.h ?? 10,
          color: edgeColor,
          alpha: edge.alpha ?? 0.34,
        });
        if (edge.rimLine) {
          ops.push({
            op: 'line',
            x1: edge.rimLine.x1,
            y1: edge.rimLine.y1,
            x2: edge.rimLine.x2,
            y2: edge.rimLine.y2,
            width: edge.rimLine.width ?? 3,
            color: edgeColor,
            alpha: edge.rimLine.alpha ?? 0.78,
          });
        }
      }
      items.push({
        layer: 'lighting',
        id: `light:${f.id}`,
        bounds: { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 },
        ops,
      });
    }
  }

  return items;
}

/** Replay a list of declarative drawing ops (`fillRect`, `strokeRect`, `fillEllipse`, `line`) into a static recorder `g`. */
export function recordAppearanceOps(g, ops) {
  for (const item of ops) {
    if (item.op === 'fillRect' || item.kind === 'rect') {
      g.fillStyle(item.color, item.alpha ?? 1);
      g.fillRect(item.x, item.y, item.w, item.h);
    } else if (item.op === 'strokeRect') {
      g.lineStyle(item.width ?? 2, item.color, item.alpha ?? 1);
      g.strokeRect(item.x, item.y, item.w, item.h);
    } else if (item.op === 'fillEllipse' || item.kind === 'ellipse') {
      g.fillStyle(item.color, item.alpha ?? 1);
      g.fillEllipse(item.x, item.y, item.w, item.h);
    } else if (item.op === 'line') {
      g.lineStyle(item.width ?? 2, item.color, item.alpha ?? 1);
      g.lineBetween(item.x1, item.y1, item.x2, item.y2);
    }
  }
}
