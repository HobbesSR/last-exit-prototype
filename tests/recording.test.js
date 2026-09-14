import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingFit, SCHEMA, MIN_SCHEMA } from '../shared/recording.ts';
import { roomHarness } from './helpers/room-harness.js';

const playable = { map: { obstacles: [{ id: 'o0' }] } };

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

test('the server stamps every recording with the schema pair its readers check', () => {
  const harness = roomHarness();
  const { writer } = harness.live(9);
  assert.equal(writer.header.schema, SCHEMA);
  assert.equal(writer.header.minSchema, MIN_SCHEMA);
  assert.equal(recordingFit(writer.header), 'ok', 'what the writer produces is what the reader accepts');
});
