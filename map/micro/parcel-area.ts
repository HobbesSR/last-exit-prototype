import { CLIP_SCALE, construct } from '../../shared/shape-construction.ts';
import { outline, polygon, rect, type Shape } from '../../shared/shape.ts';
import type { Vec2 } from '../../shared/types.ts';
import type { Cell } from '../kernel/cell.ts';
import { validShape } from './geometry.ts';

const cross = (a: Vec2, b: Vec2, p: Vec2) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const signed = (p: readonly Vec2[]) => p.length < 3 ? 0 : p.reduce((s, a, i) => s + cross(p[0]!, a, p[(i + 1) % p.length]!), 0);

/** Validate a simple polygon, including concave input. */
function validate(shape: Shape): void {
  if (!shape || !Number.isFinite(shape.x) || !Number.isFinite(shape.y)) throw new TypeError('Invalid parcel shape');
  if (shape.kind === 'circle') throw new TypeError('Circular parcel envelopes are unsupported');
  const representable = (v: number) => Number.isSafeInteger(Math.round(v * CLIP_SCALE));
  if (shape.kind === 'rect') {
    if (!Number.isFinite(shape.w) || !Number.isFinite(shape.h) || shape.w <= 0 || shape.h <= 0) throw new TypeError('Invalid parcel rectangle');
    if (![shape.x, shape.y, shape.x + shape.w, shape.y + shape.h].every(representable)) throw new TypeError('Parcel coordinates exceed construction range');
    return;
  }
  if (shape.kind !== 'polygon' || !Array.isArray(shape.points) || shape.points.length < 3 || shape.points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new TypeError('Invalid parcel polygon');
  if (shape.points.length > 256) throw new RangeError('Parcel polygon exceeds vertex budget');
  const p = outline(shape), n = p.length;
  if (p.some(point => !representable(point.x) || !representable(point.y))) throw new TypeError('Parcel coordinates exceed construction range');
  if (!signed(p)) throw new TypeError('Invalid parcel polygon');
  const on = (a: Vec2, b: Vec2, c: Vec2) => cross(a, b, c) === 0 && c.x >= Math.min(a.x,b.x) && c.x <= Math.max(a.x,b.x) && c.y >= Math.min(a.y,b.y) && c.y <= Math.max(a.y,b.y);
  for (let i = 0; i < n; i++) {
    const a = p[i]!, b = p[(i + 1) % n]!;
    if (a.x === b.x && a.y === b.y) throw new TypeError('Invalid parcel polygon');
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || i === 0 && j === n - 1) continue;
      const c = p[j]!, d = p[(j + 1) % n]!, ab = cross(a,b,c), ac = cross(a,b,d), cd = cross(c,d,a), ce = cross(c,d,b);
      if ((ab * ac < 0 && cd * ce < 0) || on(a,b,c) || on(a,b,d) || on(c,d,a) || on(c,d,b)) throw new TypeError('Self-intersecting parcel polygon');
    }
  }
}

/**
 * Canonical convex envelope pieces using the existing 1/256 construction topology
 * and restored world-space edges. Sub-grid slivers may be lost; the returned
 * pieces define the envelope used for both routing and population containment.
 * Circular envelopes are unsupported (circular content footprints are supported).
 */
export function parcelArea(shapes: readonly Shape[]): Shape[] {
  if (!Array.isArray(shapes)) throw new TypeError('Parcel area must be an array');
  if (shapes.length > 4096 || shapes.reduce((n, s) => n + (s?.kind === 'polygon' && Array.isArray(s.points) ? s.points.length : 4), 0) > 16384)
    throw new RangeError('Parcel area exceeds geometry budget');
  shapes.forEach(validate);
  // Snap precedence must not depend on input order.
  const ordered = [...shapes].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return construct(ordered).pieces().flatMap(piece => {
    if (piece.kind !== 'polygon' || piece.points.length <= 64) return [piece];
    const points = outline(piece);
    return points.slice(2).map((p, i) => polygon(0, 0, [points[0]!, points[i + 1]!, p]));
  });
}

/** Union of whole world-space cells. */
export function parcelCells(cells: readonly Cell[], cellSize: number): Shape[] {
  if (!Array.isArray(cells) || !Number.isFinite(cellSize) || cellSize <= 0 || cells.some(c => !c || !Number.isSafeInteger(c.x) || !Number.isSafeInteger(c.y))) throw new TypeError('Invalid parcel cells');
  return parcelArea(cells.map(c => rect(c.x * cellSize, c.y * cellSize, cellSize, cellSize)));
}

/** Clip a polygon against one half-plane. */
function half(p: readonly Vec2[], a: Vec2, b: Vec2, inside: boolean): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < p.length; i++) {
    const s = p[i]!, e = p[(i + 1) % p.length]!, ds = cross(a,b,s), de = cross(a,b,e);
    const si = inside ? ds >= 0 : ds <= 0, ei = inside ? de >= 0 : de <= 0;
    if (si) out.push(s);
    if (si !== ei) { const t = ds / (ds - de); out.push({ x: s.x + t * (e.x - s.x), y: s.y + t * (e.y - s.y) }); }
  }
  return out;
}

/** Subtract a convex CCW clip from a convex polygon, keeping its outside fragments. */
function subtract(p: Vec2[], clip: Vec2[]): Vec2[][] {
  const result: Vec2[][] = []; let rest = p;
  for (let i = 0; i < clip.length && rest.length >= 3; i++) {
    const a = clip[i]!, b = clip[(i + 1) % clip.length]!;
    const outside = half(rest, a, b, false);
    if (outside.length >= 3 && Math.abs(signed(outside)) > 0) result.push(outside);
    rest = half(rest, a, b, true);
  }
  return result;
}

/** Physical footprint containment in a union of convex pieces. Circles use a conservative circumscribed polygon. */
export function areaContains(area: readonly Shape[], shapes: readonly Shape[]): boolean {
  if (!Array.isArray(area) || !Array.isArray(shapes) || area.some(s => !validShape(s) || s.kind === 'circle') || shapes.some(s => !validShape(s))) throw new TypeError('Invalid containment geometry');
  const clips = area.map(s => { const p = outline(s); return signed(p) < 0 ? p.reverse() : p; });
  for (const s of shapes) {
    let p: Vec2[];
    if (s.kind === 'circle') {
      const n = 32, r = s.r / Math.cos(Math.PI / n) * (1 + 1e-12);
      p = Array.from({length:n}, (_, i) => ({x:s.x + r * Math.cos((2*i+1)*Math.PI/n), y:s.y + r * Math.sin((2*i+1)*Math.PI/n)}));
    } else p = outline(s);
    if (signed(p) < 0) p.reverse();
    let remaining = [p];
    for (const clip of clips) { remaining = remaining.flatMap(piece => subtract(piece, clip)); if (!remaining.length) break; }
    if (remaining.length) return false;
  }
  return true;
}
