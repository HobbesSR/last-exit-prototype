// The fast part of a player view (24.2 "Recommendation", 24.5 stage 3). A view splits by how it changes: the
// slow layers (items, gates and the viewer's own discovery) stay on the reliable stream as keyframe layers
// (frame-layers.ts, discovery.ts), and everything else is fast state, sent on datagrams as changes against a
// frame the client has acknowledged. This module owns where that line falls; the wire schema's `fast`
// message types what is left (wire-schema.ts).
import { KEPT_EVENTS } from './simulation/rules.ts';

/** The view's fields that stay on the reliable stream. Own discovery (`self.discovered`) stays there too. */
export const SLOW_FIELDS = ['items', 'gates'] as const;

/** 24.1's candidate quanta: world units, radians, and world units per tick (a projectile's dx and dy). */
export const POSITION_QUANTUM = 1 / 256;
export const ANGLE_QUANTUM = 2 * Math.PI / 65536;
export const DISPLACEMENT_QUANTUM = 1 / 256;

/**
 * The fast part's rounded fields, by list and field (24.2 decision 3): only those client prediction does not
 * collide with. The viewer's own record and every body stay exact. Bodies with an item were on decision 3's list,
 * but body poses travel as exact float32 metres (24.3), and a type rounding some bodies but not others would cost
 * every exact body a byte a field, more than item bodies would save (24.5 "Delivery", Quantization). The wire
 * schema types these fields from this table (wire-schema.ts), so the two cannot drift.
 */
export const FAST_QUANTA: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  players: { x: POSITION_QUANTUM, y: POSITION_QUANTUM, heading: ANGLE_QUANTUM },
  traps: { x: POSITION_QUANTUM, y: POSITION_QUANTUM, homeX: POSITION_QUANTUM, homeY: POSITION_QUANTUM, heading: ANGLE_QUANTUM },
  projectiles: { x: POSITION_QUANTUM, y: POSITION_QUANTUM, dx: DISPLACEMENT_QUANTUM, dy: DISPLACEMENT_QUANTUM },
  effects: { x: POSITION_QUANTUM, y: POSITION_QUANTUM },
  hookFlights: { x: POSITION_QUANTUM, y: POSITION_QUANTUM },
});

/** `value` rounded to the nearest whole multiple of `quantum`, as the codec's `{ grid }` type carries it; never -0. */
export function quantize(value: number, quantum: number): number {
  return Math.round(value / quantum) * quantum || 0;
}

type Fields = Record<string, unknown>;
function quantizeRecord(record: Fields, quanta: Readonly<Record<string, number>>): Fields {
  const out = { ...record };
  for (const field in quanta) if (typeof out[field] === 'number') out[field] = quantize(out[field], quanta[field]!);
  return out;
}

/**
 * The fast part of a projected player view, as it is transmitted: the view without its slow layers, with
 * `FAST_QUANTA`'s fields rounded. Rounding comes after disclosure and before any comparison, so a value moving
 * within its quantum sends nothing, and a frame kept as a baseline is the rounded one (24.2 "Quantization
 * boundary"). A new object; records with no rounded field are the projection's own, shared with the view, and a
 * rounded record is a copy, so the view keeps its exact values. It takes the view as the projection gives it,
 * before the transport adds `rosterRevision`, which the `fast` message carries beside it.
 */
export function fastFrame<T extends Record<string, unknown>>(view: T): Record<string, unknown> {
  const fast: Record<string, unknown> = { ...view };
  for (const field of SLOW_FIELDS) delete fast[field];
  const self = fast.self as Record<string, unknown> | undefined;
  if (self?.discovered !== undefined) {
    const { discovered: _discovered, ...rest } = self;
    fast.self = rest;
  }
  for (const list in FAST_QUANTA) {
    const records = fast[list];
    if (Array.isArray(records) && records.length) fast[list] = records.map(record => quantizeRecord(record as Fields, FAST_QUANTA[list]!));
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

type Event = { id: unknown; tick: number };

/**
 * The events a view's fast frames carry (24.5 "Events"). A match keeps only its newest `KEPT_EVENTS`
 * (rules.ts), and over datagrams an event would reach a client only if a frame holding it arrived before that
 * many newer ones pushed it out. One view's window keeps each event in its frames for `ticks` ticks after the tick
 * it happened, the history's span, so a client that keeps any frame within the history's span receives it: the
 * events the frame was projected with, after any older ones still in the window, in the order they happened.
 * Returns a function from each sent fast frame to the frame to send, the frame itself when no older event is kept.
 * Ids are the projection's, compared for equality only, since a keyed match maps them (#1164).
 */
export function createEventWindow(ticks = FAST_HISTORY_TICKS) {
  let kept: Event[] = [];
  return (frame: FastFrame): FastFrame => {
    const events = frame.events as Event[] | undefined;
    if (!events) return frame;
    const tick = frame.tick as number, current = new Set(events.map(event => event.id));
    // Anything kept but no longer projected is older than every projected event, so it goes first.
    const older = kept.filter(event => !current.has(event.id) && event.tick > tick - ticks);
    kept = [...older, ...events];
    return older.length ? { ...frame, events: kept } : frame;
  };
}

/**
 * A reader's events (24.5 "Events"): the `KEPT_EVENTS` newest of those it held and those a new frame carries, each
 * once. Since a frame carries every event of the window, and the newest ones beside, one it held that the frame
 * lacks is older than all the frame carries. A reader that kept a frame within each event's window so draws the
 * events a `state` of the same tick would carry, without a repeat or a gap.
 */
export function keptEvents(held: readonly Event[] | undefined, sent: readonly Event[] | undefined): Event[] | undefined {
  if (!sent) return undefined;
  const ids = new Set(sent.map(event => event.id));
  return [...(held ?? []).filter(event => !ids.has(event.id)), ...sent].slice(-KEPT_EVENTS);
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
 * - `arrived()` is the events first held with the frame the last `fast` call took, each once, in the order they
 *   happened: every event whose window a kept frame fell in, including those a burst pushed out of the six drawn.
 *   It is empty after a call that ignored its frame, and set even when nothing could be drawn yet (no `slow`), so a
 *   consumer reads it after every call. It is once per reader: a page that resumes builds a new reader, whose
 *   first frame's window may repeat events the old one gave; a consumer that must span that compares ids.
 *
 * The frame to draw is the fast part with the item-body hold applied, its events as `keptEvents` gives them (the
 * frame's window merged with those already held, so none repeats or goes missing), the slow layers held, and the
 * message's roster revision. The reader de-duplicates events because it alone knows which frames arrived. An event
 * is in a view's window for one unbroken run of ticks (`createEventWindow`), so one the newest frame carries was
 * received before exactly when the frame kept before it carried it too.
 */
export function createFastReader(ticks = FAST_HISTORY_TICKS) {
  type Message = { rosterRevision: number; slowVersion: number; state: FastFrame };
  const history = createFastHistory(ticks);
  let newest: number | null = null, message: Message | null = null, complete = false, events: Event[] | undefined;
  let carried = new Set<unknown>(), arrived: Event[] = [];
  let items: Keyed[] | null = null, gates: unknown[] = [], held = new Set<unknown>(), version: number | null = null;
  const current = (): FastFrame | null => message && items
    ? { ...holdItemBodies(message.state, id => held.has(id)), ...(events ? { events } : {}), items, gates, rosterRevision: message.rosterRevision } : null;
  return {
    baseline: (tick: number) => history.get(tick),
    fast(next: Message): FastFrame | null {
      const tick = next.state.tick as number;
      if (newest !== null && tick < newest) { arrived = []; return null; }
      history.record(tick, next.state);
      newest = tick; message = next; complete = version !== null && version >= next.slowVersion;
      const sent = next.state.events as Event[] | undefined;
      events = keptEvents(events, sent);
      arrived = (sent ?? []).filter(event => !carried.has(event.id));
      carried = new Set((sent ?? []).map(event => event.id));
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
    arrived: (): readonly Event[] => arrived,
  };
}
