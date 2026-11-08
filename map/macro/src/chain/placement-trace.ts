/** Opt-in diagnostic deltas. All positions are world-cell lattice coordinates, except slots. */
import type { Orientation } from "./types.ts";
export interface TracePoint { x: number; y: number }
export interface TraceFace { a: TracePoint; b: TracePoint }
export interface TraceSlot { slot: number; design: string; orientation: Orientation }
export type WfcTraceEvent =
  | { type: "node"; depth: number; iterations: number; stall: number }
  | { type: "collapse"; depth: number; slots: TraceSlot[] }
  | { type: "undo"; slots: number[] }
  | { type: "contradiction"; depth: number; slots: number[] }
  | { type: "conflict"; depth: number; depths: number[]; backjump: number; stall: number }
  | { type: "backtrack"; fromDepth: number; toDepth: number }
  | { type: "give-up"; reason: "iterations" | "stall"; depth: number; iterations: number; stall: number };
export type RefusalTraceEvent = {
  type: "refusal"; kind: "portal" | "sealed" | "pocket"; reason: string;
  cells: TracePoint[]; faces: TraceFace[]; causeSlots: number[];
};
export type PlacementTraceDetail = WfcTraceEvent | RefusalTraceEvent
  | { type: "attempt-start"; slots: Array<{ slot: number; x: number; y: number; col: number; row: number }> }
  | ({ type: "set-piece-slot"; instance: string; setPiece: string; setPieceClass: string } & TraceSlot)
  | { type: "set-piece-failed"; setPiece: string; reason: string }
  | { type: "attempt-end"; outcome: "placed" | "wfc" | `set piece ${string}`; nodes: number; mostStall: number };
/** Attempts are zero-based, in stream order. Set-piece assignments precede WFC depth zero. */
export type PlacementTraceEvent = PlacementTraceDetail & { attempt: number };
