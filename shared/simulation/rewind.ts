import { HZ, INTERPOLATION_DELAY_TICKS } from './rules.ts';
import type { Game, Player, PlayerId, Tick, Vec2 } from '../types.ts';

/**
 * Where each player was, recently, and what a given shooter could actually see when they fired.
 *
 * A player aims at what is on their screen, and what is on their screen is old: two ticks of
 * interpolation delay by design, plus however long the frame took to arrive. Resolving their shot
 * against where the target is *now* charges them for both, and the amount is invisible and varies
 * with their connection. Rewinding the target to where the shooter saw it is what makes aiming mean
 * what it appears to mean.
 *
 * The cost is paid by the person being shot at, who can be hit after stepping behind cover on their
 * own screen. That trade is the standard one and it is deliberate, but it is why the window is
 * bounded: past `MAX_REWIND_TICKS` a connection is too far behind to compensate for without the
 * victim's experience becoming the absurd one, and the shooter simply leads their target instead.
 *
 * Nothing here is client-supplied. `viewLagTicks` is derived by the application from latency the
 * server measured itself (see `server/latency.js`), so a client cannot ask to be given more rewind.
 */

/** Ticks of history kept. Half a second at 20 Hz, which bounds the worst unfairness to the target. */
export const MAX_REWIND_TICKS = 10;

/** One tick's positions, as the broadcast for that tick carried them. */
interface RewindFrame {
  tick: Tick;
  at: Map<PlayerId, Vec2>;
}

/**
 * Record where everyone finished this tick.
 *
 * Called at the end of the tick, because that is the state the snapshot carries and therefore the
 * state a client actually drew. Recording mid-tick would rewind to a position no viewer ever saw.
 */
export function recordRewind(s: Game): void {
  const at = new Map<PlayerId, Vec2>();
  for (const p of s.players) at.set(p.id, { x: p.x, y: p.y });
  s.rewind ??= [];
  s.rewind.push({ tick: s.tick, at });
  while (s.rewind.length > MAX_REWIND_TICKS) s.rewind.shift();
}

/**
 * How far behind this player's view runs, in ticks, given the round trip the server measured.
 *
 * One way of the round trip carries the frame to them, and the receive buffer deliberately holds it
 * a further fixed delay before drawing it. Both are real and both are the server's own figures.
 */
export function viewLagFrom(roundTripMs: number | null | undefined): number {
  if (!roundTripMs || roundTripMs <= 0) return 0;
  const ticks = Math.round((roundTripMs / 2) / (1000 / HZ)) + INTERPOLATION_DELAY_TICKS;
  return Math.max(0, Math.min(MAX_REWIND_TICKS, ticks));
}

/**
 * Positions as `viewer` saw them, for resolving something that viewer just did.
 *
 * A viewer with no measured lag — a bot, a local player, anyone before the first round trip returns
 * — reads current positions, so this costs nothing and changes nothing until latency is known.
 */
export function asSeenBy(s: Game, viewer: Player): (target: Player) => Vec2 {
  const lag = Math.min(viewer.viewLagTicks ?? 0, MAX_REWIND_TICKS);
  if (lag <= 0 || !s.rewind?.length) return target => target;
  // The frames are pushed in tick order and bounded, so the one wanted is a fixed offset from the
  // end; anything older than the window falls back to the oldest kept rather than to the present,
  // because the present is the one answer known to be wrong.
  const frame: RewindFrame = s.rewind[Math.max(0, s.rewind.length - lag)]!;
  return target => frame.at.get(target.id) ?? target;
}
