/** Opt-in diagnostic deltas. All positions are world-cell lattice coordinates, except slots. */
import type { TraceSlot as BaseTraceSlot, WfcTraceEvent as BaseWfcTraceEvent } from "../wfc.ts";
import type { Orientation } from "./types.ts";
export interface TracePoint { x: number; y: number }
export interface TraceFace { a: TracePoint; b: TracePoint }
export type TraceSlot = BaseTraceSlot<Orientation>;
export type WfcTraceEvent = BaseWfcTraceEvent<Orientation>;
export type RefusalTraceEvent = {
  type: "refusal"; kind: "portal" | "sealed" | "pocket"; reason: string;
  cells: TracePoint[]; faces: TraceFace[]; causeSlots: number[];
};
export type PlacementTraceDetail = WfcTraceEvent | RefusalTraceEvent
  | { type: "attempt-start"; slots: Array<{ slot: number; x: number; y: number; col: number; row: number }> }
  | ({ type: "set-piece-slot"; instance: string; setPiece: string; setPieceClass: string } & TraceSlot)
  | { type: "set-piece-failed"; setPiece: string; reason: string }
  | { type: "skeleton"; algorithm: string; extraOpenShare: number; edges: Array<{ slotA: number; slotB: number; dir: "E" | "S"; isTree: boolean }> }
  | { type: "attempt-end"; outcome: "placed" | "wfc" | `set piece ${string}`; nodes: number; mostStall: number };
/** Attempts are zero-based, in stream order. Set-piece assignments precede WFC depth zero. */
export type PlacementTraceEvent = PlacementTraceDetail & { attempt: number };
