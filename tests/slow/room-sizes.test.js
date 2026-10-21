import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from '../helpers/room-harness.js';
import { LIVE_ZONE_SIZES, zoneSizeName } from '../../map/live.ts';
import { recordingFit } from '../../shared/recording.ts';
import { createReplayTimeline } from '../../public/replay-timeline.js';
import { TICK_MS } from '../../server/scheduler.js';

// The smallest size runs by default. A larger one costs about 1 min (24x12) and 4.5 min (36x18) of
// one core and finds little the smallest does not, so it needs a reason: ROOM_SIZES=all, or a list
// such as ROOM_SIZES=36x18. Run it when a change targets size-dependent generation or room limits.
const wanted = process.env.ROOM_SIZES?.split(',').map(name => name.trim());
const sizeNames = LIVE_ZONE_SIZES.map(zoneSizeName);
const invalid = wanted?.filter(name => name !== 'all' && !sizeNames.includes(name));
if (invalid?.length) {
  throw new Error(`Invalid ROOM_SIZES value(s): ${invalid.map(name => JSON.stringify(name)).join(', ')}. Supported values: all, ${sizeNames.join(', ')}`);
}
const sizes = wanted ? LIVE_ZONE_SIZES.filter(size => wanted.includes('all') || wanted.includes(zoneSizeName(size))) : LIVE_ZONE_SIZES.slice(0, 1);

// Every authored size has to play to its end, record and replay (#184, 14). The owner starts the
// match and disconnects, which hands the seat to its bot, while an owner spectator keeps the room
// watched so it is not abandoned (14). The recording keeps the header, every 200th frame and the
// last, which the replay timeline holds sparse frames for, so a 36 x 18 match does not have to fit
// in memory twice.
for (const size of sizes) {
  test(`a ${zoneSizeName(size)} room plays to its end, records and replays`, async () => {
    const kept = [];
    let header, last, count = 0, outOfOrder = null;
    const h = roomHarness({ startWriter: head => {
      header = structuredClone(head);
      return { append(state) {
        // Checked as each tick arrives, so omissions and repeats cannot cancel out in a total.
        if (state.tick !== count) outOfOrder ??= `tick ${state.tick} arrived where ${count} was due`;
        count++; last = state; if (state.tick % 200 === 0) kept.push({ state: structuredClone(state), commands: [] });
      }, mark() { return true; }, async finish(result) { return { id: head.id, ...result, frames: count }; } };
    } });
    const room = h.service.makeRoom(9, false, size), owner = h.joined(room, { ownerKey: room.ownerKey });
    owner.send({ type: 'start' });
    h.joined(room, { role: 'spectator', ownerKey: room.ownerKey });
    h.service.disconnect(owner.session);
    assert.ok(room.game.players.every(player => player.bot), 'every seat is played by a bot');
    // Each wake is one tick, and the match ends at its declared duration however play goes.
    const limit = room.content.durationTicks;
    for (let i = 0; i <= limit && !room.finished; i++) h.wake(TICK_MS);
    assert.equal(room.finished, true, `the match ended within its ${limit}-tick duration`);
    assert.equal(outOfOrder, null, 'every tick was recorded once, in order');
    assert.ok(count > 1000, 'the match recorded more than its opening');
    kept.push({ state: structuredClone(last), commands: [] });
    const archive = { ...header, frames: kept };
    assert.equal(recordingFit(archive), 'ok');
    assert.deepEqual([archive.map.width, archive.map.height], [room.game.map.width, room.game.map.height]);
    const timeline = createReplayTimeline(archive);
    assert.equal(timeline.at(last.tick).state.tick, last.tick);
    assert.equal(timeline.at(Math.floor(last.tick / 2)).state.tick % 200, 0, 'omitted ticks hold the frame before them');
  });
}
