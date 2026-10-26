import { circle, polygon, transform } from '../shape.ts';
import type { Shape } from '../shape.ts';
import type { BodyShape, Point } from './types.ts';
import { hypot } from '../math.ts';

type Pose = Point & { angle: number; shape: BodyShape };

/** Conservative anchor radius used by potential-visibility projection. */
export function bodyRadius(shape: BodyShape): number {
  if (shape.kind === 'circle') return shape.radius;
  if (shape.kind === 'box') return hypot(shape.hx, shape.hy);
  return Math.max(0, ...shape.vertices.map(vertex => hypot(vertex.x, vertex.y)));
}

/** Adapt stored physics geometry to the shared shape vocabulary; no sight or backend policy. */
export function bodyShape(body: Pose): Shape {
  const { shape, x, y, angle } = body;
  if (shape.kind === 'circle') return circle(x, y, shape.radius);
  const points = shape.kind === 'box'
    ? [{ x: -shape.hx, y: -shape.hy }, { x: shape.hx, y: -shape.hy },
      { x: shape.hx, y: shape.hy }, { x: -shape.hx, y: shape.hy }]
    : shape.vertices;
  return transform(polygon(0, 0, points), x, y, angle);
}
