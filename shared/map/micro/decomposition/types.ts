import type { Cell } from '../types.ts';

export interface CellRect { x: number; y: number; w: number; h: number; area: number }
export interface BoundaryEdge { a: Cell; b: Cell; cell: Cell; kind: 'outer' | 'hole' }
export interface RegionAnalysis {
  cells: Cell[];
  area: number;
  bounds: CellRect;
  components: Cell[][];
  holes: Cell[][];
  boundary: BoundaryEdge[];
  perimeter: number;
  rectangularity: number;
  xMonotone: boolean;
  yMonotone: boolean;
  /** Four-neighbor distance to outside: boundary cells have depth 1. Not Euclidean width. */
  depth: Array<{ cell: Cell; distance: number }>;
  /** Minimum of uninterrupted horizontal/vertical runs through each cell; a grid feature, not body clearance. */
  localWidth: Array<{ cell: Cell; width: number }>;
  articulationCells: Cell[];
  maximalRectangles: CellRect[];
}
export interface NeckCut {
  id: string;
  cells: Cell[];
  orientation: 'horizontal' | 'vertical';
  components: Cell[][];
  resultingAreas: number[];
}

export interface RegionContextInput {
  id: string;
  cells: Cell[];
  cellSize: number;
  reserved?: Cell[];
  forbidden?: Cell[];
  required?: Cell[];
  entrances?: Array<{ id: string; cells: Cell[]; requiredWidth: number }>;
  annotations?: Record<string, string>;
}
export interface RegionContext {
  readonly input: Readonly<RegionContextInput>;
  analyze(cells?: readonly Cell[]): RegionAnalysis;
  child(id: string, cells: readonly Cell[]): RegionContext;
}
export interface CandidatePiece {
  id: string;
  cells: Cell[];
  role: string;
  preferredGenerators?: string[];
  requiredTags?: string[];
  tags?: string[];
  rationale: string;
  cutId?: string;
}
export interface GeneratorContract {
  id: string;
  roles: string[];
  tags: string[];
  minArea: number;
  maxArea: number;
  holes: 'none' | 'one' | 'any';
  rectangular?: boolean;
  /** Optional generator-specific hard rejection reasons. */
  feasible?: (analysis: RegionAnalysis, candidate: CandidatePiece, context: RegionContext) => string[];
  /** Named soft score components. No universal compactness preference. */
  utility: (analysis: RegionAnalysis, candidate: CandidatePiece, context: RegionContext) => Record<string, number>;
}
export interface AssignedPiece extends CandidatePiece { generator: string; scores: Record<string, number> }
export interface ResidualRegion { id: string; cells: Cell[]; role: 'residual' | 'reserved' | 'forbidden' }
export interface InterfaceRun { axis: 'h' | 'v'; x: number; y: number; length: number }
export interface PieceInterface {
  id: string;
  a: string;
  b: string;
  runs: InterfaceRun[];
  length: number;
  longestRun: number;
  fragmentedRuns: number;
  /** Structural opportunity only; never a physical route or negotiated doorway. */
  portalCandidates: InterfaceRun[];
  kind: 'shared-boundary';
}
export interface AllocationPolicy {
  beamWidth: number;
  maxPieces: number;
  maxCandidates: number;
  unusedCellPenalty: number;
  residualComponentPenalty: number;
  smallResidualPenalty: number;
  smallResidualArea: number;
  piecePenalty: number;
  seamRunPenalty: number;
  portalWidth: number;
}
export interface DecompositionPlan {
  version: 'decomposition-1';
  context: RegionContextInput;
  strategy: string;
  policy: AllocationPolicy;
  candidates: CandidatePiece[];
  pieces: AssignedPiece[];
  residuals: ResidualRegion[];
  interfaces: PieceInterface[];
  cuts: NeckCut[];
  score: number;
  scoreComponents: Record<string, number>;
  diagnostics: Array<{ candidate: string; generator?: string; status: 'rejected' | 'selected' | 'not-selected'; reasons: string[]; scores?: Record<string, number> }>;
  search: { considered: number; truncated: number; expanded: number; beamWidth: number; budgetExhausted: boolean; optimal: false };
}
