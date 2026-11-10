import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReplayWriter, frameLine, MAX_DIAGNOSTIC_MARKS } from '../server/replay-writer.js';
import { createPhysicsGame, disposePhysics, snapshot, step } from '../shared/simulation.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { generatedMap } from './helpers/room-harness.js';
import { itemsJson } from '../shared/simulation/ground-items.ts';
import { gatesJson } from '../shared/simulation/frame-gates.ts';
import { createFileReplayStore } from '../server/replay-store.js';

test('replay writer preserves frame JSON, command ownership, integrity and idempotent publication', async () => {
  const chunks = [], published = [], errors = [];
  const output = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
  const header = { version: 'last-exit-0.6', id: 'abcdef12', seed: 9, hz: 20, createdAt: 100, map: { nodes: [] } };
  const writer = createReplayWriter({ header, output, publish: async meta => published.push(meta), onError: e => errors.push(e) });
  const state = { tick: 0, phase: 'live' }, commands = [{ type: 'input', input: { interact: true } }];
  const expected = [{ state: structuredClone(state), commands: structuredClone(commands) }];
  writer.append(state, commands); state.tick = 1; commands[0].input.interact = false;
  expected.push({ state: structuredClone(state), commands: [] }); writer.append(state, []);
  const first = writer.finish({ ticks: 1, escaped: 0 });
  assert.equal(writer.finish({ ticks: 999, escaped: 3 }), first);
  const meta = await first;
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(chunks))), { ...header, frames: expected });
  const digest = createHash('sha256'); for (const frame of expected) digest.update(JSON.stringify(frame) + '\n');
  assert.deepEqual(meta, { id: header.id, seed: 9, createdAt: 100, ticks: 1, frames: 2, sha256: digest.digest('hex'), escaped: 0 });
  assert.deepEqual(published, [meta]); assert.deepEqual(errors, []);
  assert.throws(() => writer.append({}, []), /finalized/);
});

test('diagnostic markers ride in a bounded trailer and leave the frames and digest untouched', async () => {
  const run = async marks => {
    const chunks = [], output = new Writable({ write(chunk, _e, next) { chunks.push(Buffer.from(chunk)); next(); } });
    const writer = createReplayWriter({ header: { id: 'marks' }, output, publish: async () => {}, onError: () => {} });
    writer.append({ tick: 0 }, []); writer.append({ tick: 1 }, []);
    for (const mark of marks) writer.mark(mark);
    const meta = await writer.finish({ ticks: 1 });
    return { meta, replay: JSON.parse(gunzipSync(Buffer.concat(chunks))), writer };
  };
  const plain = await run([]);
  assert.equal('diagnostics' in plain.replay, false, 'no trailer when there is nothing to say');
  const marked = await run([{ tick: 1, kind: 'server-stall' }]);
  assert.deepEqual(marked.replay.diagnostics, { marks: [{ tick: 1, kind: 'server-stall' }] });
  assert.equal(marked.meta.sha256, plain.meta.sha256);
  assert.deepEqual(marked.replay.frames, plain.replay.frames);
  const flood = await run(Array.from({ length: MAX_DIAGNOSTIC_MARKS + 7 }, (_, tick) => ({ tick, kind: 'manual' })));
  assert.equal(flood.replay.diagnostics.marks.length, MAX_DIAGNOSTIC_MARKS);
  assert.equal(flood.replay.diagnostics.dropped, 7);
  assert.equal(flood.writer.mark({ tick: 1, kind: 'manual' }), false, 'a finished recording takes no more');
});

test('replay stream and publication failures reject completion without publishing success', async () => {
  let published = false;
  const failure = new Error('disk unavailable');
  const writer = createReplayWriter({ header: { id: 'bad' }, output: new Writable({ write(_c, _e, next) { next(failure); } }),
    publish: async () => { published = true; }, onError: () => {} });
  writer.append({ tick: 0 }, []);
  await assert.rejects(writer.finish({ ticks: 0, escaped: 0 }), /disk unavailable/);
  assert.equal(published, false);
  const second = createReplayWriter({ header: { id: 'bad-meta' }, output: new Writable({ write(_c, _e, next) { next(); } }),
    publish: async () => { throw new Error('metadata unavailable'); } });
  second.append({ tick: 0 }, []);
  await assert.rejects(second.finish({ ticks: 0, escaped: 0 }), /metadata unavailable/);
});

test('replay writer exposes real stream backpressure and drains before publication', async () => {
  let published = false;
  const writer = createReplayWriter({ header: { id: 'slow' },
    output: new Writable({ write(_c, _e, next) { setImmediate(next); } }), publish: async () => published = true });
  writer.append({ payload: 'x'.repeat(256 * 1024) }, []);
  assert.equal(writer.blocked, true); assert.equal(published, false);
  await writer.finish({ ticks: 0, escaped: 0 }); assert.equal(published, true);
});

test("the replay writer's default budget holds four frames of any size", async () => {
  const chunks = [], callbacks = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); callbacks.push(next); } });
  const writer = createReplayWriter({ header: { id: 'large' }, output, publish: async () => {}, onError: () => {},
    gzipOptions: { writableHighWaterMark: 1, readableHighWaterMark: 1 } });
  // Over 8 MiB together but four frames of their own size: a larger map's frames, held while the output waits.
  const payload = 'x'.repeat(3 * 1024 * 1024);
  for (let tick = 0; tick < 4; tick++) assert.equal(writer.append({ tick, payload }, []), true, `frame ${tick}`);
  assert.equal(writer.append({ tick: 4, payload }, []), false);
  assert.equal(writer.droppedFrames, 1);
  writer.abort();
});

test('replay writer bounds immutable serialized frames, drops whole frames, then resumes after draining', async () => {
  const chunks = [], callbacks = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); callbacks.push(next); } });
  const writer = createReplayWriter({ header: { id: 'bounded' }, output, publish: async () => {}, onError: () => {},
    queueBytes: 600, gzipOptions: { writableHighWaterMark: 1, readableHighWaterMark: 1 } });
  const first = { tick: 0, payload: 'a'.repeat(240) };
  assert.equal(writer.append(first, [{ type: 'first' }]), true);
  assert.equal(writer.append({ tick: 1, payload: 'b'.repeat(240) }, [{ type: 'dropped' }]), false);
  assert.equal(writer.droppedFrames, 1);
  assert.ok(writer.pendingBytes <= 600);
  first.payload = 'mutated after append';
  // Drain until the condition actually holds rather than for a fixed number of turns. gzip does its
  // work on the threadpool, so how many event-loop turns it needs depends on what else is running:
  // twenty was enough on an idle machine and not enough under a full suite, where this test starved
  // its own writer past the finalization deadline and failed as if the writer were at fault.
  const pump = async done => {
    const deadline = Date.now() + 4000;
    while (!done() && Date.now() < deadline) {
      while (callbacks.length) callbacks.shift()();
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  };
  await pump(() => !writer.blocked);
  assert.equal(writer.append({ tick: 2, payload: 'c'.repeat(24) }, []), true);
  const completion = writer.finish({ ticks: 3, escaped: 0 });
  let finished = false;
  completion.then(() => { finished = true; }, () => { finished = true; });
  await pump(() => finished);
  await completion;
  const replay = JSON.parse(gunzipSync(Buffer.concat(chunks)));
  assert.deepEqual(replay.frames.map(frame => frame.state.tick), [0, 2]);
  assert.equal(replay.frames[0].state.payload, 'a'.repeat(240));
  assert.deepEqual(replay.recording, { complete: false, droppedFrames: 1, endTick: 3 });
});

test('replay writer contains synchronous serialization errors and idempotently aborts stalled recording', async () => {
  const errors = [], stalled = new Writable({ write() {} });
  const writer = createReplayWriter({ header: { id: 'stalled' }, output: stalled, publish: async () => assert.fail('must not publish'),
    onError: error => errors.push(error), finalizeTimeoutMs: 20 });
  const circular = {}; circular.circular = circular;
  assert.equal(writer.append({ tick: 0, circular }, []), false);
  assert.ok(writer.failed instanceof Error);
  writer.abort(new Error('later abort')); writer.abort(new Error('another abort'));
  assert.equal(errors.length, 1);
  await assert.rejects(writer.finish({ ticks: 1, escaped: 0 }), /circular/);

  const timeoutErrors = [];
  const timeoutWriter = createReplayWriter({ header: { id: 'timeout' }, output: new Writable({ write() {} }), publish: async () => assert.fail('must not publish'),
    onError: error => timeoutErrors.push(error), finalizeTimeoutMs: 20 });
  assert.equal(timeoutWriter.append({ tick: 0 }, []), true);
  const first = timeoutWriter.finish({ ticks: 1, escaped: 0 });
  assert.equal(timeoutWriter.finish({ ticks: 99, escaped: 9 }), first);
  await assert.rejects(first, /exceeded 20ms/);
  assert.match(timeoutWriter.failed.message, /exceeded 20ms/);
  assert.equal(timeoutErrors.length, 1);
});

test('filesystem store forwards writer errors and never promotes a failed archive on restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'last-exit-replay-store-'));
  try {
    const errors = [], store = await createFileReplayStore(directory);
    // The nested directory does not exist, so the stream fails without a publishable metadata row.
    const writer = store.start({ id: 'missing/recording' }, { onError: error => errors.push(error) });
    writer.append({ tick: 0 }, []);
    await assert.rejects(writer.finish({ ticks: 1, escaped: 0 }), /ENOENT/);
    assert.equal(errors.length, 1);
    const restarted = await createFileReplayStore(directory);
    assert.deepEqual(restarted.list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a header descriptor is written once and leaves frame bytes and digest untouched', async () => {
  const { describeContent } = await import('../shared/presentation.ts');
  const { defaultContent } = await import('../shared/simulation/content.ts');
  const run = async header => {
    const chunks = [], output = new Writable({ write(chunk, _e, next) { chunks.push(Buffer.from(chunk)); next(); } });
    const writer = createReplayWriter({ header, output, publish: async () => {}, onError: () => {} });
    writer.append({ tick: 0, duration: 12000 }, []); writer.append({ tick: 1, duration: 12000 }, [{ type: 'start' }]);
    const meta = await writer.finish({ ticks: 1 });
    return { meta, text: gunzipSync(Buffer.concat(chunks)).toString() };
  };
  const presentation = describeContent(defaultContent());
  const plain = await run({ id: 'p', contentId: presentation.contentId });
  const described = await run({ id: 'p', contentId: presentation.contentId, presentation });
  assert.equal(described.meta.sha256, plain.meta.sha256);
  assert.equal(described.text.split('"presentation"').length, 2, 'once, in the header');
  const frames = text => text.slice(text.indexOf('"frames":'));
  assert.equal(frames(described.text), frames(plain.text));
  assert.deepEqual(JSON.parse(described.text).presentation, presentation);
});

test('frames are written byte for byte as JSON.stringify writes them, with the ground and gates from their kept JSON (#655)', async t => {
  // A physics match on the room arena, the shipped content and engine (#920).
  const s = await createPhysicsGame(4217, generatedMap(), defaultContent()), chunks = [], advance = () => { step(s); return snapshot(s); };
  t.after(() => disposePhysics(s));
  const output = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
  const header = { id: 'ground', seed: 4217 };
  const writer = createReplayWriter({ header, output, publish: async () => {}, onError: error => { throw error; } });
  const records = [];
  const append = (state, commands) => { records.push({ state, commands }); assert.equal(writer.append(state, commands), true); };
  assert.ok(s.map.gates.length, 'the game has gates to record');
  for (let tick = 0; tick < 40; tick++) {
    // A gate that changes mid-recording, as a door does when it is opened, must reach the recorded frame.
    if (tick === 20) s.map.gates[0].open = !s.map.gates[0].open;
    append(advance(), tick % 7 ? [] : [{ type: 'input', input: { name: 'Zoë ✓' } }]);
  }
  const frame = advance();
  // Shapes the writer must still match: undefined values and commands, lists nobody published, non-ASCII text.
  append({ ...frame, gone: undefined, name: 'Ünïcode ✓', items: frame.items.map(item => ({ ...item })), gates: frame.gates.map(gate => ({ ...gate, name: 'Tür ✓' })) }, undefined);
  append({ tick: 1, items: [], gates: [] }, []);
  append({ tick: 2, items: 'not a list' }, []);
  append({}, []);
  const meta = await writer.finish({ ticks: 44 });
  const text = gunzipSync(Buffer.concat(chunks)).toString();
  assert.equal(text, `${JSON.stringify(header).slice(0, -1)},"frames":[${records.map(r => JSON.stringify(r)).join(',')}]}`);
  const digest = createHash('sha256'); for (const r of records) digest.update(`${JSON.stringify(r)}
`);
  assert.equal(meta.sha256, digest.digest('hex'));
  const kept = (key, list) => { const json = key === 'items' ? itemsJson(list) : gatesJson(list); return { json, bytes: Buffer.byteLength(json) }; };
  for (const { state, commands } of records) {
    const { line, bytes } = frameLine(state, commands, kept);
    assert.equal(bytes, Buffer.byteLength(line));
  }
});

test('an omitted kept-list update cannot replace the last retained worker state', async () => {
  const chunks = [];
  const writer = createReplayWriter({ header: { id: 'kept-gap' }, queueBytes: 1200,
    output: new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } }),
    publish: async () => {}, onError: () => {} });
  const initial = { tick: 0, items: [{ id: 'old', name: '雪' }], gates: [{ id: 'door', open: false }] };
  assert.equal(writer.append(initial, []), true);
  const changed = { tick: 1, items: [{ id: 'new', name: 'é' }], gates: [{ id: 'door', open: true }] };
  assert.equal(writer.append({ ...changed, payload: 'x'.repeat(2000) }, []), false);
  // Resume using the very same list objects as the rejected append. The worker must receive them now.
  const deadline = Date.now() + 4000;
  while (writer.blocked && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(writer.blocked, false);
  assert.equal(writer.append(changed, []), true);
  const meta = await writer.finish({ ticks: 1 });
  const frames = [{ state: initial, commands: [] }, { state: changed, commands: [] }];
  const replay = JSON.parse(gunzipSync(Buffer.concat(chunks)));
  assert.deepEqual(replay.frames, frames);
  assert.equal(meta.sha256, createHash('sha256').update(frames.map(frame => JSON.stringify(frame) + '\n').join('')).digest('hex'));
  assert.equal(meta.recording.droppedFrames, 1);
});

test('header serialization and premature output closure fail recording once without publication', async () => {
  for (const mode of ['header', 'close']) {
    const errors = [], header = { id: mode };
    if (mode === 'header') header.circular = header;
    const output = new Writable({ write() {} });
    const writer = createReplayWriter({ header, output, onError: error => errors.push(error),
      publish: async () => assert.fail('a failed output must never publish') });
    if (mode === 'close') {
      assert.equal(writer.append({ tick: 0 }, []), true);
      output.destroy();
      // Observe close before finish: this must fail during a live match, without waiting for its deadline.
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(writer.append({ tick: 1 }, []), false);
    await assert.rejects(writer.finish({ ticks: 0 }), mode === 'header' ? /circular/ : /closed before completion/);
    assert.equal(errors.length, 1);
  }
});

test('the worker-owned file output preserves exact archive bytes and store publication', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'last-exit-worker-file-'));
  try {
    const header = { id: 'worker-file', seed: 42, createdAt: 123, map: { name: '街' } };
    const states = [{ tick: 0, items: [{ id: 'loot', name: 'é' }], gates: [] },
      { tick: 1, gates: [], items: [], gone: undefined, label: '雪' }];
    const store = await createFileReplayStore(directory);
    const writer = store.start(header, { onError: () => {} });
    states.forEach(state => assert.equal(writer.append(state, []), true));
    writer.mark({ tick: 1, kind: 'manual' });
    const meta = await writer.finish({ ticks: 1, escaped: 0 });
    const expected = `${JSON.stringify(header).slice(0, -1)},"frames":[${states.map(state => JSON.stringify({ state, commands: [] })).join(',')}],"diagnostics":{"marks":[{"tick":1,"kind":"manual"}]}}`;
    assert.equal(gunzipSync(await readFile(store.download(header.id).path)).toString(), expected);
    assert.deepEqual((await createFileReplayStore(directory)).list(), [meta]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
