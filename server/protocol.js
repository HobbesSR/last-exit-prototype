// Transport limits and envelope decoding. Stateful input latching stays in simulation.
export const MAX_MESSAGE_BYTES = 2048;
export const MAX_BUFFERED_BYTES = 512 * 1024;
export const MAX_MESSAGES_PER_SECOND = 70;
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
  return Number.isInteger(seed) && seed >= 1 && seed <= 2147483647 ? seed : null;
}
