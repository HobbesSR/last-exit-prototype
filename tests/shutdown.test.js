import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';

for (const retire of [false, true]) test(`shutdown awaits already-started finalization${retire ? ' even after room retirement' : ''}`, async () => {
  let release;
  const pending = new Promise(resolve => release = resolve);
  const h = roomHarness({ finalize: () => pending }), { owner, room, writer } = h.live();
  owner.send({ type: 'finish' }); assert.equal(room.finished, true);
  if (retire) { h.service.disconnect(owner.session); h.wake(0, 180001); assert.equal(h.service.rooms.size, 0); }
  let closed = false;
  const closing = h.service.close().then(() => closed = true);
  try {
    await Promise.resolve(); await Promise.resolve();
    assert.equal(closed, false, 'shutdown must retain ownership of in-flight archive work');
    release(); await closing;
    assert.equal(writer.finishCalls, 1);
  } finally { release(); await closing; }
});

test('room shutdown is idempotent and stops accepting or advancing work', async () => {
  const h = roomHarness(), { writer, room, owner } = h.live();
  const first = h.service.close(); assert.equal(h.service.close(), first); await first;
  assert.equal(writer.finishCalls, 1); const frames = writer.frames.length;
  h.wake(500); owner.send({ type: 'input', seq: 1, x: 1 });
  assert.equal(writer.frames.length, frames); assert.equal(room.match.phase, 'finished');
  assert.equal(h.service.hasCapacity(), false); assert.equal(h.service.makeRoom(9), null);
});

test('a failed pending archive reports failure once and allows shutdown to settle', async () => {
  let reject;
  const errors = [], pending = new Promise((_resolve, fail) => reject = fail);
  const h = roomHarness({ finalize: () => pending, reportError: error => errors.push(error.message) });
  const { owner, writer } = h.live(); owner.send({ type: 'finish' });
  const closing = h.service.close(); reject(new Error('archive unavailable')); await closing;
  assert.deepEqual(errors, ['archive unavailable']); assert.equal(writer.finishCalls, 1);
  assert.equal(owner.messages.filter(m => m.type === 'saved').length, 0);
  assert.equal(owner.messages.filter(m => m.type === 'error').length, 1);
});
