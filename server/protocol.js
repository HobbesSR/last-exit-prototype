// Transport limits and envelope decoding. Stateful input queueing stays in simulation.
import { isArenaSeed } from '../shared/simulation/rules.ts';
export const MAX_MESSAGE_BYTES = 2048;
export const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_MESSAGES_PER_SECOND = 70;
export function parseMessage(raw) {
  const data = JSON.parse(raw); // Caller closes malformed JSON with the established policy code.
  return data && typeof data === 'object' ? data : null;
}
export function acceptMessageRate(window, now) {
  if (now - window.start > 1000) { window.start = now; window.messages = 0; }
  return ++window.messages <= MAX_MESSAGES_PER_SECOND;
}
export function roomSeed(body) {
  const seed = Number(body?.seed ?? 4217);
  return isArenaSeed(seed) ? seed : null;
}

// Client-reported diagnostics end up in a recording others download, so every field is checked
// and clamped here. A report names the tick the client was rendering, which lags the server by
// the receive buffer and round trip, so it is held within a bound of the tick it arrived at.
export const DIAGNOSTIC_KINDS = ['frame-drop', 'packet-gap', 'manual'];
export const MAX_DIAGNOSTIC_LAG_TICKS = 150;
export const MAX_DIAGNOSTICS_PER_SESSION = 64;
export const MIN_DIAGNOSTIC_INTERVAL_MS = 250;
const wholeNumber = (value, max) => Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : undefined;
export function normalizeDiagnostic(data, arrivalTick, playerId) {
  if (!DIAGNOSTIC_KINDS.includes(data?.kind) || !Number.isInteger(arrivalTick)) return null;
  const clampTick = value => Math.min(arrivalTick, Math.max(arrivalTick - MAX_DIAGNOSTIC_LAG_TICKS, 0, Math.round(value)));
  const reported = wholeNumber(data.tick, Number.MAX_SAFE_INTEGER);
  if (reported === undefined) return null;
  const mark = { tick: clampTick(reported), kind: data.kind, playerId, reportedTick: reported, arrivalTick };
  const start = wholeNumber(data.startTick, Number.MAX_SAFE_INTEGER);
  if (start !== undefined) mark.startTick = clampTick(Math.min(start, reported));
  const count = wholeNumber(data.count, 100000), worstMs = wholeNumber(data.worstMs, 600000);
  if (count !== undefined) mark.count = count;
  if (worstMs !== undefined) mark.worstMs = worstMs;
  return mark;
}
