import { rect } from '../../../shared/shape.ts';
import { createFillMask, createRegionMask, elementShapes } from '../geometry.ts';
import { LANDMARK_KINDS, LANDMARK_SITE } from '../placeables/landmark-site.ts';
import type { LandmarkDetails, LandmarkKind } from '../placeables/landmark-site.ts';
import { placedElements } from '../placeables/placeable.ts';
import type { Placed } from '../placeables/placeable.ts';
import { draw, rng } from '../random.ts';
import { builtRegion } from '../result.ts';
import type { BuildingObserver } from '../building/trace.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import { cellLoot, liveCord, unfilledRegion } from './scatter.ts';

/** Per-choice draw channels, so no choice shifts another. */
const CHANNEL = { kind: 1, site: 2, seed: 3, loot: 4 };

/**
 * The parameters a landmark region accepts: `kind` names one silhouette (`landmark-site`'s
 * values), and the default is drawn per region. A brief that asks for a kind its cells cannot
 * hold leaves the ground `open` rather than inventing a smaller landmark.
 */
function requestedKind(brief: RegionBrief): LandmarkKind | undefined {
  const value = brief.parameters?.kind;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(LANDMARK_KINDS as readonly string[]).includes(value))
    throw new RangeError(`Landmark kind must be one of ${LANDMARK_KINDS.join(', ')}.`);
  return value as LandmarkKind;
}

/**
 * The `landmark` region type (54, 11.1 §8, #769): one block-scale landmark in its ground, built
 * through the building pipeline. Each silhouette is a building design, allocated and realized
 * (`landmark-site`), so it gets real walls, gates, thresholds, an element `Building` record and
 * roof groups rather than hand-placed parts. Doors keep their two-cell doorsteps inside the fill;
 * the landmark may otherwise sit flush to the region's boundary. Siting goes through a live cord
 * (20.10), which refuses a position that would leave a portal stand without a hunter cord, so the
 * portal promise holds as the landmark is placed. A lot too small for every silhouette keeps its
 * ground `open` with zone loot (17 M24).
 */
export function buildLandmark(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const asked = requestedKind(brief);
  if (!createFillMask(brief).cells.length) return unfilledRegion(brief, CHANNEL.loot);
  const size = brief.cellSize, fill = createFillMask(brief), mask = createRegionMask(brief);
  const x0 = Math.round(fill.bounds.x / size), y0 = Math.round(fill.bounds.y / size);
  const W = Math.round(fill.bounds.w / size), H = Math.round(fill.bounds.h / size);
  const order = asked ? [asked] : rng(brief.seed, `${brief.id}:landmark-kind`).shuffle(LANDMARK_KINDS);
  const coordinator = liveCord(brief, 'Landmark');

  let built: { kind: LandmarkKind; placed: Placed<LandmarkDetails> } | undefined;
  search: for (const kind of order) {
    const placed = LANDMARK_SITE.build({ kind, seed: Math.floor(draw(brief.seed, 0, 0, CHANNEL.seed) * 2 ** 31) }, size);
    if ('refused' in placed) continue;
    const { w, h } = placed.demand.body;
    for (let y = y0; y + h <= y0 + H; y++) for (let x = x0; x + w <= x0 + W; x++) {
      const body = rect(x * size, y * size, w * size, h * size);
      if (!fill.contains(body) || !coordinator.fits(body)) continue;
      if (!placed.demand.clear.every(box => fill.contains(
        rect((x + box.x) * size, (y + box.y) * size, box.w * size, box.h * size)))) continue;
      if (!coordinator.commit({ elements: placedElements(placed, `landmark-${kind}`, x, y, size) })) continue;
      built = { kind, placed };
      break search;
    }
  }

  const elements = [...coordinator.elements];
  if (!built || !elements.length) return unfilledRegion(brief, CHANNEL.loot);
  const { details } = built.placed;
  if (observe) observe({ label: `landmark-${built.kind}`, origin: { x: elements[0].x, y: elements[0].y },
    cellSize: size, design: details.design, allocation: details.allocation, realization: details.realization });
  const loot = cellLoot(brief, mask, elements.flatMap(element => elementShapes(element, true)), CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { landmarks: 1 });
}
