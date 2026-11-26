import { HZ, INTERPOLATION_DELAY_TICKS } from './rules.ts';

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

/**
 * Ticks of history kept. Half a second at 20 Hz, which bounds the worst unfairness to the target. Phase 7 records the
 * frames in the core and casters read them there (`rust/core/src/tick/rewind.rs`, `tick/combat.rs`),
 * which keeps its own copy of this bound.
 */
export const MAX_REWIND_TICKS = 10;

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
