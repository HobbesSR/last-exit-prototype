import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics, setInput, snapshot, step } from '../shared/simulation.ts';
import { startGame } from '../shared/simulation/tick.ts';
import { contentById } from '../shared/simulation/content.ts';
import { openArea } from './helpers/arena.js';

function fixture(contestants = 1) {
  const map = { seed: 439, width: 800, height: 800,
    playableArea: openArea(800, 800, 100),
    buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: Array.from({ length: contestants }, (_, i) => ({ x: 250 + i * 80, y: 400 })),
    hunterSpawns: [{ x: 150, y: 400 }] };
  const content = structuredClone(contentById('content-6'));
  content.roster = { contestants: Array.from({ length: contestants }, (_, i) => `C${i}`),
    gladiators: [{ name: 'G', kit: 'hook' }] };
  return { map, content };
}

async function game(parts = fixture()) {
  const s = await createGame(439, parts.map, parts.content);
  for (const p of s.players) p.bot = false;
  return s;
}

const cast = s => assert.ok(setInput(s, 'g0', { seq: s.tick + 1, skill: true, aim: 0 }));
const advance = (s, count) => { for (let i = 0; i < count; i++) step(s); };

test('a hook flies, attaches on impact and clears when the caster warps', async () => {
  const s = await game();
  try {
    cast(s); step(s);
    const flight = snapshot(s).hookFlights[0];
    assert.ok(flight);
    advance(s, 2);
    const attached = snapshot(s);
    assert.equal(attached.hookFlights.length, 0);
    assert.equal(attached.tethers[0]?.id, flight.id);
    assert.ok(startGame(s).boundary.teleport('g0', [150, 550]));
    step(s);
    assert.deepEqual(snapshot(s).tethers, []);
  } finally { disposePhysics(s); }
});

test('the hook stops at a playable-mask void before reaching the other side', async () => {
  const parts = fixture();
  parts.map.spawns[0].x = 450;
  parts.map.playableArea.rows = parts.map.playableArea.rows.map(row => ({ ...row, runs: [[0, 3], [4, 8]] }));
  const s = await game(parts);
  try {
    cast(s); step(s);
    assert.equal(snapshot(s).hookFlights.length, 1);
    advance(s, 8);
    assert.deepEqual(snapshot(s).hookFlights, []);
    assert.deepEqual(snapshot(s).tethers, []);
  } finally { disposePhysics(s); }
});

test('the first intervening opponent takes the tether', async () => {
  const s = await game(fixture(2));
  try {
    cast(s); advance(s, 4);
    const frame = snapshot(s);
    assert.equal(frame.tethers.length, 1);
    const target = frame.bodies.find(body => body.id === frame.tethers[0].b);
    assert.equal(frame.players[target.owner.playerIdx].id, 'c0');
  } finally { disposePhysics(s); }
});
