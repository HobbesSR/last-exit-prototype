/**
 * Every object and view of the generation chain (51), as types only. Stages 4 to 9 of the
 * build order implement them. Each stage's output has its own type even where shapes
 * match (51 principle 4): a stage mark makes one stage's output unassignable to another's.
 *
 * Objects hold decisions and are what can be saved: the Layout and the region results.
 * Everything else is a view, recomputed from objects and never stored (51 principle 3).
 */
import type { BuiltMap, CoreElementKind, CoreElementSite, Portal, RegionBrief, RegionResult } from "../../../kernel/contract.ts";
import type { Run } from "../../../kernel/run.ts";
import type { ChainLibrary, PassabilityPrescription, SegmentPrescription } from "./library.ts";

export type { BuiltMap, RegionBrief, RegionResult };

declare const stageMark: unique symbol;
/**
 * Optional, so a stage builds its output as a plain literal, and never present at run
 * time. Two outputs with different marks don't assign to each other.
 */
export interface StageMark<Name extends string> {
  readonly [stageMark]?: Name;
}

/** A stage: a pure function from named objects and views to one new one (51 principle 1). */
export type Stage<Inputs extends readonly unknown[], Output> = (...inputs: Inputs) => Output;

/**
 * What placement and briefs read beyond the seed. Body scale isn't here: it comes from
 * `map/kernel/scale.ts`. Tiles are `CHAIN_TILE_SIZE` cells a side.
 */
export interface ChainParams {
  /** Game enforces the set piece classes' quotas; playground may relax them (51 "Playground mode"). */
  mode?: "game" | "playground";
  /** Tiles per zone, west to east. */
  zoneWidth: number;
  /** Tiles per zone, north to south. */
  zoneHeight: number;
  /** Resolves a core element count of `exitCount` (52). */
  exitCount: number;
  /** Resolves a core element count of `contestantCount`: one spawn point per contestant (52, 17 M20). */
  contestantCount: number;
  /** Loot chance in tier 1, and the step added per tier above it. */
  lootChance: number;
  lootTierStep: number;
}

export type Orientation = 0 | 90 | 180 | 270;
/** A slot in the tile grid, in tile units. */
export interface SlotRef { col: number; row: number }
/** A cell of the map's grid, as `y * width + x` in cell units. Briefs translate it to a kernel `Cell`. */
export type CellIndex = number;
/** Inclusive bounds in cell units. */
export interface CellBounds { x0: number; y0: number; x1: number; y1: number }

/**
 * A unit cell edge, in the kernel's run coordinates (`run.ts`): an `h` segment lies on
 * line `y` and covers column `x`; a `v` segment lies on line `x` and covers row `y`.
 */
export type SegmentKey = `${"h" | "v"}:${number},${number}`;

/** A tier zone, from the params alone (`makeZones`), with what briefs pass to strategies. */
export interface Zone {
  id: string;
  tier: number;
  bonus: number;
  lootChance: number;
  cells: CellBounds;
}

// ── 1. Placement → Layout (object) ──────────────────────────────────────────

export interface PlacedSlot extends SlotRef {
  design: string;
  orientation: Orientation;
}

/** One placed copy of a set piece. Instances never share a slot. */
export interface SetPieceInstance {
  id: string;
  setPiece: string;
  setPieceClass: string;
  slots: SlotRef[];
}

/** Placement's draws, and nothing else. The primitive grid is a view (`DeclaredGrid`). */
export interface Layout extends StageMark<"layout"> {
  seed: string;
  params: ChainParams;
  /** Fingerprint of the library the slots name designs from. */
  library: string;
  /** Every occupied slot, row by row. */
  slots: PlacedSlot[];
  setPieces: SetPieceInstance[];
}

// ── View: Layout + library → DeclaredGrid ───────────────────────────────────

/** A declared class: a class the design paints, `any`, or `""` outside the mask (52). */
export type DeclaredClass = string;

/** What the designs on each side state about one segment, kept separate, never merged. */
export interface DeclaredSegment {
  /** The cell above an `h` segment, or left of a `v` one. */
  lower?: SegmentPrescription;
  /** The cell below an `h` segment, or right of a `v` one. */
  upper?: SegmentPrescription;
}

export interface DeclaredGrid extends StageMark<"declared-grid"> {
  /** In cells. */
  width: number;
  height: number;
  /** Per cell index; `""` outside the mask (52). */
  cells: DeclaredClass[];
  /** Only segments a side states something about. */
  segments: Partial<Record<SegmentKey, DeclaredSegment>>;
}

// ── 2. Resolution: Layout + library → ResolvedLayout (view) ─────────────────

/** A declared class with every `any` settled. Never `any`; `""` outside the mask, as declared (52). */
export type ResolvedClass = string;
export type PassabilityGuarantee = "guaranteed" | "none";
/** What one side stated: `null` where no cell of the map is across. */
export type StatedPassability = PassabilityPrescription | "unstated" | null;

export interface ResolvedSegment {
  guarantee: PassabilityGuarantee;
  /** Provenance, lower side then upper (`DeclaredSegment`). */
  stated: readonly [StatedPassability, StatedPassability];
}

export interface ResolvedLayout extends StageMark<"resolved-layout"> {
  width: number;
  height: number;
  cells: ResolvedClass[];
  /**
   * Only segments a side states passability on. An absent segment is `none`, with
   * nothing stated on either side.
   */
  segments: Partial<Record<SegmentKey, ResolvedSegment>>;
}

// ── 3. Regions: ResolvedLayout → LayoutRegions (view) ───────────────────────

/** A maximal 4-connected set of cells with one resolved class. */
export interface LayoutRegion {
  /** A function of the region's own cells. */
  id: string;
  /** A function of the map seed and the region's own cells. */
  seed: number;
  class: ResolvedClass;
  /** Ascending. */
  cells: CellIndex[];
}

/** A maximal straight run of segments between two layout regions, `a` before `b`. */
export interface Boundary {
  a: string;
  b: string;
  run: Run;
}

/** A portal on a boundary: derived from guarantees, never authored, places no geometry. */
export interface LayoutPortal extends Portal {
  a: string;
  b: string;
}

/** Two regions joined by a boundary with a portal. */
export interface RegionEdge {
  a: string;
  b: string;
  /** Portal ids. */
  portals: string[];
}

export interface LayoutRegions extends StageMark<"layout-regions"> {
  regions: LayoutRegion[];
  boundaries: Boundary[];
  portals: LayoutPortal[];
  graph: RegionEdge[];
}

// ── 4. Proof: LayoutRegions → ReachabilityProof (view) ──────────────────────

/** A claim about guarantees, not geometry (51 stage 4). It names no core element regions. */
export interface ReachabilityProof extends StageMark<"reachability-proof"> {
  /** Region ids per component of the region graph. */
  components: string[][];
}

// ── 5. Briefs: Layout, LayoutRegions, zones, cell size → RegionBrief[] (view) 
// `RegionBrief` is the contract's (`map/kernel/contract.ts`). The caller chooses the
// cell size, in world units, since it is the game's scale and not macro's.

// ── 6. Build: RegionBrief → RegionResult (object), in the game ──────────────
// `RegionResult` is the contract's. Macro reads it without the game's geometry.

// ── 7. Composition: Layout, LayoutRegions, results → BuiltMap (view), in the game ─
// `BuiltMap` is the contract's: the game composes it (`composeRegions`), and macro reads
// it without the game's geometry. It refuses two owners for a cell and a disagreeing
// portal pair, so the report can assume both hold.

// ── 8. Measurement: BuiltMap, proof, Layout → Report (view) ─────────────────
// The game diagnoses its builders' portal promises from their geometry
// (`diagnoseBuiltMap` in `map/micro/diagnose.ts`), which macro can't read.

/** One core element of one set piece instance: what its class promises against the sites assigned to it. */
export interface InstanceCoreElementCount {
  instance: string;
  element: CoreElementKind;
  promised: number;
  found: number;
}

/**
 * A defect names an authoring defect or a builder that broke its contract. The report
 * diagnoses; it never rejects a map (51 stage 8).
 */
export interface Defect {
  kind: DefectKind;
  message: string;
  /** The set piece instance a core element count or a site belongs to. */
  instance?: string;
  /** The regions the defect lies in, in the built map's order. */
  regions?: string[];
  site?: CoreElementSite;
}

/**
 * - `missing-core-element`, `extra-core-element`: an instance's sites don't match its
 *   class's promise. An author's defect, such as two instances whose core element regions
 *   merged, unless a builder's own count is wrong too.
 * - `stray-site`: a site in no instance's slots, or in an instance whose class doesn't own it.
 * - `unproven-region`: the proof doesn't connect a built region to the spawn's (17 M2).
 * - `unbuilt-region`: the proof names a region the built map doesn't hold.
 * - `broken-promise`: a builder sited other than its brief asked, or outside its own cells.
 */
export type DefectKind = "missing-core-element" | "extra-core-element" | "stray-site" | "unproven-region" | "unbuilt-region" | "broken-promise";

export interface Report extends StageMark<"report"> {
  coreElements: InstanceCoreElementCount[];
  defects: Defect[];
  metrics: Record<string, number>;
}

// ── The finished map (51 "What the finished map is") ────────────────────────

/**
 * What the game lends macro to build and compose regions, since macro and micro don't
 * import each other (50). `version` names the strategies, so saved results are never
 * rebuilt by different ones without saying so (51 "Saving").
 */
export interface MapEngines<Element = unknown> {
  version: string;
  build(brief: RegionBrief): RegionResult<Element>;
  compose(results: readonly RegionResult<Element>[]): BuiltMap<Element>;
}

/**
 * The generated map: the two objects, the Layout and the region results, plus the library
 * they were made with. Every other stage output is a view behind one accessor (`mapViews`).
 */
export interface ChainMap<Element = unknown> extends StageMark<"chain-map"> {
  layout: Layout;
  library: ChainLibrary;
  /** The briefs' cell size in world units: the game's scale, an input to the results. */
  cellSize: number;
  /** The `MapEngines` version that built the results. */
  build: string;
  /** One per brief, in the briefs' order. */
  results: RegionResult<Element>[];
}

// ── The chain's stages ──────────────────────────────────────────────────────

/** The macro stages' signatures. Stages 6 and 7 are the game's. */
export interface MacroStages {
  placement: Stage<[seed: string, params: ChainParams, library: ChainLibrary], Layout>;
  declaredGrid: Stage<[layout: Layout, library: ChainLibrary], DeclaredGrid>;
  resolution: Stage<[layout: Layout, library: ChainLibrary], ResolvedLayout>;
  regions: Stage<[resolved: ResolvedLayout, seed: string], LayoutRegions>;
  proof: Stage<[regions: LayoutRegions], ReachabilityProof>;
  briefs: Stage<[layout: Layout, regions: LayoutRegions, zones: Zone[], library: ChainLibrary, cellSize: number], RegionBrief[]>;
  measurement: Stage<[built: BuiltMap, proof: ReachabilityProof, layout: Layout, library: ChainLibrary], Report>;
}
