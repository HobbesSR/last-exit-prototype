import { start, stop } from '../profiler.ts';
import type { Game, GameEvent } from '../types.ts';
import { TickBoundary } from './tick-boundary.ts';
import { TickFrames } from './tick-frame.ts';
import type { FrameRecords } from './tick-frame.ts';
import { TickKnowledge } from './tick-knowledge.ts';
import { createTickMatch } from './tick-match.ts';
import { stepTick } from './tick-step.ts';
import { contextOf } from './tick-records.ts';
import { disposePhysics as disposeSetup } from './physics-runtime.ts';
import { snapshot as setupSnapshot } from './visibility.ts';
import type { WireIds } from './wire-ids.ts';

/**
 * Start the authority after the caller finishes arranging the match's initial state. No session runs the mirror: a room
 * reads its roster from the frame store (#1346) and an in-process game is read through `stateOf` (#1345). Every player's
 * knowledge is written for `playerView` until #1343.
 */
export function createTickSession(game: Game, wire?: WireIds, navigation?: number) {
  const match = createTickMatch(game, navigation);
  try {
    const knowledge = new TickKnowledge(game, match, contextOf(game, match));
    const frames = new TickFrames(game, match);
    framesByGame.set(game, frames);
    return { match, mirror: null, knowledge, boundary: new TickBoundary(game, match, wire), frames };
  } catch (error) { match.dispose(); throw error; }
}

const framesByGame = new WeakMap<Game, TickFrames>();
/** The frame store of a started game's session, a room's included: for tests arranging a scenario, never the server. */
export function framesOf(s: Game): TickFrames | undefined { return framesByGame.get(s); }

/** A started game's state as of its last completed tick: the frame store's records, its phase and that tick's events. */
export interface TickState extends FrameRecords {
  phase: Game['phase'];
  events: GameEvent[];
}

/**
 * The state of a started game, read from the core's output (docs/27.2 "Test API"): for tests and tools, never the
 * server. A record is a copy, so arranging a scenario mid-match goes through commands, not through what this returns.
 */
export function stateOf(s: Game): TickState {
  const frames = framesByGame.get(s);
  if (!frames) throw new Error('stateOf: the game has not started; arrange it on the game itself');
  const records = frames.records();
  // Ground records are the store's own until a frame publishes them; the rest are built for this read.
  return { ...records, items: records.items.map(item => ({ ...item })), phase: frames.phase, events: frames.events() };
}

const sessions = new WeakMap<Game, ReturnType<typeof createTickSession>>();

/** In-process games share the room's authority, with lazy start for scenario setup. */
export function startGame(s: Game, navigation?: number) {
  let session = sessions.get(s);
  if (!session) { session = createTickSession(s, undefined, navigation); sessions.set(s, session); }
  return session;
}

/**
 * Step an in-process game (`stepTick`): without the mirror, the game keeps only its clock, its phase and the players'
 * knowledge. Nothing else of the game follows the match; read it with `stateOf`.
 */
export function stepGame(s: Game) {
  if (s.phase !== 'live') return null;
  const session = startGame(s);
  start('sim.step');
  try { return stepTick({ s, ...session }); } finally { stop('sim.step'); }
}

export function snapshot(s: Game) {
  const session = sessions.get(s);
  if (!session) return setupSnapshot(s);
  start('sim.snapshot');
  try { return session.frames.privateFrame(); } finally { stop('sim.snapshot'); }
}

export function disposePhysics(s: Game): void {
  sessions.get(s)?.match.dispose();
  sessions.delete(s);
  disposeSetup(s);
}
