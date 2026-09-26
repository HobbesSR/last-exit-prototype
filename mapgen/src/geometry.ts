/** Exact axis-agnostic segment geometry shared by clearance, navigation and validation. */

export function pointSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1,
    dy = y2 - y1,
    d = dx * dx + dy * dy;
  const t = d
    ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / d))
    : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function orient(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

export function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  if (
    Math.max(ax, bx) < Math.min(cx, dx) ||
    Math.max(cx, dx) < Math.min(ax, bx) ||
    Math.max(ay, by) < Math.min(cy, dy) ||
    Math.max(cy, dy) < Math.min(ay, by)
  )
    return false;
  const o1 = orient(ax, ay, bx, by, cx, cy),
    o2 = orient(ax, ay, bx, by, dx, dy),
    o3 = orient(cx, cy, dx, dy, ax, ay),
    o4 = orient(cx, cy, dx, dy, bx, by);
  return (
    (o1 === 0 &&
      o2 === 0 &&
      Math.min(ax, bx) <= cx &&
      Math.max(ax, bx) >= cx &&
      Math.min(ay, by) <= cy &&
      Math.max(ay, by) >= cy) ||
    (o1 * o2 <= 0 && o3 * o4 <= 0)
  );
}

/** Exact minimum distance between two segments; 0 when they touch or cross. */
export function segmentSegmentDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegmentDistance(ax, ay, cx, cy, dx, dy),
    pointSegmentDistance(bx, by, cx, cy, dx, dy),
    pointSegmentDistance(cx, cy, ax, ay, bx, by),
    pointSegmentDistance(dx, dy, ax, ay, bx, by),
  );
}
