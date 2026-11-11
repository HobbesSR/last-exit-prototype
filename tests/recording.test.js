import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingFit, SCHEMA, MIN_SCHEMA, minimumReaderForMap, minimumReaderForMatch } from '../shared/recording.ts';
import { generatedMap, roomHarness } from './helpers/room-harness.js';
import { contentById, defaultContent } from '../shared/simulation/content.ts';
import { createGame, snapshot, PHYSICS_VERSION } from '../shared/simulation.ts';
import { createReplayTimeline } from '../public/replay-timeline.js';

const playable = { map: { obstacles: [{ id: 'o0' }] } };

// content-1 seated two hunters and content-2 three. Both sets are retired (#920), so their frames are built from the
// shipped set with each one's roster; what is checked is that playback keeps the recorded roster.
test('both content rosters play from their recorded frames under the same schema and rules', () => {
  for (const [contentId, hunters] of [['content-1', 2], ['content-2', 3]]) {
    const content = contentById('content-7');
    const game = createGame(9, generatedMap(), { ...content, roster: { ...content.roster, gladiators: content.roster.gladiators.slice(0, hunters) } });
    const state = JSON.parse(JSON.stringify(snapshot(game)));
    const archive = { version: 'last-exit-0.7', schema: 3, minSchema: 0, contentId,
      map: game.map, frames: [{ state, commands: [] }] };
    assert.equal(recordingFit(archive), 'ok');
    const timeline = createReplayTimeline(archive);
    assert.equal(timeline.roster.filter(p => p.role === 'gladiator').length, hunters);
    assert.deepEqual(timeline.at(0).state, state, 'playback retains the recorded roster without substituting defaults');
  }
});

test('a recording states what it is and the reader decides, with legacy archives still playable', () => {
  assert.equal(recordingFit({ ...playable, schema: SCHEMA, minSchema: MIN_SCHEMA }), 'ok');
  // Archives written before the schema field carry neither number. They must keep playing, which is
  // why the floor is zero rather than one: introducing the field cannot retire what already exists.
  assert.equal(recordingFit(playable), 'ok');
  // The grid prototype has to be recognised by its contents, having no schema to check. The probe
  // is for the obstacle field's presence, not its length: a vector map with nothing in it is still
  // a vector map, and this preserves exactly what the client checked before the schema existed.
  assert.equal(recordingFit({ map: {} }), 'pre-vector');
  assert.equal(recordingFit({ schema: SCHEMA }), 'pre-vector');
  assert.equal(recordingFit({ map: { obstacles: [] } }), 'ok');
});

// The reason the header carries two numbers instead of one. A later build that adds a field without
// breaking older readers raises `schema` alone, and this build keeps playing its recordings; only a
// genuinely breaking change raises `minSchema` and shuts the door. One number could not say that,
// and widening compatibility afterwards would have meant migrating the format a second time.
test('an additive future recording stays readable, and only a breaking one is refused', () => {
  assert.equal(recordingFit({ ...playable, schema: SCHEMA + 40, minSchema: MIN_SCHEMA }), 'ok');
  assert.equal(recordingFit({ ...playable, schema: SCHEMA + 40, minSchema: SCHEMA + 1 }), 'too-new');
  assert.equal(recordingFit({ ...playable, schema: SCHEMA + 40, minSchema: SCHEMA }), 'ok', 'a reader exactly at the declared floor still reads it');
});

test('malformed or hostile version fields fall back to the oldest meaning rather than throwing', () => {
  for (const bad of [null, undefined, 'nine', Number.NaN, Infinity, -3, 1.5, {}, []]) {
    assert.equal(recordingFit({ ...playable, schema: bad, minSchema: bad }), 'ok', `schema ${String(bad)} reads as pre-schema`);
  }
  assert.equal(recordingFit(null), 'pre-vector');
  assert.equal(recordingFit(undefined), 'pre-vector');
});

test('the server stamps every recording with the schema pair its readers check', async () => {
  const harness = roomHarness({ reuseMaps: true });
  const { writer } = await harness.live(9);
  assert.equal(writer.header.schema, SCHEMA);
  // The shipped rules run on the physics engine, so the floor is the physics reader's; it is above the masked-map floor, which the map still needs.
  assert.equal(writer.header.minSchema, minimumReaderForMatch(writer.header.map, true));
  assert.equal(minimumReaderForMap(writer.header.map), 4, 'masked maps require a reader that draws their playable area');
  assert.ok(writer.header.minSchema >= minimumReaderForMap(writer.header.map));
  assert.equal(recordingFit(writer.header), 'ok', 'what the writer produces is what the reader accepts');
});

test('a recording names the content set its match was pinned to', async () => {
  const harness = roomHarness({ reuseMaps: true });
  const { writer } = await harness.live(9);
  // `version` says which rules produced the recording; this says which numbers they ran over. A
  // reader looking at an old archive needs both to say what its contents meant.
  assert.equal(writer.header.contentId, defaultContent().id, 'the harness runs the shipped content');
  assert.equal(writer.header.version, PHYSICS_VERSION, 'and the physics rules alongside it');
});
