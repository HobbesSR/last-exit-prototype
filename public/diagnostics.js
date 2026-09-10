// Small bounded, always-on timing sample. No player lists, credentials or room URLs are captured.
const frames = [], packets = [];
let previousPacket = 0, previousFrame = 0;
const retain = (list, value) => { list.push(value); if (list.length > 300) list.shift(); };
export function noteFrame() {
  if (document.hidden) { previousFrame = 0; return null; }
  const now = performance.now(), delta = previousFrame ? now - previousFrame : null;
  previousFrame = now;
  if (delta !== null) retain(frames, delta);
  return delta;
}
export function notePacket(bytes) {
  if (document.hidden) { previousPacket = 0; return; }
  const now = performance.now();
  if (!document.hidden && previousPacket) retain(packets, { gap: now - previousPacket, bytes });
  previousPacket = now;
}
export function resetDiagnostics() { frames.length = 0; packets.length = 0; previousPacket = 0; previousFrame = 0; }
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { samples: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted.at(-1) };
};
export function diagnosticTimings() {
  return { frameMs: summarize(frames), packetGapMs: summarize(packets.map(p => p.gap)), packetBytes: summarize(packets.map(p => p.bytes)),
    framesOver50ms: frames.filter(v => v > 50).length, packetGapsOver150ms: packets.filter(p => p.gap > 150).length,
    recentFrames: [...frames], recentPackets: packets.map(p => ({ ...p })) };
}
