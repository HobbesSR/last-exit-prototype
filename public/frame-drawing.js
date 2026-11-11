import { gateShape } from '/shared/movement.ts';
import { seesPoint, seesActor, roofAt, roofRevealed, stepRoofAlpha, openingDistance, createShapeVisibility, LOD_LOW_ZOOM, LOD_MEDIUM_ZOOM } from '/shared/view.ts';
import { outline } from '/shared/shape.ts';
import { bodyRadius, bodyShape } from '/shared/physics/presentation-geometry.ts';
import { sampleSpatialLight, resolvePropAppearance } from './appearance.js';
import { eventLightAt, liftByEventLight } from './event-light.js';

// The per-frame layers, drawn by the arena scene's `update` in the order listed there. Each is
// handed its graphics target, its slice of the frame and the frame's view; none keeps state.

// Heard gunfire's ring and edge arrow (#684).
const HEARD = 0xffba62;
const COLORS = { access: 0xf4d26c, med: 0xff8b97, weapon: 0x8bd9f0, shield: 0xa3b9ff, cell: 0xffe98a, ammo: 0xc5f16f };

/**
 * What every layer asks of the frame: where the camera is, how detailed to draw, and the two culling
 * rules. One instance lives on the scene and is refilled each frame, so `update` allocates nothing for
 * it; `nearView` and `lit` are bound once and can be handed on as plain functions.
 */
export class FrameView {
  constructor() {
    this.map = null; this.sight = null; this.fogged = false; this.now = 0; this.alpha = 0;
    this.cx = 0; this.cy = 0; this.zoom = 1; this.halfWidth = 0; this.halfHeight = 0; this.lowLod = false; this.medLod = false;
    /** Whether a point lies within the camera's view plus a margin. */
    this.nearView = (x, y, margin = 400) => Math.abs(x - this.cx) < this.halfWidth + margin && Math.abs(y - this.cy) < this.halfHeight + margin;
    // The server sends a wider set than the eye can reach, so the renderer resolves the geometry.
    // Sight itself is a shared rule; an unfogged view opts out of it rather than reimplementing it.
    this.lit = (x, y) => !this.fogged || seesPoint(this.sight, this.map, x, y);
  }
  /** Take the camera's centre and zoom for this frame. */
  setCamera({ x, y, zoom }, width, height) {
    this.cx = x; this.cy = y; this.zoom = zoom;
    this.halfWidth = width / zoom / 2; this.halfHeight = height / zoom / 2;
    // Level of detail thresholds for distant / spectator views:
    // zoom < LOD_LOW_ZOOM: simplified rects / outlines, skip sub-pixel inner details and rounded arc tessellations.
    // zoom < LOD_MEDIUM_ZOOM: simplified item geometry without sinusoids or drop shadows.
    // zoom >= LOD_MEDIUM_ZOOM: full detail with floating animations, drop shadows and glyphs.
    this.lowLod = zoom < LOD_LOW_ZOOM; this.medLod = zoom < LOD_MEDIUM_ZOOM;
  }
}

/**
 * Step every roof's fade. A roof is either revealed (inside its group, or at one of its openings) or
 * covered, and fades between the two at a constant rate. This is cosmetic: concealment is still
 * decided by `roofConceals`. Every roof on the map steps, near the view or not, so this grows with
 * map size.
 */
export function fadeRoofs(map, { roofs, roofMembers, coveredBuildingIds }, eye, openings, fadeMs, view) {
  const inside = eye && roofAt(map, eye);
  const insideMembers = inside ? (roofMembers.get(inside.id) || [inside]) : [];
  const insideGroupIds = new Set(insideMembers.map(m => 'groupId' in m ? m.groupId : m.id));
  const insideIds = new Set(insideMembers.map(m => m.id));
  if (map.roofs?.length) {
    for (const roof of map.roofs) {
      const roofObj = roofs.get(roof.id);
      if (!roofObj) continue;
      const isInside = insideGroupIds.has(roof.groupId) || insideIds.has(roof.id);
      const members = roofMembers.get(roof.id) || [roof];
      const revealed = !view.fogged || !!eye && roofRevealed(isInside, openingDistance(map, members, eye, openings));
      roofObj.alpha = stepRoofAlpha(roofObj.alpha, revealed, fadeMs);
      roofObj.visible = roofObj.alpha > 0 && view.nearView(roof.bounds.x + roof.bounds.w / 2, roof.bounds.y + roof.bounds.h / 2);
    }
  }
  for (const building of map.buildings || []) {
    if (coveredBuildingIds.has(building.id)) continue;
    const roof = roofs.get(building.id);
    if (!roof) continue;
    const isInside = insideIds.has(building.id);
    const members = roofMembers.get(building.id) || [building];
    const revealed = !view.fogged || !!eye && roofRevealed(isInside, openingDistance(map, members, eye, openings));
    roof.alpha = stepRoofAlpha(roof.alpha, revealed, fadeMs);
    roof.visible = roof.alpha > 0 && view.nearView(building.x + building.w / 2, building.y + building.h / 2);
  }
}

/**
 * The physics bodies this view may show, by id. Physics projections contain authorized endpoints, but
 * current sight can still withhold an actor (cloak, roof, status). Tethers must use the same actor
 * rule as the sprite they join.
 */
export function visibleBodies(state, playersById, viewer, view) {
  const propVisible = createShapeVisibility(view.sight, view.map);
  return new Map((state.bodies || []).filter(body => {
    if (body.kind !== 'actor') return !view.fogged || propVisible(bodyShape(body));
    const player = playersById.get(body.actorId);
    if (!player || player.status !== 'active') return false;
    const atBody = { ...player, x: body.x, y: body.y };
    return !view.fogged || player.id === viewer?.id || seesActor(view.sight, view.map, viewer, atBody);
  }).map(body => [body.id, body]));
}

export function drawTethers(g, tethers, bodies, { fogged, lit, nearView }) {
  for (const tether of tethers) {
    const a = bodies.get(tether.a), b = bodies.get(tether.b);
    if (!a || !b || !nearView((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y) / 2)) continue;
    // Seeing a prop's edge does not expose its hidden center anchor. Omit that tether rather
    // than drawing a line into shadow; actor anchors retain their cloak/reveal policy above.
    if (fogged && (a.kind === 'prop' && !lit(a.x, a.y) || b.kind === 'prop' && !lit(b.x, b.y))) continue;
    g.lineStyle(3, 0xd6dfbd, 0.85); g.lineBetween(a.x, a.y, b.x, b.y);
  }
}

export function drawHookFlight(g, caster, flight) {
  g.lineStyle(3, 0xd6dfbd, 0.85); g.lineBetween(caster.x, caster.y, flight.x, flight.y);
  g.fillStyle(0xe9f5d4, 0.95); g.fillCircle(flight.x, flight.y, 4);
}

export function drawHookFlights(g, flights, bodies, { fogged, lit, nearView }) {
  for (const flight of flights) {
    const caster = bodies.get(flight.a);
    if (!caster || fogged && !lit(flight.x, flight.y) ||
      !nearView((caster.x + flight.x) / 2, (caster.y + flight.y) / 2,
        Math.hypot(caster.x - flight.x, caster.y - flight.y) / 2)) continue;
    drawHookFlight(g, caster, flight);
  }
}

/** Loose props, lit by the map's light fields and any event light; props carrying an item are drawn as items. */
export function drawProps(g, bodies, items, fields, artOpts, eventLights, { nearView }) {
  const drawnItems = new Set(items.map(item => item.id));
  for (const body of bodies.values()) {
    if (body.kind !== 'prop' || body.itemId != null && drawnItems.has(body.itemId)) continue;
    const shape = body.shape;
    if (!nearView(body.x, body.y, bodyRadius(shape))) continue;
    const propLight = sampleSpatialLight(fields, body.x, body.y, artOpts);
    const { fill: propFill, stroke: propStroke } = resolvePropAppearance(0x8fa9a0, 0xdce8d7, propLight, artOpts);
    const propLift = eventLights.length ? eventLightAt(eventLights, body.x, body.y) : [0, 0, 0];
    g.fillStyle(liftByEventLight(propFill, propLift), 0.9); g.lineStyle(2, liftByEventLight(propStroke, propLift), 0.95);
    if (shape.kind === 'circle') {
      g.fillCircle(body.x, body.y, shape.radius); g.strokeCircle(body.x, body.y, shape.radius);
    } else {
      const points = outline(bodyShape(body));
      g.fillPoints(points, true); g.strokePoints(points, true);
    }
  }
}

/** Doors and gates: what the view remembers when fogged, the truth otherwise. */
export function drawGates(fixed, gates, { nearView, lowLod }) {
  for (const gate of gates) {
    if (!nearView(gate.x, gate.y, 60)) continue;
    if (gate.kind === 'door') {
      const box = gateShape(gate);
      if (lowLod) {
        if (gate.open) {
          fixed.lineStyle(2, gate.stale ? 0x687789 : 0xe8bc74);
          fixed.strokeRect(box.x, box.y, box.w, box.h);
        } else {
          fixed.fillStyle(gate.stale ? 0x494451 : 0xa07952);
          fixed.fillRect(box.x, box.y, box.w, box.h);
        }
        continue;
      }
      fixed.lineStyle(3, gate.stale ? 0x687789 : 0xe8bc74);
      if (gate.open) fixed.strokeRect(box.x, box.y - 55, 12, 70);
      else { fixed.fillStyle(gate.stale ? 0x494451 : 0xa07952); fixed.fillRect(box.x, box.y, box.w, box.h); fixed.strokeRect(box.x, box.y, box.w, box.h); }
      continue;
    }
    if (lowLod) {
      if (gate.open) {
        fixed.lineStyle(2, gate.stale ? 0x758583 : 0xa6e5dc, gate.stale ? 0.55 : 1);
        fixed.strokeRect(gate.x - 13, gate.y - 27, 26, 54);
      } else {
        fixed.fillStyle(gate.stale ? 0x263c43 : 0xf5cf76);
        fixed.fillRect(gate.x - 13, gate.y - 27, 26, 54);
      }
      continue;
    }
    if (gate.open) {
      fixed.lineStyle(3, gate.stale ? 0x758583 : 0xa6e5dc, gate.stale ? 0.55 : 1);
      fixed.strokeRoundedRect(gate.x - 15, gate.y - 29, 30, 58, 3);
      continue;
    }
    fixed.fillStyle(0x304e44); fixed.fillRoundedRect(gate.x - 13, gate.y - 27, 26, 54, 3);
    fixed.lineStyle(3, 0xf5cf76); fixed.strokeRoundedRect(gate.x - 10, gate.y - 24, 20, 48, 2);
    fixed.fillStyle(0xf5cf76); fixed.fillCircle(gate.x, gate.y - 3, 4); fixed.fillRect(gate.x - 2, gate.y, 4, 9);
    if (gate.stale) {
      fixed.fillStyle(0x263c43, 0.65); fixed.fillRoundedRect(gate.x - 13, gate.y - 27, 26, 54, 3);
      fixed.lineStyle(2, 0xb2c4c9, 0.8); fixed.strokeCircle(gate.x, gate.y, 7);
      if (!gate.known) { fixed.lineBetween(gate.x, gate.y - 4, gate.x, gate.y + 1); fixed.fillStyle(0xb2c4c9); fixed.fillCircle(gate.x, gate.y + 4, 1); }
    }
  }
}

/** Loot, at its physics body when it has one, bobbing at full detail. */
export function drawItems(g, items, itemBodies, { nearView, lit, lowLod, medLod, now }) {
  for (const rawItem of items) {
    const itemBody = itemBodies.get(rawItem.id);
    const item = itemBody ? { ...rawItem, x: itemBody.x, y: itemBody.y } : rawItem;
    if (!nearView(item.x, item.y, 30)) continue;
    if (!lit(item.x, item.y)) continue;
    if (lowLod) {
      g.fillStyle(COLORS[item.kind]);
      g.fillRect(item.x - 8, item.y - 8, 16, 16);
      continue;
    }
    if (medLod) {
      g.fillStyle(0x28473f); g.fillRect(item.x - 12, item.y - 12, 24, 24);
      g.fillStyle(COLORS[item.kind]); g.fillRect(item.x - 8, item.y - 8, 16, 16);
      continue;
    }
    const y = item.y + Math.sin(now / 340 + item.x) * 2;
    g.fillStyle(0x284735, 0.2); g.fillEllipse(item.x + 2, y + 10, 26, 11);
    g.fillStyle(0x28473f); g.fillRoundedRect(item.x - 12, y - 12, 24, 24, 5);
    g.lineStyle(2, COLORS[item.kind]); g.strokeRoundedRect(item.x - 12, y - 12, 24, 24, 5); g.fillStyle(COLORS[item.kind]);
    if (item.kind === 'med') { g.fillRect(item.x - 2, y - 7, 4, 14); g.fillRect(item.x - 7, y - 2, 14, 4); }
    else if (item.kind === 'access') { g.strokeCircle(item.x - 2, y - 2, 4); g.lineBetween(item.x, y, item.x + 6, y + 6); }
    else if (item.kind === 'weapon') { g.fillRect(item.x - 7, y - 3, 14, 4); g.fillRect(item.x - 3, y, 4, 6); }
    else if (item.kind === 'ammo') { for (const dx of [-5, 0, 5]) { g.fillRect(item.x + dx - 1.5, y - 4, 3, 10); g.fillTriangle(item.x + dx - 1.5, y - 4, item.x + dx + 1.5, y - 4, item.x + dx, y - 7); } }
    else if (item.kind === 'cell') { g.strokeRect(item.x - 5, y - 7, 10, 14); g.fillRect(item.x - 2, y - 10, 4, 3); if (item.charge > 0) g.fillRect(item.x - 3, y - 3, 6, 8); }
    else g.fillTriangle(item.x - 7, y - 5, item.x + 7, y - 5, item.x, y + 8);
  }
}

/** Sensors: their reach and a sweeping beam, drawn through fog because the map declares them. */
export function drawSensors(fixed, sensors, { nearView, lowLod, now }) {
  for (const sensor of sensors) {
    if (!nearView(sensor.x, sensor.y, 200)) continue;
    fixed.fillStyle(0xf2df82, 0.08); fixed.fillCircle(sensor.x, sensor.y, 180); fixed.lineStyle(1, 0xe6d174, 0.5); fixed.strokeCircle(sensor.x, sensor.y, 180);
    if (!lowLod) {
      fixed.fillStyle(0x355749); fixed.fillCircle(sensor.x, sensor.y, 11); fixed.fillStyle(0xffeaa0); fixed.fillCircle(sensor.x, sensor.y, 4);
    }
    fixed.lineStyle(2, 0xe6d174, 0.5); fixed.lineBetween(sensor.x, sensor.y, sensor.x + Math.cos(now / 1200) * 174, sensor.y + Math.sin(now / 1200) * 174);
  }
}

export function drawTraps(g, traps, { nearView, lit, lowLod, now }) {
  for (const trap of traps) {
    if (trap.spent || !lit(trap.x, trap.y)) continue;
    const heading = trap.heading || 0;
    if (trap.kind === 'mine') {
      if (!nearView(trap.x, trap.y, 20)) continue;
      g.fillStyle(0x282c39); g.fillCircle(trap.x, trap.y, 15); g.lineStyle(2, 0xff778c); g.strokeCircle(trap.x, trap.y, 12);
      g.fillStyle(Math.floor(now / 400) % 2 ? 0xff778c : 0x583c48); g.fillCircle(trap.x, trap.y, 4);
    } else if (trap.kind === 'spider') {
      // A roaming spider body can chase up to leash (360) from its home ring (240 radius).
      const ringInView = nearView(trap.homeX, trap.homeY, 240);
      const spiderInView = nearView(trap.x, trap.y, 30);
      if (!ringInView && !spiderInView) continue;
      if (ringInView) {
        g.lineStyle(1, 0xc5aecf, 0.25); g.strokeCircle(trap.homeX, trap.homeY, 240);
        if (!lowLod) {
          for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            g.lineBetween(trap.homeX, trap.homeY, trap.homeX + Math.cos(a) * 240, trap.homeY + Math.sin(a) * 240);
          }
        }
      }
      if (spiderInView) {
        if (!lowLod) {
          g.lineStyle(3, 0xb297c1);
          for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            g.lineBetween(trap.x + Math.cos(a) * 10, trap.y + Math.sin(a) * 10, trap.x + Math.cos(a + 0.25) * 25, trap.y + Math.sin(a + 0.25) * 25);
          }
        }
        g.fillStyle(0x574d6b); g.fillCircle(trap.x, trap.y, 13); g.fillStyle(0xff879f); g.fillCircle(trap.x + Math.cos(heading) * 8, trap.y + Math.sin(heading) * 8, 4);
      }
    } else {
      if (!nearView(trap.x, trap.y, 260)) continue;
      g.fillStyle(0x282c39); g.fillRoundedRect(trap.x - 19, trap.y - 19, 38, 38, 6);
      g.lineStyle(3, trap.kind === 'flame' ? 0xffba62 : 0xff879f); g.strokeCircle(trap.x, trap.y, 15);
      g.lineStyle(8, 0xadb8c2); g.lineBetween(trap.x, trap.y, trap.x + Math.cos(heading) * 28, trap.y + Math.sin(heading) * 28);
      if (trap.kind === 'flame' && (trap.warning || trap.firing)) {
        g.fillStyle(trap.firing ? 0xff873e : 0xffd36c, trap.firing ? 0.65 : 0.18);
        g.fillTriangle(trap.x, trap.y, trap.x + Math.cos(heading - 0.64) * 240, trap.y + Math.sin(heading - 0.64) * 240, trap.x + Math.cos(heading + 0.64) * 240, trap.y + Math.sin(heading + 0.64) * 240);
      }
    }
  }
}

/** Projectiles advanced by the frame's interpolation fraction. */
export function projectShots(projectiles, alpha) {
  return projectiles.map(b => ({ id: b.id, x: b.x + b.dx * alpha, y: b.y + b.dy * alpha, dx: b.dx, dy: b.dy }));
}

export function drawShots(g, shots, { lit }) {
  for (const b of shots) {
    if (!lit(b.x, b.y)) continue;
    g.lineStyle(3, 0xffffd8); g.lineBetween(b.x, b.y, b.x - b.dx * 0.7, b.y - b.dy * 0.7);
  }
}

export function drawEffects(g, effects, { lit, alpha }) {
  for (const e of effects) {
    if (!lit(e.x, e.y)) continue;
    const a = Math.max(0, e.life - alpha) / 12; g.lineStyle(3, ['shock', 'slash'].includes(e.kind) ? 0xff777e : ['scan', 'rail'].includes(e.kind) ? 0x96dcf4 : 0xeafdc1, a); g.strokeCircle(e.x, e.y, e.radius * (1 - a * 0.7));
    if (e.kind === 'smoke') { g.fillStyle(0xeaf4de, a * 0.45); g.fillCircle(e.x, e.y, e.radius * (1 - a * 0.6)); }
  }
}

/** The advancing hazard wall. The waiting area before a match (#236) has none. */
export function drawHazard(fixed, hazardX, map) {
  if (hazardX == null) return;
  fixed.fillStyle(0xd65065, 0.68); fixed.fillRect(-80, -80, Math.max(0, hazardX + 80), map.height + 160);
  fixed.lineStyle(4, 0xffaaa1); fixed.lineBetween(hazardX, -80, hazardX, map.height + 80);
}

/**
 * Heard gunfire (#684, 15): the player's own cues, an area rather than an actor, so drawn through walls
 * and fog. On screen a fading ring over the cell; off screen an arrow at the view's edge toward it.
 */
export function drawHeardCues(g, cues, tick, { cx, cy, zoom, halfWidth, halfHeight }) {
  for (const cue of cues) {
    const fade = Math.max(0, Math.min(1, (cue.until - tick) / Math.max(1, cue.until - cue.tick)));
    const dx = cue.x - cx, dy = cue.y - cy, edge = Math.max(Math.abs(dx) / (halfWidth - 40 / zoom), Math.abs(dy) / (halfHeight - 40 / zoom));
    if (edge <= 1) {
      g.lineStyle(3 / zoom, HEARD, 0.85 * fade); g.strokeCircle(cue.x, cue.y, 96);
      g.lineStyle(2 / zoom, HEARD, 0.5 * fade); g.strokeCircle(cue.x, cue.y, 96 * (1.6 - 0.6 * fade));
      continue;
    }
    const angle = Math.atan2(dy, dx), size = 18 / zoom, tipX = cx + dx / edge, tipY = cy + dy / edge;
    g.fillStyle(HEARD, 0.35 + 0.6 * fade);
    g.fillTriangle(tipX, tipY, tipX - Math.cos(angle - 0.5) * size, tipY - Math.sin(angle - 0.5) * size,
      tipX - Math.cos(angle + 0.5) * size, tipY - Math.sin(angle + 0.5) * size);
  }
}
