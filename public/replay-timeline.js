const validTick = value => Number.isSafeInteger(value) && value >= 0;

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
  const firstTick = retained[0]?.tick;
  const lastTick = retained.at(-1)?.tick;
  const declaredEnd = recording?.recording?.endTick;
  const endTick = validTick(declaredEnd) && declaredEnd >= (lastTick ?? 0) ? declaredEnd : lastTick;

  function at(tick) {
    if (!retained.length || !validTick(tick)) return null;
    const playhead = Math.min(Math.max(0, Math.floor(tick)), endTick ?? tick);
    let low = 0, high = retained.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (retained[middle].tick <= playhead) low = middle + 1;
      else high = middle;
    }
    const entry = retained[Math.max(0, low - 1)];
    return { state: entry.frame.state, frame: entry.frame, tick: playhead, frameTick: entry.tick, missing: playhead !== entry.tick };
  }

  return { frames: retained.map(entry => entry.frame), firstTick, lastTick, endTick,
    complete: recording?.recording?.complete !== false,
    droppedFrames: Number.isSafeInteger(recording?.recording?.droppedFrames) && recording.recording.droppedFrames > 0 ? recording.recording.droppedFrames : 0,
    at };
}
