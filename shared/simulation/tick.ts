import { start, stop } from '../profiler.ts';
import type { Game } from '../types.ts';
import { TickBoundary } from './tick-boundary.ts';
import { TickFrames } from './tick-frame.ts';
import { createTickMatch } from './tick-match.ts';
import { TickMirror, stepMirror } from './tick-mirror.ts';
import { disposePhysics as disposeSetup } from './physics-runtime.ts';
import { snapshot as setupSnapshot } from './visibility.ts';
import type { WireIds } from './wire-ids.ts';

/** Start the authority after the caller finishes arranging the match's initial state. */
export function createTickSession(game: Game, wire?: WireIds, navigation?: number) {
  const match = createTickMatch(game, navigation);
  try {
    const mirror = new TickMirror(game, match);
    return { match, mirror, boundary: new TickBoundary(game, match, wire), frames: new TickFrames(mirror) };
  } catch (error) { match.dispose(); throw error; }
}

const sessions = new WeakMap<Game, ReturnType<typeof createTickSession>>();

/** In-process games share the room's authority, with lazy start for scenario setup. */
export function startGame(s: Game, navigation?: number) {
  let session = sessions.get(s);
  if (!session) { session = createTickSession(s, undefined, navigation); sessions.set(s, session); }
  return session;
}

export function stepGame(s: Game) {
  if (s.phase !== 'live') return null;
  const { mirror, boundary } = startGame(s);
  start('sim.step');
  try { return stepMirror(mirror, boundary); } finally { stop('sim.step'); }
}

export function snapshot(s: Game) {
  const session = sessions.get(s);
  if (!session) return setupSnapshot(s);
  start('sim.snapshot');
  try { return session.frames.frame(); } finally { stop('sim.snapshot'); }
}

export function disposePhysics(s: Game): void {
  sessions.get(s)?.match.dispose();
  sessions.delete(s);
  disposeSetup(s);
}
