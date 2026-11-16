import { HZ } from './simulation/rules.ts';
import { MAX_INPUT_LEAD_TICKS } from './simulation/input.ts';

/**
 * The client's half of tick-stamped input (#1096, 24): which server tick each input is for, and when
 * to send the next one. The server's half is the buffer in `shared/simulation/input.ts`.
 *
 * Stamps advance one tick per input, so a tick spends at most one and sending order is spending
 * order. The clock keeps inputs arriving a `target` margin of ticks before their tick by changing
 * how often it sends (time dilation), not by skipping stamps: a little faster while recent inputs
 * arrived late or short of the margin, a little slower while all of a full window arrived with more
 * than it, otherwise exactly the tick rate. The server reports each tick's worst arrival margin
 * with the player's own frame (`inputMargin`).
 *
 * The first stamp, and any after the clock has drifted beyond steering, comes from an estimate of
 * the server's tick: the least-delayed recent frame (delay only ever makes a frame look older) plus
 * the round trip the server measured. Running behind the estimate means certain discards, so the
 * clock jumps forward; running further ahead of it than any server would buffer means a different
 * clock, so it steps back, and the server lets the newer input supersede what it buffered.
 *
 * Pure: every call takes the time, so a model (`tests/bench-input-timing.mjs`) runs the same code.
 */

const TICK_MS = 1000 / HZ;
/** Ticks of margin the clock aims for by default (Corey, #1096): 50 ms of delay against 1–2% more discards at 0 (42.48). */
export const DEFAULT_TARGET_MARGIN = 1;
/** Send-period factors while catching up and while easing off (42.48's model). */
const SPEED_UP = 0.9, SLOW_DOWN = 1.05;
/** Margins steered by, and how many of the newest a late one among them speeds the clock. */
const WINDOW = 20, RECENT = 3;
/** Frames the server-tick estimate takes its best from. */
const SYNC_FRAMES = 20;
/**
 * How far ahead of the estimate the clock may run before it steps back: more than the server buffers for
 * anyone, so only a different clock (a new map's ticks) trips it. Being merely too far ahead is the
 * dilation's to correct, because the estimate is optimistic and a jittery link needs the margin.
 */
const AHEAD_TICKS = MAX_INPUT_LEAD_TICKS;
/** A send this late against its schedule (a throttled tab) restarts the schedule from now. */
const LATE_SEND_MS = TICK_MS * 2;

export interface InputClock {
  /** An authoritative frame for `tick` arrived at `now`; `margin` is its own `inputMargin`, if present. */
  observe(tick: number, now: number, margin?: number): void;
  /** The tick for an input sent at `now`, or null before any frame has been seen. */
  stamp(now: number, roundTripMs?: number | null): number | null;
  /** Milliseconds from `now` until the next input is due. */
  delay(now: number): number;
  /** Forget everything: a new connection or a new map's ticks. */
  reset(): void;
  /** The current send period in ms, and the margins steered by, for diagnostics. */
  stats(): { period: number; margins: number[]; next: number | null };
}

export function createInputClock({ target = DEFAULT_TARGET_MARGIN }: { target?: number } = {}): InputClock {
  let next: number | null = null, sendAt: number | null = null, period = TICK_MS;
  let margins: number[] = [], offsets: number[] = [];
  const estimate = (now: number, roundTripMs: number | null | undefined) => {
    if (!offsets.length) return null;
    const ticks = Math.max(...offsets) + now / TICK_MS;
    return Math.ceil(ticks + Math.max(0, roundTripMs ?? 0) / TICK_MS) + target;
  };
  const steer = () => {
    if (!margins.length) return TICK_MS;
    const least = Math.min(...margins);
    if (margins.slice(-RECENT).some(m => m < 0) || least < target) return TICK_MS * SPEED_UP;
    if (margins.length >= WINDOW && least > target) return TICK_MS * SLOW_DOWN;
    return TICK_MS;
  };
  return {
    observe(tick, now, margin) {
      offsets.push(tick - now / TICK_MS);
      if (offsets.length > SYNC_FRAMES) offsets.shift();
      if (margin === undefined || !Number.isFinite(margin)) return;
      margins.push(margin);
      if (margins.length > WINDOW) margins.shift();
    },
    stamp(now, roundTripMs) {
      const expected = estimate(now, roundTripMs);
      if (expected === null) return null;
      // Behind arrival is certain loss; far ahead is needless delay. Either way, start again from the
      // estimate, and steer by margins of the new stamps only.
      if (next === null || next < expected - target || next > expected + AHEAD_TICKS) { next = expected; margins = []; }
      period = steer();
      sendAt = sendAt === null || now - sendAt > LATE_SEND_MS ? now + period : sendAt + period;
      return next++;
    },
    delay(now) { return sendAt === null ? TICK_MS : Math.max(0, sendAt - now); },
    reset() { next = null; sendAt = null; period = TICK_MS; margins = []; offsets = []; },
    stats() { return { period, margins: [...margins], next }; },
  };
}
