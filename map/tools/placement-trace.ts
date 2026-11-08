/** Placement-only diagnostic, shared by the lab and other tool faces (53.1). */
import { bundledLibrary, chainParams, checkedLibrary, seedText } from '../chain.ts';
import { placer } from '../macro/src/chain/placement.ts';
import type { PlacementTraceEvent } from '../macro/src/chain/placement-trace.ts';
import type { ChainParams, Layout } from '../macro/src/chain/types.ts';

export const MAX_PLACEMENT_TRACE_BYTES = 24 * 1024 * 1024;
export interface PlacementRecording {
  seed: string;
  params: ChainParams;
  events: PlacementTraceEvent[];
  truncated: boolean;
  layout: Layout | null;
  error: string | null;
}

/** A failed solve still returns its diagnostic. Collection retains a bounded prefix. */
export function tracePlacement(seed: unknown, params: object = {}, library?: unknown,
  maxBytes = MAX_PLACEMENT_TRACE_BYTES): PlacementRecording {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('trace byte limit must be non-negative');
  const resolved = chainParams(params), checked = checkedLibrary(library ?? bundledLibrary(resolved));
  const recording: PlacementRecording = { seed: seedText(seed), params: resolved, events: [], truncated: false, layout: null, error: null };
  let bytes = 0;
  const encoder = new TextEncoder();
  try {
    recording.layout = placer({ openFace: true, trace: (event) => {
      if (recording.truncated) return;
      bytes += encoder.encode(JSON.stringify(event)).length;
      if (bytes > maxBytes) recording.truncated = true;
      else recording.events.push(event);
    } })(recording.seed, resolved, checked);
  } catch (error) {
    recording.error = error instanceof Error ? error.message : String(error);
  }
  return recording;
}
