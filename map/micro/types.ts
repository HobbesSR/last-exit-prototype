import type { Box, ObstacleKind, Vec2 } from '../../shared/types.ts';
import type { Shape } from '../../shared/shape.ts';
import type { ElementTemplate } from '../../shared/map/element.ts';
import type { Cell, RegionResult } from '../kernel/contract.ts';

// The brief and the engine-neutral result are the kernel's; this layer adds the game's geometry.
export type { Cell, CoreElementKind, CoreElementSite, LootSite, Portal, RegionBrief, RegionTypeId, ZoneContext } from '../kernel/contract.ts';

/**
 * The SDK's explicit-port input (`micro-1`), used by the example builders, the tools and
 * decomposition. Unlike a brief's portals, each port here is walled except for a centred gap.
 */
export type Passage = 'none' | 'contestant' | 'hunter';
export type BuilderId = 'open' | 'depot' | 'courtyard' | 'ruins' | 'entry';
/** A run on the perimeter of owned cells, starting at the named inside cell. */
export interface RegionPort {
  id: string;
  side: 'N' | 'E' | 'S' | 'W';
  start: Cell;
  length: number;
  required: Passage;
  allowed: Passage;
}
/** Local coordinates are world units. Cells organize space; they do not constrain shapes. */
export interface RegionSpec {
  id: string;
  seed: number;
  builder: BuilderId;
  cellSize: number;
  /** Cell-relative prototype proportions are independent of the live match balance. */
  bodyProfile?: 'live' | 'cell';
  cells: Cell[];
  ports: RegionPort[];
  /** Macro-owned ground that the builder cannot obstruct or claim for loot. */
  reservations?: Box[];
  parameters?: { density?: number; roomCells?: number; decay?: number };
  loot?: { budget: number; tier: number };
  entry?: { count: number };
}
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
export interface ResolvedPort extends RegionPort {
  centre: Vec2;
  inside: Vec2;
  width: number;
}
export interface MicroResult {
  version: 'micro-1';
  spec: RegionSpec;
  bounds: Box;
  ports: ResolvedPort[];
  routes: RegionRoute[];
  elements: RegionElement[];
  loot: Array<Vec2 & { tier: number }>;
  entry?: { points: Vec2[]; requested: number; shortfall: number; minimumSpacing: number | null };
  manifest: {
    builder: BuilderId;
    cells: number;
    structures: number;
    obstacles: number;
    gates: number;
    loot: number;
    attempted: number;
    rejected: number;
  };
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
