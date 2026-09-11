import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createReplayWriter } from '../server/replay-writer.js';

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
