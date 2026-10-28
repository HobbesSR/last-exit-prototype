// Lab-only geometric squish shell for #455 (42.21). It reads the world; it never writes to it, so the
// solid core, containment, recordings and prediction are untouched. Nothing here is a game rule.
import { firstContact } from '/shared/simulation/swept.ts';

/**
 * Provisional values to tune by feel in the lab, not agreed rules. The default thickness puts a contestant's
 * shell about where the recorded jelly's ring sits (24 units from its centre, 42.21), which Corey judged good.
 * One side flattened all the way to the core reads 0.5 and both sides read 1, so `releaseLevel` sits above 0.5:
 * a body pinned on one side recovers.
 */
export const SQUISH = Object.freeze({ directions: 24, thickness: 12, crushLevel: 0.9, releaseLevel: 0.6, holdTicks: 6 });

/**
 * A soft outline `thickness` beyond a solid core, flattened wherever something solid is closer.
 * Each direction is a ray from the core's centre against the walls, closed gates and solid props
 * (`blockers`, from `solidBlockers`) and against `others`, circles for the other actors. The outline
 * radius there is the distance to what it hits, kept between the core and the shell, so it is local to
 * the contact and arrives on the same tick as the contact, with no filter in between.
 *
 * `squeeze` is the largest pinch over opposite direction pairs: 0 when the pair is free, 1 when
 * both sides are flattened down to the core. It is what a rigid core can be squeezed to.
 */
export function squishShell(origin, coreRadius, thickness, blockers, others = [], directions = SQUISH.directions) {
  if (!(thickness > 0) || directions % 2) throw new RangeError('positive thickness and an even direction count required');
  const reach = coreRadius + thickness, radii = [];
  for (let i = 0; i < directions; i++) {
    const angle = i * 2 * Math.PI / directions, dx = Math.cos(angle), dy = Math.sin(angle);
    const hit = firstContact(origin, { x: origin.x + dx * reach, y: origin.y + dy * reach }, blockers, 0);
    let distance = Number.isFinite(hit) ? hit * reach : Infinity;
    for (const other of others) {
      const ox = origin.x - other.x, oy = origin.y - other.y;
      const along = ox * dx + oy * dy, inside = ox * ox + oy * oy - other.radius * other.radius;
      const discriminant = along * along - inside;
      if (discriminant < 0) continue;
      const t = inside <= 0 ? 0 : -along - Math.sqrt(discriminant);
      if (t >= 0 && t < distance) distance = t;
    }
    radii.push(Math.min(reach, Math.max(coreRadius, distance)));
  }
  let squeeze = 0, axis = 0;
  for (let i = 0; i < directions / 2; i++) {
    const pinch = (2 * reach - radii[i] - radii[i + directions / 2]) / (2 * thickness);
    if (pinch > squeeze) { squeeze = pinch; axis = i; }
  }
  return { reach, radii, squeeze: Math.min(1, squeeze), axis: axis * 2 * Math.PI / directions };
}

/** Crushed once the pinch has held at `crushLevel` for `holdTicks`; recovered below `releaseLevel`. */
export function stepSquish(previous, squeeze, { crushLevel, releaseLevel, holdTicks } = SQUISH) {
  const held = squeeze >= crushLevel ? (previous?.held ?? 0) + 1 : 0;
  const crushed = squeeze < releaseLevel ? false : (previous?.crushed ?? false) || held >= holdTicks;
  return { held, crushed };
}
