const validTick = value => Number.isSafeInteger(value) && value >= 0;

// Diagnostic markers are untrusted file content: keep known kinds with a valid tick, sorted.
const MARK_KINDS = new Set(['server-stall', 'frame-drop', 'packet-gap', 'manual']);
const finite = value => Number.isFinite(value) ? value : undefined;
function parseMarks(diagnostics) {
  const source = Array.isArray(diagnostics?.marks) ? diagnostics.marks : [];
  return source.map((mark, order) => ({ mark, order })).filter(({ mark }) => MARK_KINDS.has(mark?.kind) && validTick(mark.tick))
    .sort((a, b) => a.mark.tick - b.mark.tick || a.order - b.order)
    .map(({ mark }) => ({ tick: mark.tick, kind: mark.kind, playerId: mark.playerId, wakeMs: finite(mark.wakeMs), owed: finite(mark.owed), simulated: finite(mark.simulated), count: finite(mark.count), worstMs: finite(mark.worstMs) }));
}

// Where to seek for a mark: a little before it, so the cause is on screen when the viewer arrives.
export const MARK_LEAD_SECONDS = 2;
export function markSeekTick(mark, hz, firstTick = 0) {
  return Math.max(firstTick, mark.tick - Math.round(MARK_LEAD_SECONDS * (Number.isFinite(hz) && hz > 0 ? hz : 0)));
}
const MARK_LABELS = { 'server-stall': 'Server stall', 'frame-drop': 'Frame drops', 'packet-gap': 'Packet gap', manual: 'Manual mark' };
export function markLabel(mark) {
  const detail = mark.kind === 'server-stall' && mark.wakeMs !== undefined ? ` (${Math.round(mark.wakeMs)} ms wake${mark.owed !== undefined ? `, ${mark.owed} ticks owed` : ''})` : '';
  const report = mark.kind === 'frame-drop' || mark.kind === 'packet-gap'
    ? (mark.worstMs !== undefined ? ` (worst ${Math.round(mark.worstMs)} ms${mark.count > 1 ? `, ${mark.count} in a row` : ''})` : '') : '';
  return `${MARK_LABELS[mark.kind]}${detail}${report} at tick ${mark.tick}`;
}

// Marks whose pips would draw on top of each other share one cluster, anchored on its first mark so
// a long run of nearby marks cannot grow one pip without bound. `travel` is the pixel length the
// scrubber thumb moves over and `pip` the widest pip, so the threshold follows the rendered layout;
// a cluster of one is an ordinary mark. Without a usable layout, only equal ticks share a pip.
export function clusterMarks(marks, endTick, travel, pip = 20) {
  const width = travel > 0 && endTick > 0 ? Math.max(1, endTick * pip / travel) : 1, clusters = [];
  for (const mark of marks) {
    const last = clusters.at(-1);
    if (last && mark.tick - last.tick < width) last.marks.push(mark);
    else clusters.push({ tick: mark.tick, marks: [mark] });
  }
  return clusters;
}

// Playback is based on authoritative simulation ticks rather than positions in
// the retained frame array. Omitted states are held, never invented.
export function createReplayTimeline(recording) {
  const source = Array.isArray(recording?.frames) ? recording.frames : [];
  const frames = source.map((frame, order) => ({ frame, order, tick: frame?.state?.tick }))
    .filter(entry => entry.frame?.state && validTick(entry.tick))
    .sort((a, b) => a.tick - b.tick || a.order - b.order);
  const retained = [];
  for (const entry of frames) {
    if (retained.at(-1)?.tick === entry.tick) retained[retained.length - 1] = entry;
    else retained.push(entry);
  }
  // Every player the recording ever held, in the order the frames first named them, so a viewer can
  // pick a subject that has not entered yet or has already been eliminated out of the current frame.
  const roster = [], named = new Set();
  for (const entry of retained) {
    for (const player of entry.frame.state.players || []) {
      if (!player || player.id === undefined || named.has(player.id)) continue;
      named.add(player.id);
      roster.push({ id: player.id, name: player.name, role: player.role, kit: player.kit });
    }
  }
  const firstTick = retained[0]?.tick;
  const lastTick = retained.at(-1)?.tick;
  const declaredEnd = recording?.recording?.endTick;
  const endTick = validTick(declaredEnd) && declaredEnd >= (lastTick ?? 0) ? declaredEnd : lastTick;

  function at(tick) {
    if (!retained.length || !Number.isFinite(tick) || tick < 0) return null;
    // Render time is continuous; only authoritative frame lookup uses whole ticks.
    const playhead = Math.min(tick, endTick ?? tick);
    const lookupTick = Math.floor(playhead);
    let low = 0, high = retained.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (retained[middle].tick <= lookupTick) low = middle + 1;
      else high = middle;
    }
    const entry = retained[Math.max(0, low - 1)];
    const missing = lookupTick !== entry.tick;
    return { state: entry.frame.state, frame: entry.frame, tick: playhead, frameTick: entry.tick, missing,
      alpha: missing ? 0 : playhead - lookupTick };
  }

  return { frames: retained.map(entry => entry.frame), roster, firstTick, lastTick, endTick,
    complete: recording?.recording?.complete !== false,
    marks: parseMarks(recording?.diagnostics),
    droppedMarks: Number.isSafeInteger(recording?.diagnostics?.dropped) && recording.diagnostics.dropped > 0 ? recording.diagnostics.dropped : 0,
    droppedFrames: Number.isSafeInteger(recording?.recording?.droppedFrames) && recording.recording.droppedFrames > 0 ? recording.recording.droppedFrames : 0,
    at };
}
