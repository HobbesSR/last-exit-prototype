// Small bounded, always-on timing sample. No player lists, credentials or room URLs are captured.
const frames = [], packets = [], hitches = [];
let previousPacket = 0, previousFrame = 0, startedAt = performance.now();
const retain = (list, value, limit = 300) => { list.push(value); if (list.length > limit) list.shift(); };
// The recent window covers seconds; a freeze a few minutes back has scrolled out of it by the time
// the report is downloaded. Long frames are therefore also kept for the whole session.
const HITCH_MS = 250;
// Episodes, not samples: a bad stretch is one report however many frames it spans, so a stall cannot
// flood the room. An episode closes after a run of ordinary frames or packets, or when it gets old.
const FRAME_DROP_MS = 50, PACKET_GAP_MS = 150, QUIET_SAMPLES = 30, MAX_EPISODE_MS = 5000;
let tickSource = () => null, sink = null;
export function reportDiagnostics(tick, report) { tickSource = tick; sink = report; }
const episode = (kind, limit) => {
  let open = null, quiet = 0;
  const close = () => { if (open && sink) sink({ kind, tick: open.endTick, startTick: open.startTick, count: open.count, worstMs: Math.round(open.worstMs) }); open = null; quiet = 0; };
  return {
    note(ms) {
      const tick = tickSource(), now = performance.now();
      if (ms <= limit) { if (open && ++quiet >= QUIET_SAMPLES) close(); return; }
      if (open && now - open.at > MAX_EPISODE_MS) close();
      if (tick === null) return;
      quiet = 0;
      if (!open) open = { startTick: tick, endTick: tick, count: 0, worstMs: 0, at: now };
      open.endTick = tick; open.count++; open.worstMs = Math.max(open.worstMs, ms);
    },
    close, reset() { open = null; quiet = 0; }
  };
};
const frameEpisode = episode('frame-drop', FRAME_DROP_MS), packetEpisode = episode('packet-gap', PACKET_GAP_MS);
// A manual mark is the tester's own flag on the tick they were looking at.
export function manualMark() { const tick = tickSource(); if (tick === null || !sink) return false; sink({ kind: 'manual', tick }); return true; }
export function noteFrame() {
  if (document.hidden) { previousFrame = 0; frameEpisode.close(); return null; }
  const now = performance.now(), delta = previousFrame ? now - previousFrame : null;
  previousFrame = now;
  if (delta !== null) { retain(frames, delta); frameEpisode.note(delta); }
  if (delta !== null && delta > HITCH_MS) retain(hitches, { atSeconds: Math.round((now - startedAt) / 100) / 10, ms: Math.round(delta), wallClock: new Date().toISOString() }, 100);
  return delta;
}
export function notePacket(bytes) {
  if (document.hidden) { previousPacket = 0; packetEpisode.close(); return; }
  const now = performance.now();
  if (previousPacket) { retain(packets, { gap: now - previousPacket, bytes }); packetEpisode.note(now - previousPacket); }
  previousPacket = now;
}
// Animation frames stop while a tab is hidden, so noteFrame never sees the hidden interval; the first
// frame back would measure all of it as one drop. Both ends of the visibility change therefore end
// the episodes and forget the previous timestamps.
const forgetTiming = () => { previousFrame = 0; previousPacket = 0; frameEpisode.close(); packetEpisode.close(); };
if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', forgetTiming);
export function resetDiagnostics() { frameEpisode.reset(); packetEpisode.reset(); frames.length = 0; packets.length = 0; hitches.length = 0; previousPacket = 0; previousFrame = 0; startedAt = performance.now(); }
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
