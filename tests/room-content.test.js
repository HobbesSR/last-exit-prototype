import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness, generatedMap } from './helpers/room-harness.js';
import { defaultContent } from '../shared/simulation/content.ts';
import { describeContent, readPresentation } from '../shared/presentation.ts';
import { SCHEMA } from '../shared/recording.ts';
import { DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';

// Content this build does not ship, differing from the default in every displayed value.
function differing() {
  const content = structuredClone(defaultContent());
  content.id = 'test-content-b';
  content.weapons.pistol.name = 'Sidearm'; content.weapons.pistol.ammo = 7;
  content.kits.warden.name = 'Guard'; content.kits.warden.skill = 'Stomp';
  delete content.kits.striker;
  content.roster.contestants = ['Ada', 'Bo', 'Cy'];
  content.roster.gladiators = [{ name: 'ONE', kit: 'warden' }, { name: 'TWO', kit: 'specter' }];
  content.durationTicks = 3000; content.cellChargeTicks = 60;
  return content;
}

test('a room describes the content it pins, on every welcome and ready and once in the recording', async () => {
  const h = roomHarness({ content: differing, devTools: 'all' });
  let deliver;
  const room = h.service.makeRoom(9, false, DEFAULT_LIVE_ZONE_SIZE, new Promise(resolve => { deliver = resolve; }));
  try {
    const expected = describeContent(room.content);
    assert.equal(expected.contentId, 'test-content-b');
    assert.deepEqual(expected.capacity, { contestant: 3, gladiator: 2 });
    assert.deepEqual(expected.kits.map(k => k.id), ['warden', 'specter']);
    assert.deepEqual(room.presentation, expected);
    const carries = (message, what) => {
      assert.equal(message.contentId, 'test-content-b', what);
      assert.deepEqual(readPresentation(message.presentation, message.contentId), expected, what);
    };

    const owner = h.joined(room, { ownerKey: room.ownerKey, role: 'gladiator', kit: 'striker' });
    const spectator = h.joined(room, { ownerKey: room.ownerKey, role: 'spectator' });
    const dev = h.joined(room, { role: 'dev' });
    for (const [peer, what] of [[owner, 'player'], [spectator, 'spectator'], [dev, 'dev']]) {
      const welcome = peer.messages.find(m => m.type === 'welcome');
      assert.equal(welcome.ready, false, `${what} welcome before the map`);
      // A player is shown the waiting yard instead; anyone else nothing until the map exists.
      if (what !== 'player') assert.equal(welcome.map, null);
      carries(welcome, `${what} welcome`);
    }
    assert.equal(room.seats.player(owner.session.playerId).kit, 'warden', 'a kit the content lacks falls back to one it offers');
    assert.deepEqual(owner.messages.findLast(m => m.type === 'lobby').capacity, { contestant: 3, gladiator: 2 }, 'lobby capacity keeps its shape');

    deliver(generatedMap(9)); await room.ready;
    assert.equal(room.match.contentId, expected.contentId, 'the match runs the content the room described');
    assert.deepEqual(room.match.presentation, expected);
    assert.equal(room.game.content.weapons.pistol.ammo, 7);
    for (const [peer, what] of [[spectator, 'spectator'], [dev, 'dev']]) carries(peer.messages.findLast(m => m.type === 'ready'), `${what} ready on the map`);
    assert.ok(!owner.messages.some(m => m.type === 'ready'), 'a waiting player is not shown the match map yet');

    h.wake(50);
    const waiting = owner.messages.findLast(m => m.type === 'state');
    assert.equal(waiting.state.phase, 'waiting');
    owner.send({ type: 'start' });
    carries(owner.messages.findLast(m => m.type === 'ready'), 'player ready at the start');
    const late = h.joined(room, { ownerKey: room.ownerKey, role: 'spectator' });
    carries(late.messages.find(m => m.type === 'welcome'), 'a spectator joining a live match');

    const writer = h.writers.get(room.id);
    assert.equal(writer.header.schema, SCHEMA);
    assert.equal(writer.header.contentId, 'test-content-b');
    assert.deepEqual(writer.header.presentation, expected);
    h.wake(200);
    const states = [owner, spectator, dev].flatMap(p => p.messages.filter(m => m.type === 'state'));
    assert.ok(states.length > 0);
    for (const text of [JSON.stringify(writer.frames), JSON.stringify(states)]) {
      assert.ok(!text.includes('Sidearm') && !text.includes('"presentation"') && !text.includes('test-content-b'), 'frames and views carry no content tables');
    }
  } finally { await h.service.close(); }
});

test('rooms created by the default service describe the shipped content', async () => {
  const h = roomHarness({ reuseMaps: true }), { room, owner, writer } = h.live();
  try {
    const expected = describeContent(defaultContent());
    assert.deepEqual(room.presentation, expected);
    assert.deepEqual(writer.header.presentation, expected);
    const welcome = owner.messages.find(m => m.type === 'welcome');
    assert.equal(welcome.contentId, defaultContent().id);
    assert.deepEqual(welcome.presentation, expected);
  } finally { await h.service.close(); }
});
