import { portalStands } from '../../map/micro/portals.ts';

/**
 * A function from a point to the hunter stand (20.2) nearest it, over every portal of `region`.
 * An access test routes from a portal to each place a body must reach. A search ends when it
 * finds its target, so one from the nearest stand explores a fraction of what one from the
 * region's first portal does (31, #543). It proves the same thing: the portal promise joins
 * every portal's stands, and each builder's own promise test owns that.
 */
export function standNear(region) {
  const stands = portalStands(region).flatMap(({ points }) => points);
  const distance = (stand, point) => Math.hypot(stand.x - point.x, stand.y - point.y);
  return point => stands.reduce((best, stand) => distance(stand, point) < distance(best, point) ? stand : best, stands[0]);
}
