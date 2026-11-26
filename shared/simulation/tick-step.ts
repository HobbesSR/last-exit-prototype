import type { TickBoundary } from './tick-boundary.ts';
import type { DecodedTick, Inbound } from './tick-codec.ts';
import type { TickFrames } from './tick-frame.ts';
import type { TickMatch } from './tick-match.ts';
import type { Game } from '../types.ts';

// One tick's sequence on the Node side (docs/27.2 "Node adapter (3d.2)"), shared by the room, room replay and in-process
// games: submit the rows due, step the core, keep the game's clock and phase, and acknowledge. The frame
// store follows the match itself (`TickMatch.follow`), so it is not a step here.

/** What one tick publishes to: a session (`createTickSession`). */
export interface TickParts {
  s: Game;
  match: TickMatch;
  /** The receive boundary: what is due and acknowledgment. */
  boundary: TickBoundary;
  /** The frame store, whose phase is the game's. */
  frames: TickFrames;
}

/**
 * Step one tick: submit `rows` for the game's next tick (by default what the boundary has due; a room's replay passes the
 * recorded rows), step the core, then apply the completed tick. Returns null once the match is over.
 */
export function stepTick(parts: TickParts, rows?: readonly Inbound[]): DecodedTick | null {
  const { s, match, boundary, frames } = parts;
  if (s.phase !== 'live') return null;
  const tick = s.tick + 1, due = rows ?? boundary.due(tick);
  if (due.length && !match.submit(tick, due).every(Boolean)) throw new Error(`tick-step: the match refused a command for ${tick}`);
  const completed = match.step();
  if (!completed) return null;
  s.tick = completed.tick;
  if (frames.phase === 'finished') s.phase = 'finished';
  boundary.acknowledge();
  return completed;
}
