import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld } from '../tools/physics/rapier.mjs';

const headOnScene = () => ({
  bodies: [
    { id: 'a-left', kind: 'prop', x: -4, y: 0, vx: 100, radius: 5, mass: 1 },
    { id: 'b-right', kind: 'prop', x: 4, y: 0, vx: -100, radius: 5, mass: 1 },
  ],
  joints: [],
});

test('contacts reports positive head-on impulse with stable a-to-b normal', async () => {
  const world = await createWorld(headOnScene());
  try {
    world.step(0.0125);
    const contacts = world.contacts();
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].a, 'a-left');
    assert.equal(contacts[0].b, 'b-right');
    assert.ok(contacts[0].nx > 0.99, `expected left-to-right normal, got ${contacts[0].nx}`);
    assert.ok(Math.abs(contacts[0].ny) < 1e-6);
    assert.ok(contacts[0].impulse > 90 && contacts[0].impulse < 110,
      `expected 100 world-unit impulse after native scaling, got ${contacts[0].impulse}`);
  } finally { world.dispose(); }
});

test('contacts flips normal for reversed lexical ids and insertion order', async () => {
  const world = await createWorld({ bodies: [
    { id: 'b-left', kind: 'prop', x: -4, y: 0, vx: 100, radius: 5, mass: 1 },
    { id: 'a-right', kind: 'prop', x: 4, y: 0, vx: -100, radius: 5, mass: 1 },
  ], joints: [] });
  try {
    world.step(0.0125);
    const [contact] = world.contacts();
    assert.equal(contact.a, 'a-right');
    assert.equal(contact.b, 'b-left');
    assert.ok(contact.nx < -0.99, `expected right-to-left normal, got ${contact.nx}`);
    assert.ok(Math.abs(contact.ny) < 1e-6);
    assert.ok(contact.impulse > 0);
  } finally { world.dispose(); }
});

test('contacts reports dynamic obstacle normal under motor pressure', async () => {
  const world = await createWorld({ bodies: [
    { id: 'a-body', kind: 'prop', x: 0, y: 0, radius: 5, mass: 1 },
    // A very heavy dynamic body gives Rapier a solver impulse to report;
    // CCD impacts against fixed bodies are position-corrected with zero solver impulse.
    { id: 'z-wall', kind: 'prop', x: 8, y: 0, radius: 5, mass: 1000000 },
  ], joints: [] });
  try {
    world.motor('a-body', { x: 100, y: 0, accel: 1000 });
    let contact;
    for (let i = 0; i < 5; i++) {
      world.step(0.05);
      contact ??= world.contacts().find(row => row.a === 'a-body' && row.b === 'z-wall');
    }
    assert.ok(contact, 'motor pressure should produce a contact impulse');
    assert.ok(contact.nx > 0.99, `expected body-to-wall normal, got ${contact.nx}`);
    assert.ok(contact.impulse > 0);
  } finally { world.dispose(); }
});

test('contacts omits separated pairs and returns repeatable detached rows', async () => {
  const scene = { bodies: [
    { id: 'a', kind: 'prop', x: 0, y: 0, radius: 2, vx: 30 },
    { id: 'b', kind: 'prop', x: 4, y: 0, radius: 2, vx: -30 },
    { id: 'c', kind: 'prop', x: 100, y: 0, radius: 2 },
  ], joints: [] };
  const first = await createWorld(scene), second = await createWorld(scene);
  try {
    assert.deepEqual(first.contacts(), []);
    first.step(0.0125); second.step(0.0125);
    const rows = first.contacts();
    assert.ok(rows.length > 0);
    assert.deepEqual(rows, second.contacts());
    rows[0].a = 'changed'; rows[0].impulse = -1;
    assert.deepEqual(first.contacts(), second.contacts(), 'returned rows must be detached');
  } finally { first.dispose(); second.dispose(); }
  assert.throws(() => first.contacts(), /disposed/);
});
