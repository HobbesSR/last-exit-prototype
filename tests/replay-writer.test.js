import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReplayWriter } from '../server/replay-writer.js';
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
  const pump = async (done, turns = 2000) => {
    for (let i = 0; i < turns && !done(); i++) {
      while (callbacks.length) callbacks.shift()();
      await new Promise(resolve => setImmediate(resolve));
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
