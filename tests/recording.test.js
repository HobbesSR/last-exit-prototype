import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingFit, SCHEMA, MIN_SCHEMA, minimumReaderForMatch } from '../shared/recording.ts';
import { generatedMap, roomHarness } from './helpers/room-harness.js';
import { contentById, defaultContent } from '../shared/simulation/content.ts';
import { createGame, snapshot, PHYSICS_VERSION } from '../shared/simulation.ts';
import { createReplayTimeline } from '../public/replay-timeline.js';

const playable = { map: { obstacles: [{ id: 'o0' }] } };

// Recordings from before schema 10 (pre-chain-map and pre-physics) are refused, while supported
// schemas keep playing with whatever roster their frames record without substituting defaults.
test('pre-physics and pre-chain-map schemas are refused, and supported schemas retain their recorded roster', () => {
  const content = contentById('content-7');
  const game = createGame(9, generatedMap(), { ...content, roster: { ...content.roster, gladiators: content.roster.gladiators.slice(0, 2) } });
  const state = JSON.parse(JSON.stringify(snapshot(game)));
  for (const oldSchema of [undefined, 0, 3, 4, 9]) {
    assert.equal(recordingFit({ version: 'last-exit-0.7', ...(oldSchema !== undefined ? { schema: oldSchema } : {}), minSchema: 0, contentId: 'content-1', map: game.map }), 'too-old');
  }
  const archive = { version: 'last-exit-0.8-physics', schema: MIN_SCHEMA, minSchema: MIN_SCHEMA, contentId: content.id,
    map: game.map, frames: [{ state, commands: [] }] };
  assert.equal(recordingFit(archive), 'ok');
  const timeline = createReplayTimeline(archive);
  assert.equal(timeline.roster.filter(p => p.role === 'gladiator').length, 2);
  assert.deepEqual(timeline.at(0).state, state, 'playback retains the recorded roster without substituting defaults');
});

test('a recording states what it is and the reader decides, refusing formats below the schema floor', () => {
  assert.equal(recordingFit({ ...playable, schema: SCHEMA, minSchema: MIN_SCHEMA }), 'ok');
  assert.equal(recordingFit({ ...playable, schema: MIN_SCHEMA, minSchema: MIN_SCHEMA }), 'ok');
  // Archives missing `schema` or below MIN_SCHEMA (schemas 0..9) read below the floor and are refused.
  assert.equal(recordingFit(playable), 'too-old');
  assert.equal(recordingFit({ ...playable, schema: MIN_SCHEMA - 1, minSchema: 0 }), 'too-old');
  assert.equal(recordingFit({ map: {} }), 'too-old');
  assert.equal(recordingFit({ schema: SCHEMA }), 'ok');
  assert.equal(recordingFit({ ...playable, schema: SCHEMA, minSchema: 0 }), 'ok');
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

test('malformed or hostile version fields fall back safely rather than throwing', () => {
  for (const bad of [null, undefined, 'nine', Number.NaN, Infinity, -3, 1.5, {}, []]) {
    assert.equal(recordingFit({ ...playable, schema: bad, minSchema: bad }), 'too-old', `schema ${String(bad)} reads below MIN_SCHEMA`);
  }
  assert.equal(recordingFit(null), 'too-old');
  assert.equal(recordingFit(undefined), 'too-old');
});

test('the server stamps every recording with the schema pair its readers check', async () => {
  const harness = roomHarness({ reuseMaps: true });
  const { writer } = await harness.live(9);
  assert.equal(writer.header.schema, SCHEMA);
  // The shipped rules run on the physics engine, so the floor is the physics reader's, matching MIN_SCHEMA.
  assert.equal(writer.header.minSchema, minimumReaderForMatch(writer.header.map, true));
  assert.equal(writer.header.minSchema, MIN_SCHEMA);
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
