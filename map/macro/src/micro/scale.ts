/**
 * Body scale, in segments.
 *
 * One segment is one cell edge and one unit of map cell space, so every
 * quantity here is directly comparable with a `Span` width, a wall `gap` and a
 * body radius in `MapParams`. These are design units, not meters.
 *
 * The brief the generator is built to:
 *
 * | Body                | Diameter, in segments |
 * | ------------------- | --------------------- |
 * | contestant          | above 1, below 1.5    |
 * | gladiator / hunter  | above 1.5, below 2    |
 *
 * The two bands share the 1.5 boundary, which is what makes a contestant-only
 * squeeze expressible at all: an opening of exactly 1.5 admits every contestant
 * and no hunter. Everything below is derived from those four numbers, so a
 * change to the brief changes one table rather than a scattering of literals.
 */

/** Widest a contestant may be; narrowest a hunter may be. The shared boundary. */
export const BODY_BAND = Object.freeze({
  contestantMinDiameter: 1,
  contestantMaxDiameter: 1.5,
  hunterMinDiameter: 1.5,
  hunterMaxDiameter: 2,
});

/**
 * The opening widths a builder designs against, named. These are the same three
 * numbers `core.APERTURES` classifies measured seams by; they are stated here in
 * terms of the body band so the derivation is visible rather than assumed.
 *
 * - `squeeze` passes any contestant and no hunter.
 * - `door` passes any body.
 * - `wide` passes two of the largest body abreast: a road, not a doorway.
 */
export const PASSAGE = Object.freeze({
  squeeze: BODY_BAND.contestantMaxDiameter,
  door: BODY_BAND.hunterMaxDiameter,
  wide: BODY_BAND.hunterMaxDiameter * 1.5,
});

/** Clearance a builder must leave beside geometry so a route is not merely legal. */
export const COMFORT_MARGIN = 0.1;

/** True when an opening of `width` passes a body of `diameter`. */
export function admits(width: number, diameter: number): boolean {
  return width >= diameter;
}

/** True when the opening passes every contestant but no hunter. */
export function isSqueeze(width: number): boolean {
  return (
    width >= BODY_BAND.contestantMaxDiameter &&
    width < BODY_BAND.hunterMaxDiameter
  );
}

/** The narrowest opening that passes the named body under the worst case. */
export function clearanceFor(body: "contestant" | "hunter"): number {
  return body === "hunter"
    ? BODY_BAND.hunterMaxDiameter
    : BODY_BAND.contestantMaxDiameter;
}

/**
 * A centered aperture of `width` on a unit segment, as a `Span`. Returns null
 * when the width is not positive, which is a full barrier.
 */
export function centeredSpan(width: number): [number, number] | null {
  if (!(width > 0)) return null;
  if (width >= 1) return [0, 1];
  const half = width / 2;
  return [0.5 - half, 0.5 + half];
}
