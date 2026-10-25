import type { Box, Vec2 } from '../../shared/types.ts';
import type { Shape } from '../../shared/shape.ts';
import type { ElementTemplate } from '../../shared/map/element.ts';
import type { Cell, RegionResult } from '../kernel/contract.ts';

// The brief and the engine-neutral result are the kernel's; this layer adds the game's geometry.
export type { BuiltMap, Cell, CoreElementKind, CoreElementSite, Hint, HintStated, LootSite, Portal, PortalPair, RegionBrief, RegionTypeId, ZoneContext } from '../kernel/contract.ts';

export interface RegionElement {
  label: string;
  x: number;
  y: number;
  template: ElementTemplate;
}
export interface RegionRoute {
  role: 'contestant' | 'hunter';
  radius: number;
  points: Vec2[];
}
/** A strategy's result in the game's geometry. */
export type BuiltRegion = RegionResult<RegionElement>;

export interface RegionMask {
  cells: readonly Cell[];
  cellSize: number;
  bounds: Box;
  has(x: number, y: number): boolean;
  contains(shape: Shape): boolean;
  /** Contained rectangles in deterministic row-major order, in world units. */
  rectangles(widthCells: number, heightCells: number): Box[];
}
export interface RegionRandom {
  next(): number;
  int(min: number, max: number): number;
  shuffle<T>(items: readonly T[]): T[];
}
