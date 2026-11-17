// How a recording's frames are stored and read back (#901, 26). The writer's worker encodes; the
// browser, tools and tests read. One owner, so the encoder and every reader rebuild identical frames.
//
// A recording from schema 17 is gzip text in lines (NDJSON):
//   line 1          the header, with `frameEncoding: 'delta-1'` and `keyframeEvery`
//   one per frame   a keyframe `{"state":…,"commands":…}`, byte for byte the frame's full JSON, or
//                   a delta `{"delta":…,"commands":…}` against the previous stored frame
//   last line       `{"end":{"checkpoints":[…],"recording"?:…,"diagnostics"?:…}}`
// Older recordings are one JSON document with a `frames` array; `readRecording` reads both.
//
// A delta is a patch over the previous stored frame's state:
//   {"v": value}                    the whole value
//   {"o": {key: patch}, "k"?: [..]} an object: these keys changed; `k` is the full key order when the
//                                   key set or order changed (new keys arrive as {"v": …})
//   {"a": {"s"?, "d"?, "r"?}}       a keyed list: entries set whole, keys dropped, and the full key order
//                                   when it is not keyed-list.ts's default. The key is `id` (or `spec.id`)
//                                   up to schema 19, and `playerIdx`, else `gateIdx`, else that, from
//                                   schema 20 (`recordKeyFor`). The rule is fixed by the header's schema;
//                                   changing it needs a new schema or frame encoding (26).
//   {}                              unchanged
// Entities are replaced whole, never field by field. Commands are never deltas. The previous *stored*
// frame is the base, so a frame the writer omitted under backpressure is never referenced.
//
// Integrity (26): the archive's digest covers the stored lines. Each `checkpoints` entry is the SHA-256 of
// a frame's full JSON line, taken by the writer for the last frame before each keyframe and for the final
// frame, so a reader that rebuilds frames can prove the deltas reproduced what was recorded.

import { rebuildKeyed, type Id } from './keyed-list.ts';
import { RELATIONAL_SCHEMA, type RecordingFit } from './recording.ts';

export const FRAME_ENCODING = 'delta-1';
/** A keyframe at least every this many stored frames: 5 s at 20 Hz. Seeks rebuild at most this many. */
export const KEYFRAME_EVERY = 100;
/**
 * A keyframe is also cut early once the deltas since the last one exceed `keyframeEvery` times this share
 * of it: on average a delta over an eighth of a keyframe, as when state churns. Ordinary play stays far
 * below it (a 12x6 delta is about a twelfth of its keyframe); comparing against one keyframe's size cut
 * one every 13 frames there and more than doubled the archive (Corey chose this rule, #901, 2026-11-14).
 */
export const EARLY_KEYFRAME_SHARE = 1 / 8;

type Shadow =
  | { kind: 'v'; json: string }
  | { kind: 'o'; keys: string[]; children: Map<string, Shadow> }
  | { kind: 'a'; ids: Id[]; texts: Map<Id, string> };
type Frame = { state: unknown; commands?: unknown };
export type Checkpoint = { frame: number; sha256: string };

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
type KeyOf = (entry: unknown) => Id | undefined;
const asKey = (id: unknown): Id | undefined => typeof id === 'string' || typeof id === 'number' ? id : undefined;
/** Schemas 10-19: `id`, else `spec.id` (physics world bodies). */
const idKey: KeyOf = entry => isPlain(entry) ? asKey(entry.id ?? (isPlain(entry.spec) ? entry.spec.id : undefined)) : undefined;
/** Schema 20, relational: seat slot, else gate slot, else the id rule. */
const relationalKey: KeyOf = entry => isPlain(entry) ? asKey(entry.playerIdx ?? entry.gateIdx ?? idKey(entry)) : undefined;
/**
 * The key rule a recording's list patches use, chosen once from its header's schema and never from the
 * data: a schema below `RELATIONAL_SCHEMA` keys by id, a later one by the relational rule. A header with no
 * schema (a bare test header) is read as the oldest rule; a schema that is not a whole number is refused.
 * A later rule needs a new schema or frame encoding, since the reader of an old file must not guess.
 */
export function recordKeyFor(schema: unknown): KeyOf {
  if (schema === undefined) return idKey;
  if (!Number.isSafeInteger(schema) || (schema as number) < 0) throw damaged('the header schema is not a whole number');
  return (schema as number) < RELATIONAL_SCHEMA ? idKey : relationalKey;
}
function keyable(list: unknown, recordKey: KeyOf): list is unknown[] {
  if (!Array.isArray(list) || !list.length) return false;
  const seen = new Set<Id>();
  for (const entry of list) {
    const key = recordKey(entry);
    if (key === undefined || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

// ---- encoding (the writer's worker) ----------------------------------------------------------------

// Values here come from JSON.parse, so JSON.stringify gives back the bytes they were parsed from.
function shadowOf(value: unknown, recordKey: KeyOf, json?: string): Shadow {
  if (keyable(value, recordKey)) {
    const texts = new Map<Id, string>();
    for (const entry of value) texts.set(recordKey(entry)!, JSON.stringify(entry));
    return { kind: 'a', ids: value.map(entry => recordKey(entry)!), texts };
  }
  if (isPlain(value)) {
    const keys = Object.keys(value);
    return { kind: 'o', keys, children: new Map(keys.map(key => [key, shadowOf(value[key], recordKey)])) };
  }
  return { kind: 'v', json: json ?? JSON.stringify(value) };
}
const sameOrder = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => value === b[i]);

// The patch from a value's shadow to its new value, and the new shadow. `json` is the value's text when known.
function diff(prev: Shadow, value: unknown, recordKey: KeyOf, json?: string): [Shadow, string | undefined] {
  if (prev.kind === 'o' && isPlain(value)) {
    const keys = Object.keys(value), children = new Map<string, Shadow>(), parts: string[] = [];
    for (const key of keys) {
      const before = prev.children.get(key);
      if (before) {
        const [child, patch] = diff(before, value[key], recordKey);
        children.set(key, child);
        if (patch !== undefined) parts.push(`${JSON.stringify(key)}:${patch}`);
      } else {
        const text = JSON.stringify(value[key]);
        children.set(key, shadowOf(value[key], recordKey, text));
        parts.push(`${JSON.stringify(key)}:{"v":${text}}`);
      }
    }
    const reordered = !sameOrder(keys, prev.keys);
    const next: Shadow = { kind: 'o', keys, children };
    if (!parts.length && !reordered) return [next, undefined];
    return [next, `{"o":{${parts.join(',')}}${reordered ? `,"k":${JSON.stringify(keys)}` : ''}}`];
  }
  if (prev.kind === 'a' && keyable(value, recordKey)) {
    const texts = new Map<Id, string>(), ids: Id[] = [], set: string[] = [];
    for (const entry of value) {
      const key = recordKey(entry)!, text = JSON.stringify(entry);
      ids.push(key); texts.set(key, text);
      if (prev.texts.get(key) !== text) set.push(text);
    }
    const drop = prev.ids.filter(key => !texts.has(key));
    const expected = prev.ids.filter(key => texts.has(key)).concat(ids.filter(key => !prev.texts.has(key)));
    const reordered = !sameOrder(expected, ids);
    const next: Shadow = { kind: 'a', ids, texts };
    if (!set.length && !drop.length && !reordered) return [next, undefined];
    const fields: string[] = [];
    if (set.length) fields.push(`"s":[${set.join(',')}]`);
    if (drop.length) fields.push(`"d":${JSON.stringify(drop)}`);
    if (reordered) fields.push(`"r":${JSON.stringify(ids)}`);
    return [next, `{"a":{${fields.join(',')}}}`];
  }
  const text = json ?? JSON.stringify(value);
  if (prev.kind === 'v' && prev.json === text) return [prev, undefined];
  return [shadowOf(value, recordKey, text), `{"v":${text}}`];
}

/** A frame's state as its top-level keys and their JSON text, in key order; and its commands' JSON. */
export type FrameEntries = { entries: [string, string][]; commands?: string };
type Encoded = { text: string; keyframe: boolean; checkpoint?: { frame: number; line: string } };

const tail = (commands?: string) => commands === undefined ? '}' : `,"commands":${commands}}`;
/** A frame's full JSON line, `JSON.stringify({ state, commands })`, from its entries. */
export function frameText({ entries, commands }: FrameEntries): string {
  return `{"state":{${entries.map(([key, json]) => `${JSON.stringify(key)}:${json}`).join(',')}}${tail(commands)}`;
}

/**
 * The writer's side, one per recording: each stored frame as a keyframe or a delta. A keyframe is cut on the
 * first frame, every `keyframeEvery` stored frames, and early when state churns (`EARLY_KEYFRAME_SHARE`).
 * Unchanged top-level values are recognised by their text and never parsed.
 */
export function createFrameEncoder({ keyframeEvery = KEYFRAME_EVERY, schema }: { keyframeEvery?: number; schema?: unknown } = {}) {
  const recordKey = recordKeyFor(schema);
  let top: Map<string, { json: string; shadow?: Shadow }> | null = null, keys: string[] = [];
  let index = 0, sinceKey = 0, keyBytes = 0, deltaBytes = 0;
  let previous: { frame: FrameEntries | null; keyframe: boolean } | null = null;
  function finishRecord(text: string, keyframe: boolean, frame: FrameEntries | null): Encoded {
    const encoded: Encoded = { text, keyframe };
    // The last frame before a keyframe proves the interval it closes; a keyframe proves itself.
    if (keyframe && previous && !previous.keyframe && previous.frame) encoded.checkpoint = { frame: index - 1, line: frameText(previous.frame) };
    if (keyframe) { sinceKey = 0; keyBytes = text.length; deltaBytes = 0; } else { sinceKey++; deltaBytes += text.length; }
    previous = { frame, keyframe }; index++;
    return encoded;
  }
  return {
    /** Encode a frame whose state is a plain object. */
    encode(frame: FrameEntries): Encoded {
      const due = !top || sinceKey + 1 >= keyframeEvery || deltaBytes > keyBytes * keyframeEvery * EARLY_KEYFRAME_SHARE;
      if (due) {
        const next = new Map<string, { json: string; shadow?: Shadow }>();
        for (const [key, json] of frame.entries) {
          const was = top?.get(key);
          next.set(key, was && was.json === json ? was : { json });
        }
        top = next; keys = frame.entries.map(([key]) => key);
        return finishRecord(frameText(frame), true, frame);
      }
      const parts: string[] = [], nextKeys = frame.entries.map(([key]) => key);
      for (const [key, json] of frame.entries) {
        const was = top!.get(key);
        if (was?.json === json) continue;
        if (!was) { top!.set(key, { json }); parts.push(`${JSON.stringify(key)}:{"v":${json}}`); continue; }
        const [shadow, patch] = diff(was.shadow ?? shadowOf(JSON.parse(was.json), recordKey, was.json), JSON.parse(json), recordKey, json);
        top!.set(key, { json, shadow });
        if (patch !== undefined) parts.push(`${JSON.stringify(key)}:${patch}`);
      }
      const reordered = !sameOrder(nextKeys, keys);
      if (reordered) for (const key of keys) if (!nextKeys.includes(key)) top!.delete(key);
      keys = nextKeys;
      const delta = parts.length || reordered ? `{"o":{${parts.join(',')}}${reordered ? `,"k":${JSON.stringify(nextKeys)}` : ''}}` : '{}';
      return finishRecord(`{"delta":${delta}${tail(frame.commands)}`, false, frame);
    },
    /** A frame stored as its full line because its state is not a plain object; the next is a keyframe. */
    whole(line: string): Encoded {
      top = null; keys = [];
      return finishRecord(line, true, null);
    },
    /** The final frame's checkpoint, unless it is a keyframe. */
    close(): { frame: number; line: string } | undefined {
      return previous && !previous.keyframe && previous.frame ? { frame: index - 1, line: frameText(previous.frame) } : undefined;
    },
  };
}

// ---- reading ---------------------------------------------------------------------------------------

/** A recording that cannot be read: `fit` says why when the schema pair decides it (`shared/recording.ts`). */
export class RecordingError extends Error {
  fit?: Exclude<RecordingFit, 'ok'>;
  constructor(message: string, fit?: Exclude<RecordingFit, 'ok'>) { super(message); this.name = 'RecordingError'; if (fit) this.fit = fit; }
}
const damaged = (why: string) => new RecordingError(`Replay is damaged: ${why}`);

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
function setOwn(object: Record<string, unknown>, key: string, value: unknown) {
  // A file is untrusted: a "__proto__" key must stay a key.
  if (key === '__proto__') Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
  else object[key] = value;
}

/** A value with a delta patch applied. Unchanged parts are shared with `prev`, which is never modified. */
export function applyPatch(prev: unknown, patch: unknown, schema?: unknown): unknown {
  if (!isPlain(patch)) throw damaged('a patch is not an object');
  if (own(patch, 'v')) return patch.v;
  if (own(patch, 'a')) {
    const change = patch.a as { s?: unknown; d?: unknown; r?: unknown };
    if (!Array.isArray(prev) || !isPlain(change)) throw damaged('a list change has no list');
    if ((change.s !== undefined && !Array.isArray(change.s)) || (change.d !== undefined && !Array.isArray(change.d)) || (change.r !== undefined && !Array.isArray(change.r))) throw damaged('a list change is malformed');
    try { return rebuildKeyed(prev, entry => recordKeyFor(schema)(entry) as Id, change.s as unknown[], change.d as Id[], change.r as Id[]); }
    catch (error) { throw damaged((error as Error).message); }
  }
  if (own(patch, 'o') || own(patch, 'k')) {
    const changes = (patch.o ?? {}) as Record<string, unknown>, order = patch.k ?? Object.keys(prev as object);
    if (!isPlain(prev) || !isPlain(changes) || !Array.isArray(order)) throw damaged('an object change has no object');
    const next: Record<string, unknown> = {};
    for (const key of order) {
      if (typeof key !== 'string') throw damaged('an object key is not text');
      if (own(changes, key)) setOwn(next, key, applyPatch(prev[key], changes[key], schema));
      else if (own(prev, key)) setOwn(next, key, prev[key]);
      else throw damaged(`an object change names a missing key ${key}`);
    }
    return next;
  }
  return prev;
}

/** What `readRecording` returns: the header's fields, every frame rebuilt, and the trailer's fields. */
export type Recording = Record<string, unknown> & { frames: Frame[]; checkpoints?: Checkpoint[]; truncated?: boolean };

/** `onHeader` sees the header before any frame is read, so a reader's policy (`recordingFit`) can refuse early. */
export type ReadOptions = { onHeader?: (header: Record<string, unknown>) => void };

/**
 * A reader fed text in pieces, as it arrives: lines split as they complete, each frame rebuilt in turn.
 * A legacy document is one line, kept as given.
 */
export function createRecordingReader({ onHeader }: ReadOptions = {}) {
  const pieces: string[] = [];
  let header: Record<string, unknown> | null = null, legacy: Record<string, unknown> | null = null, ended = false;
  const frames: Frame[] = [], recording: Record<string, unknown> = {};
  function line(text: string) {
    if (!text) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw damaged(header ? `frame ${frames.length + 1} is not JSON` : 'the header is not JSON'); }
    if (!isPlain(value)) throw damaged('a line is not an object');
    if (!header) {
      onHeader?.(value);
      header = value;
      if (Array.isArray(value.frames)) { legacy = value; return; }
      if (value.frameEncoding !== FRAME_ENCODING) throw new RecordingError(`Unknown frame encoding ${String(value.frameEncoding)}`, 'too-new');
      recordKeyFor(value.schema); // refuse a malformed schema before any frame
      return;
    }
    if (legacy || ended) throw damaged('text after the end of the recording');
    if (own(value, 'end')) { if (!isPlain(value.end)) throw damaged('the trailer is not an object'); Object.assign(recording, value.end); ended = true; return; }
    let state: unknown;
    if (own(value, 'state')) state = value.state;
    else if (own(value, 'delta')) {
      if (!frames.length) throw damaged('the first frame is not a keyframe');
      state = applyPatch(frames[frames.length - 1]!.state, value.delta, header!.schema);
    } else throw damaged(`frame ${frames.length + 1} has neither state nor delta`);
    frames.push(own(value, 'commands') ? { state, commands: value.commands } : { state });
  }
  return {
    /** Feed the next piece of text. */
    push(text: string) {
      let start = 0, newline = text.indexOf('\n');
      while (newline !== -1) {
        pieces.push(text.slice(start, newline));
        const whole = pieces.join(''); pieces.length = 0;
        line(whole);
        start = newline + 1; newline = text.indexOf('\n', start);
      }
      if (start < text.length) pieces.push(text.slice(start));
    },
    /** The recording read so far, once the text has ended. */
    end(): Recording {
      if (pieces.length) { const rest = pieces.join(''); pieces.length = 0; line(rest); }
      if (!header) throw damaged('it is empty');
      if (legacy) return legacy as Recording;
      const result: Recording = { ...header, ...recording, frames };
      if (!ended) result.truncated = true;
      return result;
    },
  };
}

/** Read a whole recording held as text. */
export function readRecording(text: string, options?: ReadOptions): Recording {
  const reader = createRecordingReader(options);
  reader.push(text);
  return reader.end();
}

/** Read a recording from a stream of text pieces (a `TextDecoderStream`'s readable side, or any async iterable). */
export async function readRecordingStream(stream: AsyncIterable<string> | ReadableStream<string>, options?: ReadOptions): Promise<Recording> {
  const reader = createRecordingReader(options);
  if (Symbol.asyncIterator in stream) { for await (const piece of stream as AsyncIterable<string>) reader.push(piece); return reader.end(); }
  const source = (stream as ReadableStream<string>).getReader();
  for (;;) {
    const { done, value } = await source.read();
    if (done) break;
    reader.push(value);
  }
  return reader.end();
}

/**
 * Frames whose rebuilt JSON does not hash to its checkpoint, by index; empty when every checkpoint holds.
 * `sha256` hashes text to hex, from whatever the caller has (node:crypto in tools and tests).
 */
export function checkpointFailures(recording: Recording, sha256: (text: string) => string): number[] {
  const failures: number[] = [];
  for (const checkpoint of recording.checkpoints ?? []) {
    const frame = recording.frames[checkpoint.frame];
    if (!frame || sha256(JSON.stringify(frame)) !== checkpoint.sha256) failures.push(checkpoint.frame);
  }
  return failures;
}
