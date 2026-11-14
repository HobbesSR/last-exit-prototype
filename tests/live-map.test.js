import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultContent } from '../shared/simulation/content.ts';
import { createGame, disposePhysics, setInput, step } from '../shared/simulation.ts';
import { generatedMap } from './helpers/room-harness.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// The pregenerated room arena, seed 9's live map, costs no generation. The cases that read seed 1's
// built chain are in tests/slow/live-map.test.js: building a map is slow-tier work (31, #1071).
const live = () => generatedMap(9);

test('live sites allow charging, extraction, and safe hunter redeployment', async t => {
  const map = structuredClone(live()), game = await createGame(1, map, defaultContent()), contestant = game.players[0];
  t.after(() => disposePhysics(game));
  for (const player of game.players) player.bot = false;
  game.map.traps = [];
  Object.assign(contestant, map.chargers[0]);
  contestant.inventory[0] = { kind: 'cell', charge: 0 };
  const press = (player, input) => { setInput(game, player.id, { seq: player.lastSeq + 1, ...input }); step(game); };
  press(contestant, { interact: true });
  for (let i = 1; i < game.content.cellChargeTicks; i++) step(game);
  assert.equal(contestant.inventory[0].charge, game.content.cellChargeTicks);
  Object.assign(contestant, map.exit);
  press(contestant, { interact: true });
  assert.equal(contestant.status, 'escaped');
  assert.equal(game.slots, 2);
  const hunter = game.players.find(player => player.role === 'gladiator');
  hunter.status = 'respawning'; hunter.respawnAt = game.tick + 1;
  step(game);
  assert.equal(hunter.status, 'active');
  // On a station, to the engine's single-precision positions.
  assert.ok(map.stations.some(site => distance(hunter, site) < 0.01));
});
