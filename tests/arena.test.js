import test from 'node:test';
import assert from 'node:assert/strict';
import { arena } from './helpers/arena.js';
import { gunfight, run, stage } from './helpers/scenario.js';
import { canOccupy } from '../shared/movement.ts';
import { contentById, legacyContent } from '../shared/simulation/content.ts';

// Test arenas and the scenario layer (31 "Test arenas", #697).

test('an arena is playable everywhere, so a point stays where it is put', () => {
  const { map } = arena({ cols: 10, rows: 4 });
  assert.deepEqual([map.width, map.height], [1920, 768]);
  for (const at of [{ x: 20, y: 20 }, { x: 1900, y: 20 }, { x: 960, y: 750 }]) assert.ok(canOccupy(map, at.x, at.y, 14), `${at.x},${at.y}`);
});

test('a corridor walls its regions apart but for one gap each, crossed at the gaps', () => {
  const { map, crossings } = arena({ cols: 8, rows: 3, corridor: { gaps: [2] } });
  assert.deepEqual(crossings, [{ x: 768, y: 480 }]);
  assert.ok(canOccupy(map, 768, 480, 14), 'the gap is open');
  assert.ok(!canOccupy(map, 768, 96, 14), 'the wall is not');
  assert.throws(() => arena({ cols: 7, rows: 3, corridor: { gaps: [0] } }), RangeError);
  for (const gap of [-1, 3, 1.5]) assert.throws(() => arena({ cols: 8, rows: 3, corridor: { gaps: [gap] } }), RangeError, `gap ${gap}`);
});

test('scattered crates depend on the seed alone', () => {
  const crates = seed => arena({ cols: 12, rows: 6, scatter: { density: 0.3, seed } }).map.obstacles;
  assert.deepEqual(crates(7), crates(7));
  assert.notDeepEqual(crates(7), crates(8));
  assert.ok(crates(7).length > 10 && crates(7).length < 35, `${crates(7).length} of 72 cells`);
  // Every cell would hold one, but none beside a corridor's gap.
  const full = arena({ cols: 8, rows: 3, corridor: { gaps: [1] }, scatter: { density: 1, seed: 7 } }).map.obstacles.filter(o => o.kind === 'crate');
  assert.deepEqual([full.length, full.some(c => c.id === 'crate-3-1' || c.id === 'crate-4-1'), 'cell' in full[0]], [22, false, false]);
});

test('a stage holds exactly the actors asked for, where they were put', () => {
  const { map } = arena({ cols: 10, rows: 4 });
  const actors = [{ role: 'gladiator', kit: 'specter', x: 300, y: 400 }, { role: 'contestant', bot: false, x: 1500, y: 300 }, { role: 'contestant', x: 900, y: 200 }];
  const { s, players } = stage(map, { content: legacyContent(), actors });
  assert.equal(s.players.length, 3);
  assert.deepEqual(players.map(p => [p.role, p.kit === 'specter', p.bot, p.x, p.y]),
    [['gladiator', true, true, 300, 400], ['contestant', false, false, 1500, 300], ['contestant', false, true, 900, 200]]);
});

test('a gladiator that hears a gunfight goes straight to it; one that only hears does not', async () => {
  // At about 8 units a tick on open ground: the floor under any real trip (42.22).
  const distance = 4000, floor = (distance - 400) / 8;
  const heard = await gunfight(distance, { content: contentById('content-9'), ticks: 600 });
  assert.ok(heard >= floor && heard < floor * 1.1, `arrived on tick ${heard}`);
  assert.equal(await gunfight(distance, { content: contentById('content-8'), ticks: 600 }), null);
  // One shot is enough: the lead outlasts the cue.
  assert.ok(await gunfight(distance, { content: contentById('content-9'), until: 1, ticks: 600 }) < floor * 1.1);
});

test('an event without a period acts every tick, and one without content stages on the legacy mover', () => {
  const { s } = stage(arena({ cols: 4, rows: 2 }).map, { actors: [{ role: 'contestant', bot: false, x: 300, y: 200 }] });
  assert.equal(s.content.roster.contestants.length, 1);
  assert.ok(s.content.weapons, 'a whole content');
  const ticks = [];
  run(s, { ticks: 5, events: [{ act: s => ticks.push(s.tick) }, { from: 2, until: 3, act: s => ticks.push(-s.tick) }] });
  assert.deepEqual(ticks, [0, 1, 2, -2, 3, 4]);
});
