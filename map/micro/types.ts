import type { Box, ObstacleKind } from '../../shared/types.ts';
import type { Shape } from '../../shared/shape.ts';
import type { ElementTemplate } from '../../shared/map/element.ts';
import type { Cell, RegionSpec } from '../kernel/contract.ts';

// The contract lives in the shared map space; it is re-exported so the SDK's imports stay put.
export type { BuilderId, Cell, Passage, RegionElement, RegionPort, RegionResult, RegionRoute, RegionSpec, ResolvedPort } from '../kernel/contract.ts';

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
export interface BuilderContext {
  spec: RegionSpec;
  mask: RegionMask;
  /** Independent named streams; adding decoration cannot change structural draws. */
  random(channel: string): RegionRandom;
  /** Atomic placement. Refusal leaves no parts, IDs, roofs or loot behind. */
  element(label: string, template: ElementTemplate, x: number, y: number): boolean;
  obstacle(label: string, shape: Shape, kind: ObstacleKind): boolean;
  /** One spawn per cell, capped by the supplied budget and clear of geometry. */
  loot(x: number, y: number): boolean;
}
export type RegionBuilder = (context: BuilderContext) => void;
