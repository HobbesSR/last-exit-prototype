import type { Vec2 } from '../../../shared/types.ts';
import type { BuildingAllocation, BuildingDesign } from './design.ts';
import type { BuildingRealization } from './realize.ts';

/**
 * What a strategy built one building from: its design, the allocation it realized and the
 * realization's passes. It is transient, handed to an observer while the strategy runs and
 * never stored with the result (17.2.8 M30). The micro lab draws it beside the geometry.
 */
export interface BuildingTrace {
  /** The element the building became, as the result labels it. A building split by `splitBuilding` gives the label its pieces' labels extend. */
  label: string;
  /** World position of the allocation's cell (0, 0), in the result's frame. */
  origin: Vec2;
  cellSize: number;
  design: BuildingDesign;
  allocation: BuildingAllocation;
  realization: BuildingRealization;
  /** Designs the strategy tried before this one and didn't use, each with why. Absent when its first choice was kept. */
  rejected?: { design: string; reason: string }[];
}
/** Called once for each building a strategy keeps in its result. */
export type BuildingObserver = (trace: BuildingTrace) => void;
