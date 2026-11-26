import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { contentById } from '../shared/simulation/content.ts';
import { visiblePoint, visibleTo } from '../shared/simulation/visibility.ts';
import { VISION } from '../shared/sight.ts';
import { arena, openArea } from './helpers/arena.js';
import { now, stagePhysics } from './helpers/scenario.js';

function fixture({ spawns = [{ x: 150, y: 400 }], gladiator = false, obstacles = [], items = [] } = {}) {
  const map = { seed: 448, width: 800, height: 800,
    playableArea: openArea(800, 800, 100),
    buildings: [], obstacles, gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items, traps: [], physicsProps: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 }, spawns,
    hunterSpawns: [{ x: 300, y: 400 }] };
  const content = structuredClone(contentById('content-6'));
  content.roster = { contestants: spawns.map((_, i) => `C${i}`), gladiators: gladiator ? [{ name: 'G', kit: 'warden' }] : [] };
  content.discovery = false;
  return { map, content };
}

test('point sight applies strict range, roof concealment, and cover; actor exceptions remain separate', async () => {
  const { map, content } = fixture({ gladiator: true });
  const s = await createGame(448, map, content);
  try {
    const viewer = s.players.find(p => p.role === 'gladiator');
    const actor = s.players.find(p => p.role === 'contestant');
    Object.assign(viewer, { x: 100, y: 100 });
    Object.assign(actor, { x: 200, y: 100 });
    assert.equal(visiblePoint(s, viewer, actor), true);
    assert.equal(visiblePoint(s, viewer, { x: viewer.x + VISION, y: viewer.y }), false, 'range boundary is strict');

    s.map = { ...s.map, roofs: [{ id: 'roof', groupId: 'roof', origin: { x: 180, y: 80 },
      bounds: { x: 180, y: 80, w: 40, h: 40 }, cellSize: 40, cells: [{ x: 0, y: 0 }] }] };
    assert.equal(visiblePoint(s, viewer, actor), false, 'a target under a different roof is concealed');
    viewer.x = 190; viewer.y = 100;
    assert.equal(visiblePoint(s, viewer, actor), true, 'the same roof is visible');

    s.map = { ...s.map, roofs: [], obstacles: [{ id: 'wall', x: 150, y: 50, w: 20, h: 100 }] };
    viewer.x = 100;
    assert.equal(visiblePoint(s, viewer, actor), false, 'solid cover blocks point sight');
    assert.equal(visibleTo(s, viewer, actor), false);
    actor.revealed = 1;
    assert.equal(visibleTo(s, viewer, actor), true, 'gladiator reveal outranks cover');
    actor.revealed = 0;
    actor.cloak = 1;
    assert.equal(visibleTo(s, viewer, actor), false, 'cloak hides an active actor');
    assert.equal(visibleTo(s, actor, actor), true, 'self stays visible');
    actor.status = 'eliminated';
    assert.equal(visibleTo(s, viewer, actor), true, 'inactive actors keep their legacy exception');
  } finally { disposePhysics(s); }
});

test('a bot that queues behind another with no enemy keeps the heading it walked with', async t => {
  // A corridor running south, 40 wide: a bot walks down it toward a cell and stops behind a blocker that stands in it.
  const { map } = arena({ cols: 8, rows: 8, cellSize: 100, seed: 448, entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    obstacles: [{ id: 'west', x: 100, y: 100, w: 280, h: 500 }, { id: 'east', x: 420, y: 100, w: 280, h: 500 }],
    items: [{ id: 'goal-cell', kind: 'cell', charge: 0, x: 400, y: 500 }] });
  const { s, players: [bot, blocker] } = await stagePhysics(map, { seed: 448, content: { ...contentById('content-6'), discovery: false },
    actors: [{ role: 'contestant', x: 400, y: 160 }, { role: 'contestant', bot: false, x: 400, y: 260 }] });
  t.after(() => disposePhysics(s));
  const { match } = startGame(s), actor = match.ids.actorOfPlayer.get(bot.id);
  let queued = null;
  for (let i = 0; i < 120 && !queued; i++) {
    const heading = now(s, bot).heading;
    const tick = stepGame(s);
    const { input } = tick.inbound.find(row => row.type === 'command' && row.command.source === 'bot' && row.command.actor === actor).command;
    if (input.movement.every(component => component === 0)) queued = { input, heading };
  }
  assert.ok(queued, 'the bot queued behind the blocker');
  assert.ok(now(s, blocker).y - now(s, bot).y < 40, 'it queued at contact, not far short of it');
  assert.ok(queued.heading > 1, 'it had been walking south');
  assert.equal(queued.input.aim, queued.heading, 'its queued command keeps the heading it had');
});
