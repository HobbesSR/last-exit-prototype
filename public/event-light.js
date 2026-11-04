// Event-driven theatrical light (29.4 "Event light", 41.2, #594). Presentation only: turns the
// viewer's projected frame (effects, shots, firing traps) into a short, bounded list of flat glows
// drawn in a dynamic layer beneath actors and items. Never rebuilds static tiles, never reads
// simulation state beyond the projection, and never consumes RNG or allocates IDs.

import { T } from './palette.js';

/**
 * Bounds for the dynamic light layer. `max` caps the glows drawn per frame; `peak` is the strongest
 * additive alpha of a glow's core; `radius` caps how far one event can light.
 */
export const EVENT_LIGHT = Object.freeze({ max: 12, peak: 0.18, radius: 240, minRadius: 72 });

/** Effect kinds that light their surroundings, by theatrical swatch. Pickups (`loot`, `upgrade`) don't. */
export const EVENT_LIGHT_TINTS = Object.freeze({
  shock: T.crimsonRose,
  slash: T.crimsonRose,
  rail: T.electricTurquoise,
  scan: T.electricTurquoise,
  charge: T.cobaltBlue,
  grapple: T.ultraviolet,
});

/** Effects live 12 ticks (`effect()` in shared/simulation/loot.ts); glows fade over the same span. */
const EFFECT_LIFE = 12;
const SHOT = Object.freeze({ tint: T.hotOrange, radius: 44, strength: 0.4 });
// The jet the renderer draws is 240 long with a 0.64 rad half-angle; the glow covers about that footprint.
const FLAME = Object.freeze({ tint: T.hotOrange, radius: 130, reach: 120, strength: 0.65 });

const order = (a, b) => b.strength - a.strength || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/**
 * Glows for one rendered frame, strongest first, at most `max`.
 *
 * Privacy (29.4 "Protect information and identity"): effects and shots reach the client by range,
 * not by sight, so every source must pass `lit(x, y)`, the same rule that decides whether the
 * renderer draws the effect itself. An unseen event never lights anything, even where its glow
 * would fall inside the viewer's sight.
 *
 * The result depends only on the frame and `alpha`, so it needs no reset on seek, cut or view change.
 */
export function resolveEventLights(frame, { lighting = true, lit = () => true, inView = () => true, alpha = 0, max = EVENT_LIGHT.max } = {}) {
  if (lighting === false || !frame) return [];
  const lights = [];
  // `source` is the point the renderer tests to draw the event; the glow may sit elsewhere.
  const add = (id, x, y, radius, tint, strength, source = { x, y }) => {
    if (strength <= 0 || !lit(source.x, source.y) || !inView(x, y, radius)) return;
    lights.push({ id, x, y, radius, tint, strength: Number((EVENT_LIGHT.peak * strength).toFixed(4)) });
  };
  for (const e of frame.effects || []) {
    const tint = EVENT_LIGHT_TINTS[e.kind];
    if (tint === undefined) continue;
    const radius = Math.min(EVENT_LIGHT.radius, Math.max(EVENT_LIGHT.minRadius, (e.radius || 0) * 1.5));
    add(`fx:${e.id}`, e.x, e.y, radius, tint, Math.min(1, Math.max(0, e.life - alpha) / EFFECT_LIFE));
  }
  for (const b of frame.projectiles || []) {
    add(`shot:${b.id}`, b.x + (b.dx || 0) * alpha, b.y + (b.dy || 0) * alpha, SHOT.radius, SHOT.tint, SHOT.strength);
  }
  for (const trap of frame.traps || []) {
    if (trap.kind !== 'flame' || !trap.firing || trap.spent) continue;
    // The source is the nozzle, which is all the renderer tests before drawing the jet; the glow
    // sits a little way down the jet, so a seen flame firing into a wall still lights its side.
    const heading = trap.heading || 0;
    add(`trap:${trap.id}`, trap.x + Math.cos(heading) * FLAME.reach, trap.y + Math.sin(heading) * FLAME.reach, FLAME.radius, FLAME.tint, FLAME.strength, trap);
  }
  lights.sort(order);
  return lights.length > max ? lights.slice(0, max) : lights;
}

/**
 * A glow is `STEPS` stacked flat discs, so added light falls off about linearly from the centre and
 * no single edge is strong enough to read as a zone or hazard boundary. No outline is drawn.
 */
const STEPS = 4;

/** A unit 24-gon: a soft glow needs no finer outline than this. */
const SIDES = 24;
const UNIT = Array.from({ length: SIDES }, (_, i) => [Math.cos(i * 2 * Math.PI / SIDES), Math.sin(i * 2 * Math.PI / SIDES)]);
const scratch = UNIT.map(() => ({ x: 0, y: 0 }));

/** Draw glows additively (the layer's blend mode is ADD). */
export function drawEventLights(g, lights) {
  g.clear();
  for (const light of lights) {
    g.fillStyle(light.tint, light.strength / STEPS);
    for (let i = 0; i < STEPS; i++) {
      const r = light.radius * (STEPS - i) / STEPS;
      for (let k = 0; k < SIDES; k++) { scratch[k].x = light.x + UNIT[k][0] * r; scratch[k].y = light.y + UNIT[k][1] * r; }
      g.fillPoints(scratch, true);
    }
  }
}

/** The light `drawEventLights` adds at a point, as an [r, g, b] lift, summed over glows. */
export function eventLightAt(lights, x, y) {
  let r = 0, g = 0, b = 0;
  for (const light of lights) {
    const d = Math.hypot(x - light.x, y - light.y);
    let discs = 0;
    for (let i = 0; i < STEPS; i++) if (d < light.radius * (STEPS - i) / STEPS) discs++;
    if (!discs) continue;
    const a = light.strength * discs / STEPS;
    r += (light.tint >> 16 & 255) * a; g += (light.tint >> 8 & 255) * a; b += (light.tint & 255) * a;
  }
  return [r, g, b];
}

/**
 * Lift a color drawn above the light layer by the light beneath it, so a prop brightens with the
 * ground it stands on instead of losing separation from it (29.4 virtual lighting).
 */
export function liftByEventLight(color, lift) {
  if (!lift[0] && !lift[1] && !lift[2]) return color;
  const ch = (shift, add) => Math.min(255, Math.round((color >> shift & 255) + add));
  return ch(16, lift[0]) << 16 | ch(8, lift[1]) << 8 | ch(0, lift[2]);
}
