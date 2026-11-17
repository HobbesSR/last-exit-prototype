import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyPatch, checkpointFailures, createFrameEncoder, createRecordingReader, FRAME_ENCODING, readRecording, RecordingError } from '../shared/recording-format.ts';
import { rebuildKeyed } from '../shared/keyed-list.ts';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const entriesOf = state => Object.keys(state).flatMap(key => { const json = JSON.stringify(state[key]); return json === undefined ? [] : [[key, json]]; });

// Encode frames as the writer's worker does and return the archive text (26).
function archive(frames, keyframeEvery = 100, schema) {
  const encoder = createFrameEncoder({ keyframeEvery, schema }), lines = [`{"id":"t",${schema === undefined ? '' : `"schema":${schema},`}"frameEncoding":"${FRAME_ENCODING}","keyframeEvery":${keyframeEvery}}`];
  const checkpoints = [], kinds = [];
  for (const { state, commands } of frames) {
    const plain = state !== null && typeof state === 'object' && !Array.isArray(state);
    const encoded = plain ? encoder.encode({ entries: entriesOf(state), commands: JSON.stringify(commands) }) : encoder.whole(JSON.stringify({ state, commands }));
    if (encoded.checkpoint) checkpoints.push({ frame: encoded.checkpoint.frame, sha256: sha256(encoded.checkpoint.line) });
    kinds.push(encoded.keyframe ? 'key' : 'delta');
    lines.push(encoded.text);
  }
  const last = encoder.close();
  if (last) checkpoints.push({ frame: last.frame, sha256: sha256(last.line) });
  lines.push(`{"end":{"checkpoints":${JSON.stringify(checkpoints)}}}`);
  return { text: `${lines.join('\n')}\n`, kinds, checkpoints };
}
const lines = recording => recording.frames.map(frame => JSON.stringify(frame));

test('every patch form rebuilds each frame byte for byte, with checkpoints that hold', () => {
  const body = (id, x, extra = {}) => ({ spec: { id }, x, ...extra });
  const frames = [
    { state: { tick: 0, players: [{ id: 'a', x: 1 }, { id: 'b', x: 2 }], physics: { world: { bodies: [body('p', 0)] } }, route: [1, 2], name: 'Zoë ✓' }, commands: [] },
    { state: { tick: 1, players: [{ id: 'a', x: 1 }, { id: 'b', x: 3 }], physics: { world: { bodies: [body('p', 0)] } }, route: [1, 2], name: 'Zoë ✓' }, commands: [{ type: 'input', seq: 1 }] },
    // A player added, one removed, a body reordered with a new one, a non-keyed list changed.
    { state: { tick: 2, players: [{ id: 'b', x: 3 }, { id: 'c', x: 0 }], physics: { world: { bodies: [body('q', 5), body('p', 0)] } }, route: [2], name: 'Zoë ✓' } },
    // A key added at the top and inside an object; keys reordered; an entity gains a field.
    { state: { name: '雪', tick: 3, extra: { deep: [1] }, players: [{ id: 'b', x: 3, hp: 9 }, { id: 'c', x: 0 }], physics: { world: { bodies: [body('q', 5), body('p', 0)] }, hooks: [] }, route: [2] }, commands: [] },
    // Keys removed; a list loses its ids (duplicates), so it goes whole; another list empties.
    { state: { tick: 4, players: [{ id: 'b', x: 3 }, { id: 'b', x: 4 }], physics: { world: { bodies: [] } } }, commands: [] },
    // Back to keyed; an unchanged frame; a value of another kind.
    { state: { tick: 5, players: [{ id: 'b', x: 3 }], physics: 'gone' }, commands: [] },
    { state: { tick: 5, players: [{ id: 'b', x: 3 }], physics: 'gone' }, commands: [] },
    // Not a plain object: stored whole, and the next frame is a keyframe again.
    { state: null, commands: [] },
    { state: { tick: 7, players: [{ id: 'b', x: 3 }] }, commands: [] },
    { state: { tick: 8, players: [{ id: 'b', x: 4 }] }, commands: [] },
  ];
  const { text, kinds } = archive(frames);
  // The first frame, a frame that is not an object, and the one after it are keyframes; small states
  // like these also cut early keyframes by the byte rule, which the next test covers.
  for (const at of [0, 7, 8]) assert.equal(kinds[at], 'key', `frame ${at}`);
  assert.equal(kinds[9], 'delta');
  const recording = readRecording(text);
  assert.deepEqual(lines(recording), frames.map(frame => JSON.stringify(frame)));
  // A checkpoint closes each run of deltas: the last delta before a keyframe, and the final frame.
  const closing = kinds.flatMap((kind, i) => kind === 'delta' && (kinds[i + 1] === 'key' || i === kinds.length - 1) ? [i] : []);
  assert.deepEqual(recording.checkpoints.map(c => c.frame), closing);
  assert.deepEqual(checkpointFailures(recording, sha256), []);
  // A rebuilt frame that disagrees with what was recorded is caught by its checkpoint.
  recording.frames[9].state.tick = 99;
  assert.deepEqual(checkpointFailures(recording, sha256), [9]);
});

test('keyframes come every keyframeEvery stored frames, or early when state churns', () => {
  // Small deltas against a large keyframe: only the cadence cuts keyframes.
  const steady = Array.from({ length: 7 }, (_, tick) => ({ state: { tick, big: 'x'.repeat(500) }, commands: [] }));
  assert.deepEqual(archive(steady, 3).kinds, ['key', 'delta', 'delta', 'key', 'delta', 'delta', 'key']);
  // Every delta replaces a value as large as the keyframe. With keyframeEvery 8 the deltas may total
  // one keyframe (8 × 1/8) before a keyframe is cut; with 16, two.
  const churn = Array.from({ length: 7 }, (_, tick) => ({ state: { big: String(tick).repeat(400) }, commands: [] }));
  assert.deepEqual(archive(churn, 8).kinds, ['key', 'delta', 'key', 'delta', 'key', 'delta', 'key']);
  assert.deepEqual(archive(churn, 16).kinds, ['key', 'delta', 'delta', 'key', 'delta', 'delta', 'key']);
  for (const frames of [steady, churn]) assert.deepEqual(lines(readRecording(archive(frames, 3).text)), frames.map(frame => JSON.stringify(frame)));
});

test('the reader takes text in any pieces, reads legacy documents, and flags a missing trailer', () => {
  const frames = Array.from({ length: 4 }, (_, tick) => ({ state: { tick, players: [{ id: 'a', x: tick }] }, commands: [] }));
  const { text } = archive(frames, 2), whole = readRecording(text);
  for (const size of [1, 2, 7, 64]) {
    const reader = createRecordingReader();
    for (let at = 0; at < text.length; at += size) reader.push(text.slice(at, at + size));
    assert.deepEqual(reader.end(), whole, `pieces of ${size}`);
  }
  const legacy = { schema: 16, frames: [{ state: { tick: 0 }, commands: [] }], diagnostics: { marks: [] } };
  assert.deepEqual(readRecording(JSON.stringify(legacy)), legacy);
  const cut = text.slice(0, text.lastIndexOf('{"end"'));
  const partial = readRecording(cut);
  assert.equal(partial.truncated, true);
  assert.deepEqual(lines(partial), frames.map(frame => JSON.stringify(frame)));
  assert.equal(whole.truncated, undefined);
});

test('the header is offered to the reader policy first, and unknown encodings are refused', () => {
  const { text } = archive([{ state: { tick: 0 }, commands: [] }]);
  const seen = [];
  assert.throws(() => readRecording(text, { onHeader: header => { seen.push(header.id); throw new Error('refused'); } }), /refused/);
  assert.deepEqual(seen, ['t']);
  assert.throws(() => readRecording(text.replace(FRAME_ENCODING, 'delta-9')), error => error instanceof RecordingError && error.fit === 'too-new');
});

test('damaged and hostile input fails as damage, never as a prototype change', () => {
  const header = `{"frameEncoding":"${FRAME_ENCODING}"}`;
  const read = (...records) => readRecording([header, ...records].join('\n'));
  assert.throws(() => read('{"delta":{}}'), /first frame is not a keyframe/);
  assert.throws(() => read('{"state":{"a":1}}', 'not json'), /not JSON/);
  assert.throws(() => read('{"state":{"a":1}}', '{"other":1}'), /neither state nor delta/);
  assert.throws(() => read('{"state":{"a":1}}', '{"delta":{"o":{},"k":["b"]}}'), /missing key b/);
  assert.throws(() => read('{"state":{"a":[{"id":1}]}}', '{"delta":{"o":{"a":{"a":{"r":[2]}}}}}'), /damaged/);
  assert.throws(() => read('{"state":{"a":1}}', '{"end":{}}', '{"state":{}}'), /after the end/);
  const hostile = read('{"state":{"a":1}}', '{"delta":{"o":{"__proto__":{"v":{"polluted":true}}},"k":["a","__proto__"]}}');
  const state = hostile.frames[1].state;
  assert.equal(Object.getPrototypeOf(state), Object.prototype);
  assert.equal(state.polluted, undefined);
  assert.deepEqual(Object.keys(state), ['a', '__proto__']);
  assert.equal({}.polluted, undefined);
});

test('patches share what did not change and never modify the frame they apply to', () => {
  const items = [{ id: 'i' }], prev = { items, players: [{ id: 'a', x: 1 }] };
  const frozen = structuredClone(prev);
  const next = applyPatch(prev, { o: { players: { a: { s: [{ id: 'a', x: 2 }] } } } });
  assert.equal(next.items, items, 'an unchanged list is shared');
  assert.deepEqual(prev, frozen);
  assert.deepEqual(next.players, [{ id: 'a', x: 2 }]);
  assert.deepEqual(applyPatch(prev, {}), prev);
});

test('a keyed list keeps its order, appends what is new, and follows an explicit order exactly', () => {
  const all = [{ id: 1 }, { id: 2 }, { id: 3 }], key = entry => entry.id;
  assert.deepEqual(rebuildKeyed(all, key, [{ id: 4 }, { id: 2, v: 1 }], [1]), [{ id: 2, v: 1 }, { id: 3 }, { id: 4 }]);
  assert.deepEqual(rebuildKeyed(all, key, [{ id: 4 }], [], [4, 3, 1]), [{ id: 4 }, { id: 3 }, { id: 1 }]);
  assert.throws(() => rebuildKeyed(all, key, [], [], [9]), /no entry 9/);
  assert.notEqual(rebuildKeyed(all, key), all, 'a copy even when nothing changed');
});

test('the list key rule is fixed by the header schema: schema 19 keys by id even when entries carry slots', () => {
  // Entries share one playerIdx but have distinct ids: under the relational rule the list is not keyable.
  const row = (id, x) => ({ id, playerIdx: 0, gateIdx: 7, x });
  const frames = [
    { state: { tick: 0, players: [row('a', 1), row('b', 2)] }, commands: [] },
    { state: { tick: 1, players: [row('a', 1), row('b', 3)] }, commands: [] },
    { state: { tick: 2, players: [row('b', 3)] }, commands: [] },
  ];
  const old = archive(frames, 100, 19), next = archive(frames, 100, 20);
  assert.match(old.text, /"a":\{"s":\[\{"id":"b"/, 'schema 19 writes keyed-list patches by id');
  assert.match(old.text, /"d":\["a"\]/);
  assert.doesNotMatch(next.text, /"a":\{"s"/, 'schema 20 cannot key them by slot, so they go whole');
  for (const text of [old.text, next.text]) {
    const read = readRecording(text);
    assert.deepEqual(read.frames.map(f => f.state), frames.map(f => f.state));
    assert.deepEqual(checkpointFailures(read, sha256), []);
  }
  // The rule comes from the header, not the data: the same lines under another schema are not the same frames.
  const misread = () => readRecording(old.text.replace('"schema":19', '"schema":20')).frames.map(f => f.state);
  try { assert.notDeepEqual(misread(), frames.map(f => f.state)); } catch (error) { if (error.name !== 'RecordingError') throw error; }
  // Schema 20 keeps the slot rule for what it can key.
  const slots = archive([{ state: { players: [{ playerIdx: 3, id: 'a', x: 1 }] } }, { state: { players: [{ playerIdx: 3, id: 'a', x: 2 }] } }], 100, 20);
  assert.match(slots.text, /"s":\[\{"playerIdx":3/);
  assert.throws(() => readRecording('{"schema":"x","frameEncoding":"delta-1"}'), /schema/);
});
