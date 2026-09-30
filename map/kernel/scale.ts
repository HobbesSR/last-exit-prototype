/**
 * Body scale and passage widths in cells: the one source both levels read (docs 52,
 * "Units and scale"; 17 M5). A contestant is more than 1 cell and less than 1.5 across,
 * a hunter more than 1.5 and less than 2, and 2 cells is a doorway, so a 1.5-cell
 * squeeze admits a contestant and not a hunter. The live match's world-unit profile is
 * separate and stays in navigation.ts.
 */
export const CELL_SCALE = Object.freeze({
  contestantRadius: 0.625,
  hunterRadius: 0.875,
  doorway: 2,
  squeeze: 1.5,
  /** Room a body keeps from geometry, beyond its radius. */
  clearanceMargin: 0.05,
});

/** The shortest straight stretch of passable segments a hunter can pass through (#73). */
export const MIN_PORTAL_LENGTH = Math.ceil(2 * CELL_SCALE.hunterRadius);
