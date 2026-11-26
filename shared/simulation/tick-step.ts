import { acknowledge } from './tick-boundary.ts';
import type { TickBoundary } from './tick-boundary.ts';
import type { DecodedTick, Inbound } from './tick-codec.ts';
import type { TickFrames } from './tick-frame.ts';
import type { TickKnowledge } from './tick-knowledge.ts';
import type { TickMatch } from './tick-match.ts';
import type { TickMirror } from './tick-mirror.ts';
import type { Game } from '../types.ts';

// One tick's sequence on the Node side (docs/27.2 "Node adapter (3d.2)"), shared by the room, room replay, in-process games
// and the mirror's own tests: submit the rows due, step the core, then publish the completed tick to what follows the game,
// and acknowledge. The frame store follows the match itself (`TickMatch.follow`), so it is not a step here.

/** What one tick publishes to. A session is one (`createTickSession`); the mirror's tests pass the mirror alone. */
export interface TickParts {
  s: Game;
  match: TickMatch;
  /** The record applier, which keeps the game's clock and phase when present (a room until #1346). */
  mirror: TickMirror | null;
  knowledge: TickKnowledge;
  /** The receive boundary: what is due and acknowledgment. Without one, nothing is due and the mirror's status decides. */
  boundary?: TickBoundary | undefined;
  /** Without a mirror, the frame store's phase is the game's. */
  frames?: TickFrames | undefined;
}

/**
 * Step one tick: submit `rows` for the game's next tick (by default what the boundary has due; a room's replay passes the
 * recorded rows), step the core, then apply the completed tick. Returns null once the match is over.
 */
export function stepTick(parts: TickParts, rows?: readonly Inbound[]): DecodedTick | null {
  const { s, match, mirror, knowledge, boundary, frames } = parts;
  if (s.phase !== 'live') return null;
  const tick = s.tick + 1, due = rows ?? boundary?.due(tick) ?? [];
  if (due.length && !match.submit(tick, due).every(Boolean)) throw new Error(`tick-step: the match refused a command for ${tick}`);
  const completed = match.step();
  if (!completed) return null;
  if (mirror) mirror.apply(completed);
  else {
    s.tick = completed.tick;
    if (frames?.phase === 'finished') s.phase = 'finished';
  }
  knowledge.apply(completed);
  if (boundary) boundary.acknowledge(); else acknowledge(s, match);
  return completed;
}

/** Step a mirror without a session, as the mirror's own checks do: its game, match and knowledge, and `boundary` if given. */
export function stepMirror(mirror: TickMirror, boundary?: TickBoundary): DecodedTick | null {
  return stepTick({ s: mirror.s, match: mirror.match, mirror, knowledge: mirror.knowledge, boundary });
}
