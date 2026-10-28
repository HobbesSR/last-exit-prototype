import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneSizeName } from '../../map/live.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { createMatchFor } from '../../server/match.js';
import { PHYSICS_NAVIGATION_VERSION } from '../../shared/simulation/physics-runtime.ts';
import { playsToItsEnd, selectedSizes } from '../helpers/room-sizes.js';

// The shipped default (#523) is physics content, so this is the room a player gets. Sizes follow ROOM_SIZES like
// room-sizes.test.js. The 36x18 case found that the lab's item capacity of 4096 could not hold a map of 8,608 items.
for (const size of selectedSizes()) {
  test(`a ${zoneSizeName(size)} physics room plays to its end, records and replays`, async () => {
    const { room, header } = await playsToItsEnd(size, { content: defaultContent, matchFactory: createMatchFor });
    assert.equal(room.match.hasPhysics, true, 'the default runs on the physics engine');
    assert.equal(header.contentId, defaultContent().id);
    assert.equal(header.version, PHYSICS_NAVIGATION_VERSION, 'and the recording names the physics rules it ran');
    assert.ok(room.game.map.items.length <= defaultContent().itemInstances.groundCapacity, 'the map fits the content\'s ground capacity');
  });
}
