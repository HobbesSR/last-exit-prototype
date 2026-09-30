import type { Box, Vec2 } from '../../shared/types.ts';
import type { ElementTemplate } from '../../shared/map/element.ts';
import type { Cell } from './cell.ts';

/**
 * The macro/micro contract: the brief a region's strategy is handed and the result it
 * returns (docs 51 stage 5). It belongs to neither level (17 M1). These are today's
 * shapes, moved unchanged; C1 turns them into the chain's brief.
 */
export type Passage = 'none' | 'contestant' | 'hunter';
export type BuilderId = 'open' | 'depot' | 'courtyard' | 'ruins' | 'entry';
export type { Cell };
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
export interface RegionResult {
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
