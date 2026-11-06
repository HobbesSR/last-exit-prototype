/** Compatibility entry points for the original hint-wall callers (#407). */
import { perimeterWalls, commitPerimeterWalls } from './perimeter-reach.ts';
import type { PerimeterReachOptions, PerimeterWalls } from './perimeter-reach.ts';
import type { RegionBrief } from './types.ts';

export type HintWallOptions = Omit<PerimeterReachOptions, 'runs'>;
export type HintWalls = PerimeterWalls;

/** Preserve hint selection, labels, candidate order and addressed intent for existing builders. */
export function wallHints(brief: RegionBrief, options: HintWallOptions): HintWalls {
  return perimeterWalls(brief, { ...options, runs: brief.hints ?? [], label: options.label ?? 'hint-wall' });
}
export const commitHintWalls = commitPerimeterWalls;
