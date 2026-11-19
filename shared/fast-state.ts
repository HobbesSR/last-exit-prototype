// The fast part of a player view (24.2 "Recommendation", 24.5 stage 3). A view splits by how it changes: the
// slow layers (items, gates and the viewer's own discovery) stay on the reliable stream as keyframe layers
// (frame-layers.ts, discovery.ts), and everything else is fast state, sent on datagrams as changes against a
// frame the client has acknowledged. This module owns where that line falls; the wire schema's `fast`
// message types what is left (wire-schema.ts).

/** The view's fields that stay on the reliable stream. Own discovery (`self.discovered`) stays there too. */
export const SLOW_FIELDS = ['items', 'gates'] as const;

/**
 * The fast part of a projected player view: the view without its slow layers. A new object; the records in it
 * are the projection's own, so a frame kept as a baseline shares them with the view. It takes the view as the
 * projection gives it, before the transport adds `rosterRevision`, which the `fast` message carries beside it.
 */
export function fastFrame<T extends Record<string, unknown>>(view: T): Record<string, unknown> {
  const fast: Record<string, unknown> = { ...view };
  for (const field of SLOW_FIELDS) delete fast[field];
  const self = fast.self as Record<string, unknown> | undefined;
  if (self?.discovered !== undefined) {
    const { discovered: _discovered, ...rest } = self;
    fast.self = rest;
  }
  return fast;
}

/** How many ticks of sent fast frames a view keeps as baselines, 1.6 s (24.2 "Acknowledgement and baselines"). */
export const FAST_HISTORY_TICKS = 32;
/**
 * The edge's fragments (24.5 "Delivery"; `rust/edge/src/frame.rs`, `datagram`): each datagram to a client is a
 * header (`u16` message number, `u8` index, `u8` count) and at most `DATAGRAM_PAYLOAD_BYTES` of one message. The
 * 1,104 bytes fit the smallest WebTransport datagram QUIC allows at its minimum path MTU, so the limit holds on
 * any path. `tests/edge-contract.test.js` holds these to the edge's.
 */
export const DATAGRAM_HEADER_BYTES = 4;
export const DATAGRAM_PAYLOAD_BYTES = 1100;
/** A fast message larger than this many fragments goes on the reliable stream instead (24.2 "Byte budget and overflow"). */
export const MAX_FAST_FRAGMENTS = 4;
export const MAX_FAST_DATAGRAM_BYTES = DATAGRAM_PAYLOAD_BYTES * MAX_FAST_FRAGMENTS;

type FastFrame = Record<string, unknown>;

/**
 * One view's sent fast frames, by tick, as baselines for its deltas (24.5 "Stage 3's contracts"). It keeps the
 * last `ticks` ticks behind the newest recorded. A tick recorded twice (a paused room re-sending its tick after
 * a dev teleport) is never a baseline: the reader may hold either frame, so an acknowledgement of it is ambiguous.
 * The client's copy of the frames it holds can use the same, since the codec rebuilds the frames exactly.
 */
export function createFastHistory(ticks = FAST_HISTORY_TICKS) {
  const frames = new Map<number, FastFrame | null>();
  return {
    record(tick: number, frame: FastFrame) {
      frames.set(tick, frames.has(tick) ? null : frame);
      for (const held of frames.keys()) if (held <= tick - ticks) frames.delete(held);
    },
    /** The frame recorded at `tick`, while it is a usable baseline. */
    get(tick: number): FastFrame | undefined { return frames.get(tick) ?? undefined; },
    get size() { return frames.size; },
  };
}

type Body = { id: unknown; owner?: { kind?: string; itemId?: unknown } };
type Tether = { a: unknown; b: unknown };

/**
 * The item-body hold (24.2 "Message and coverage"): a fast frame as it may be drawn while the reliable stream's
 * items lag it. A body whose item the reader does not yet hold is left out, with any tether to it, as the
 * projection leaves out a body whose item the view is not shown. The body is authorized, so holding it discloses
 * nothing; it is drawn once its item arrives. Returns the frame itself when nothing is held back, so a reader keeps
 * the frame it rebuilt as its baseline and draws what this returns.
 */
export function holdItemBodies(frame: FastFrame, holdsItem: (itemId: unknown) => boolean): FastFrame {
  const bodies = frame.bodies as Body[] | undefined;
  if (!bodies?.some(body => body.owner?.kind === 'item' && !holdsItem(body.owner.itemId))) return frame;
  const kept = bodies.filter(body => body.owner?.kind !== 'item' || holdsItem(body.owner.itemId));
  const ids = new Set(kept.map(body => body.id));
  const held: FastFrame = { ...frame, bodies: kept };
  if (Array.isArray(frame.tethers)) held.tethers = (frame.tethers as Tether[]).filter(t => ids.has(t.a) && ids.has(t.b));
  return held;
}

type Keyed = { id: unknown };

/**
 * A reader's side of the split (24.5 "Delivery"): what a client holds of the fast frames and slow layers its
 * session is sent, and the frame to draw from them.
 * - `baseline(tick)` is the decoder's `baseline` option: the frames it holds, as rebuilt.
 * - `fast(message)` takes a decoded `fast` message. A frame older than the newest held is ignored, and null is
 *   returned. Otherwise the frame becomes the newest, and is kept, as rebuilt, as a baseline. A frame of the
 *   newest tick again (a paused room's re-send after a dev teleport) is drawn, but that tick is then no
 *   baseline, as on the server. It returns the frame to draw, or null until a `slow` message has arrived.
 * - `slow(items, gates, slowVersion)` takes a `slow` message's layers once the layer decoder has rebuilt them. It
 *   returns the newest frame to draw again when that frame was waiting for these layers: never drawn, or drawn
 *   with older layers than the version it names (these being that version or a later one, since a skipped `slow`
 *   is re-sent at the current version). A slow message can trail the last frame on the stream, and no
 *   frame may follow it (a pause, or a finished match). Otherwise null.
 * - `current()` is the newest frame as it would be drawn now, or null: for a reader that could not draw it when
 *   it arrived (its roster, or the match's map, still on the stream).
 * - `newest()` is the tick to acknowledge, or null before any frame.
 *
 * The frame to draw is the fast part with the item-body hold applied, the slow layers held, and the message's
 * roster revision.
 */
export function createFastReader(ticks = FAST_HISTORY_TICKS) {
  type Message = { rosterRevision: number; slowVersion: number; state: FastFrame };
  const history = createFastHistory(ticks);
  let newest: number | null = null, message: Message | null = null, complete = false;
  let items: Keyed[] | null = null, gates: unknown[] = [], held = new Set<unknown>(), version: number | null = null;
  const current = (): FastFrame | null => message && items
    ? { ...holdItemBodies(message.state, id => held.has(id)), items, gates, rosterRevision: message.rosterRevision } : null;
  return {
    baseline: (tick: number) => history.get(tick),
    fast(next: Message): FastFrame | null {
      const tick = next.state.tick as number;
      if (newest !== null && tick < newest) return null;
      history.record(tick, next.state);
      newest = tick; message = next; complete = version !== null && version >= next.slowVersion;
      return current();
    },
    slow(nextItems: Keyed[], nextGates: unknown[], slowVersion: number): FastFrame | null {
      // Versions only rise, and a `slow` skipped under backlog is re-sent at the current one: layers at or past the
      // version a frame names are the ones it was projected with, or newer.
      const waiting = message !== null && (items === null || (!complete && slowVersion >= message.slowVersion));
      items = nextItems; gates = nextGates; held = new Set(nextItems.map(item => item.id)); version = slowVersion;
      if (!waiting) return null;
      complete = slowVersion >= message!.slowVersion;
      return current();
    },
    current,
    newest: () => newest,
  };
}
