import type { ConstraintSpec, Point } from './types.ts';

const LIMIT = 1e9;
function bounded(value: number | undefined, fallback?: number): number {
  const result = value ?? fallback;
  if (result === undefined || !Number.isFinite(result) || Math.abs(result) > LIMIT)
    throw new TypeError('physics constraint value must be finite and within representable bounds');
  return result;
}
function nonnegative(value: number | undefined, fallback?: number): number {
  const result = bounded(value, fallback);
  if (result < 0) throw new RangeError('physics constraint value must be nonnegative');
  return result;
}
function anchor(value: Point | undefined): Point {
  return { x: bounded(value?.x, 0), y: bounded(value?.y, 0) };
}

/** Explicit game-owned constraints have a finite force budget; omitted kind retains native rope semantics. */
export function validateConstraint(input: ConstraintSpec): ConstraintSpec {
  const id = input.id, a = input.a, b = input.b;
  if (typeof id !== 'string' || !id || typeof a !== 'string' || !a || typeof b !== 'string' || !b)
    throw new TypeError('physics ID must be a nonempty string');
  if (a === b) throw new RangeError('constraint endpoints must differ');
  if (input.kind === undefined) {
    if ([input.maxForce, input.stiffness, input.damping, input.restLength, input.breakDistance,
      input.anchorA, input.anchorB].some(value => value !== undefined))
      throw new TypeError('bounded constraint fields require an explicit kind');
    const maxDistance = bounded(input.maxDistance);
    if (maxDistance <= 0) throw new RangeError('physics constraint maxDistance must be positive');
    return { id, a, b, maxDistance };
  }
  if (input.kind !== 'spring' && input.kind !== 'rope') throw new TypeError('invalid physics constraint kind');
  const maxDistance = nonnegative(input.maxDistance);
  const length = nonnegative(input.kind === 'spring' ? input.restLength ?? maxDistance : maxDistance);
  const maxForce = bounded(input.maxForce);
  if (maxForce <= 0) throw new RangeError('explicit physics constraint requires positive finite maxForce');
  const result: ConstraintSpec = { id, a, b, kind: input.kind, maxDistance,
    anchorA: anchor(input.anchorA), anchorB: anchor(input.anchorB),
    ...(input.kind === 'spring' ? { restLength: length } : {}),
    stiffness: nonnegative(input.stiffness, 2000), damping: nonnegative(input.damping, 60), maxForce };
  if (input.breakDistance !== undefined) result.breakDistance = nonnegative(input.breakDistance);
  return result;
}
