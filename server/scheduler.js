import { HZ } from '../shared/simulation/rules.js';
import * as profiler from '../shared/profiler.js';
export const TICK_MS = 1000 / HZ;
export const WAKE_MS = Math.max(1, Math.round(TICK_MS / 8));
export const MAX_CATCHUP = 5;

// Time belongs to the application. A wake may advance several fixed simulation ticks.
export function startScheduler(advance) {
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(), elapsed = now - previous; previous = now;
    profiler.observe('loop.wake', elapsed); advance(elapsed, now);
  }, WAKE_MS);
  return () => clearInterval(timer);
}
