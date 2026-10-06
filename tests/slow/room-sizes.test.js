import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from '../helpers/room-harness.js';
import { LIVE_ZONE_SIZES, zoneSizeName } from '../../map/live.ts';
import { recordingFit } from '../../shared/recording.ts';
import { createReplayTimeline } from '../../public/replay-timeline.js';
import { TICK_MS } from '../../server/scheduler.js';

// Every authored size has to play to its end, record and replay (#184, 14). A bot match runs
// whole; the recording keeps the header, every 200th frame and the last, which the replay timeline
// holds sparse frames for, so a 36 x 18 match does not have to fit in memory twice.
for (const size of LIVE_ZONE_SIZES) {
  test(`a ${zoneSizeName(size)} room plays to its end, records and replays`, async () => {
    const kept = [];
    let header, last, count = 0;
    const h = roomHarness({ startWriter: head => {
      header = structuredClone(head);
      return { append(state) { count++; last = state; if (state.tick % 200 === 0) kept.push({ state: structuredClone(state), commands: [] }); },
        mark() { return true; }, async finish(result) { return { id: head.id, ...result, frames: count }; } };
    } });
    const room = h.service.makeRoom(9, false, size), owner = h.joined(room, { ownerKey: room.ownerKey });
    owner.send({ type: 'start' });
    owner.send({ type: 'leave' });
    for (let i = 0; i < 20000 && !room.finished; i++) h.wake(TICK_MS);
    assert.equal(room.finished, true, 'the match ended');
    assert.ok(count > 1000 && last.tick === count - 1, 'every tick was recorded in order');
    kept.push({ state: structuredClone(last), commands: [] });
    const archive = { ...header, frames: kept };
    assert.equal(recordingFit(archive), 'ok');
    assert.deepEqual([archive.map.width, archive.map.height], [room.game.map.width, room.game.map.height]);
    const timeline = createReplayTimeline(archive);
    assert.equal(timeline.at(last.tick).state.tick, last.tick);
    assert.equal(timeline.at(Math.floor(last.tick / 2)).state.tick % 200, 0, 'omitted ticks hold the frame before them');
  });
}
