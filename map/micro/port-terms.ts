/** A side of a cell or of a region's owned cells. */
export type Side = 'N' | 'E' | 'S' | 'W';

/** The side that faces it across a shared edge. */
export const OPPOSITE: Readonly<Record<Side, Side>> = Object.freeze({ N: 'S', S: 'N', E: 'W', W: 'E' });
