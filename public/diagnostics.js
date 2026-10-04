// Small bounded, always-on timing sample. No player lists, credentials or room URLs are captured.
const frames = [], packets = [], hitches = [];
let previousPacket = 0, previousFrame = 0, startedAt = performance.now();
const retain = (list, value, limit = 300) => { list.push(value); if (list.length > limit) list.shift(); };
// The recent window covers seconds; a freeze a few minutes back has scrolled out of it by the time
// the report is downloaded. Long frames are therefore also kept for the whole session.
const HITCH_MS = 250;
export function noteFrame() {
  if (document.hidden) { previousFrame = 0; return null; }
  const now = performance.now(), delta = previousFrame ? now - previousFrame : null;
  previousFrame = now;
  if (delta !== null) retain(frames, delta);
  if (delta !== null && delta > HITCH_MS) retain(hitches, { atSeconds: Math.round((now - startedAt) / 100) / 10, ms: Math.round(delta), wallClock: new Date().toISOString() }, 100);
  return delta;
}
export function notePacket(bytes) {
  if (document.hidden) { previousPacket = 0; return; }
  const now = performance.now();
  if (!document.hidden && previousPacket) retain(packets, { gap: now - previousPacket, bytes });
  previousPacket = now;
}
export function resetDiagnostics() { frames.length = 0; packets.length = 0; hitches.length = 0; previousPacket = 0; previousFrame = 0; startedAt = performance.now(); }
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { samples: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted.at(-1) };
};
export function diagnosticTimings() {
  return { frameMs: summarize(frames), packetGapMs: summarize(packets.map(p => p.gap)), packetBytes: summarize(packets.map(p => p.bytes)),
    framesOver50ms: frames.filter(v => v > 50).length, packetGapsOver150ms: packets.filter(p => p.gap > 150).length,
    recentFrames: [...frames], recentPackets: packets.map(p => ({ ...p })), hitches: hitches.map(h => ({ ...h })) };
}
