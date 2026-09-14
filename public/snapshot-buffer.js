// A bounded buffer of authoritative frames, and the interpolated read presentation takes from it.
//
// Remote motion is drawn at a fixed delay behind the newest frame and interpolated between the two
// frames bracketing that playhead. Frames do not arrive evenly — the loop wakes on a coarser
// granularity than a tick, a catch-up batch collapses several ticks into one payload, and the
// network adds its own jitter — so a renderer that chases the newest position turns every one of
// those into a velocity spike. Paying a fixed, known delay instead buys motion as smooth as the
// path the simulation actually took.
//
// The delay is the whole trade and it is deliberate: two ticks is enough to cover ordinary arrival
// jitter and a single dropped frame, and it is what the viewer's own player does not pay, since
// that one is predicted forward instead. See [25](../docs/25-pacing-and-rendering.md).
//
// The seams here — take a frame in, advance a playhead, read an interpolated frame out — are the
// ones a state-sync framework exposes, so replacing this with one is a substitution rather than a
// redesign.

const DELAY_TICKS = 2;
// Enough history to interpolate across a stall without growing without bound.
const CAPACITY = 32;
// Past this the playhead is not drifting, it is somewhere else entirely: a join, a resumed tab, a
// long stall. Easing across it would crawl for seconds, so it cuts.
const SNAP_TICKS = 10;
// Drift is corrected by dilating time rather than moving the playhead, because moving it is the
// discontinuity this module exists to remove. A tick of drift is taken out over about ten ticks.
const RATE_GAIN = 0.1;
const MIN_RATE = 0.85, MAX_RATE = 1.15;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Shortest arc, so a heading crossing +-pi turns the short way instead of unwinding. */
export function lerpAngle(a, b, t) {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

export function createSnapshotBuffer({ hz, delayTicks = DELAY_TICKS, clock = () => performance.now() } = {}) {
  const tickMs = 1000 / hz;
  let frames = [];
  // The playhead is `anchor` ticks at `anchorAt`, advancing at `rate` ticks per tick of real time.
  let anchor = null, anchorAt = 0, rate = 1;
  let starved = 0, snaps = 0;

  const playhead = (now = clock()) => anchor === null ? null : anchor + (now - anchorAt) / tickMs * rate;

  function reset() {
    frames = []; anchor = null; anchorAt = 0; rate = 1; starved = 0; snaps = 0;
  }

  function push(frame) {
    if (!frame || typeof frame.tick !== 'number') return;
    const now = clock();
    const target = frame.tick - delayTicks;
    const current = playhead(now);
    if (current === null || Math.abs(target - current) > SNAP_TICKS) {
      // The playhead is not drifting, it is elsewhere: a join, a resumed tab, a replay closing back
      // to a live match. What came before is not continuous with what follows, so it is dropped
      // rather than left to be interpolated across.
      if (current !== null) snaps++;
      frames = [frame]; anchor = target; rate = 1; anchorAt = now;
      return;
    }
    // A late or duplicated frame is placed by tick rather than appended, so the buffer stays ordered
    // and a reordered pair cannot make the bracket search read backwards.
    const at = frames.findIndex(f => f.tick >= frame.tick);
    if (at >= 0 && frames[at].tick === frame.tick) frames[at] = frame;
    else if (at >= 0) frames.splice(at, 0, frame);
    else frames.push(frame);
    if (frames.length > CAPACITY) frames = frames.slice(-CAPACITY);
    anchor = current;
    rate = clamp(1 + (target - current) * RATE_GAIN, MIN_RATE, MAX_RATE);
    anchorAt = now;
  }

  /** The two frames the playhead falls between, or the nearest single frame at either end. */
  function bracket(tick) {
    if (!frames.length) return null;
    if (tick <= frames[0].tick) return { a: frames[0], b: frames[0], t: 0 };
    const last = frames[frames.length - 1];
    // Running past the newest frame means the buffer is starved. Hold the last known state rather
    // than extrapolating: inventing motion here is what produces a rubber-band when it arrives.
    if (tick >= last.tick) { starved++; return { a: last, b: last, t: 0 }; }
    let lo = 0, hi = frames.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (frames[mid].tick <= tick) lo = mid; else hi = mid; }
    const a = frames[lo], b = frames[hi];
    return { a, b, t: b.tick === a.tick ? 0 : (tick - a.tick) / (b.tick - a.tick) };
  }

  function interpolatePlayer(a, b, t) {
    if (!b || b === a) return a;
    // Discrete state — health, status, cloak — reads from the later frame so gameplay feedback is
    // not held back by the presentation delay. Only position and facing are interpolated.
    return { ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), heading: lerpAngle(a.heading ?? 0, b.heading ?? 0, t) };
  }

  /**
   * The frame presentation should draw, or null before the first one arrives.
   *
   * Positions are interpolated toward the later frame; everything else is the earlier frame as
   * received, paired with the `alpha` ticks elapsed since it. Anything carrying its own per-tick
   * rate — a projectile's velocity, an effect's remaining life — is advanced by the consumer from
   * that alpha, which stays correct across a gap because the rate is constant over it.
   */
  function frame(now = clock()) {
    const tick = playhead(now);
    if (tick === null) return null;
    const span = bracket(tick);
    if (!span) return null;
    const { a, b, t } = span;
    // Held at either end of the buffer, nothing has elapsed since `a`, so anything the consumer
    // advances from alpha holds with it instead of running on past the last state actually received.
    const alpha = a === b ? 0 : tick - a.tick;
    const later = new Map((b.players || []).map(p => [p.id, p]));
    const players = (a.players || []).map(p => interpolatePlayer(p, later.get(p.id), t));
    // A player the earlier frame did not carry — newly in range, or newly revealed — is shown at the
    // later frame's position rather than withheld for a further two ticks.
    const shown = new Set(players.map(p => p.id));
    for (const p of b.players || []) if (!shown.has(p.id)) players.push(p);
    const laterTraps = new Map((b.traps || []).map(trap => [trap.id, trap]));
    const traps = (a.traps || []).map(trap => {
      const next = laterTraps.get(trap.id);
      if (!next) return trap;
      return { ...next, x: lerp(trap.x, next.x, t), y: lerp(trap.y, next.y, t), heading: lerpAngle(trap.heading ?? 0, next.heading ?? 0, t) };
    });
    return { ...a, players, traps, hazardX: lerp(a.hazardX, b.hazardX ?? a.hazardX, t), alpha };
  }

  const stats = () => ({ depth: frames.length, playhead: playhead(), newest: frames.length ? frames[frames.length - 1].tick : null, rate, starved, snaps, delayTicks });

  return { push, frame, reset, stats };
}
