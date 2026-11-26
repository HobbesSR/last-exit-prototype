import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics, step } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { contentById } from '../shared/simulation/content.ts';
import { arena, openArea } from './helpers/arena.js';
import { now, stagePhysics } from './helpers/scenario.js';

// Local avoidance of actors and pushable props, by the core's planner, which runs in every started game: each case
// starts a match on an 800 x 800 arena and reads what the bot's committed commands and the poses do.

const content = () => ({ ...contentById('content-6'), discovery: false });
const CORRIDOR = [{ id: 'top', x: 100, y: 100, w: 500, h: 280 }, { id: 'bottom', x: 100, y: 420, w: 500, h: 280 }];
const field = ({ props, obstacles, items } = {}) => arena({ cols: 8, rows: 8, cellSize: 100, seed: 448, obstacles, items,
  physicsProps: props, entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 } }).map;

// The shipped fixture of the rows that build a game by hand.
function fixture({ spawns = [{ x: 150, y: 400 }], gladiator = false, props = [], obstacles = [], items = [] } = {}) {
  const map = { seed: 448, width: 800, height: 800,
    playableArea: openArea(800, 800, 100),
    buildings: [], obstacles, gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items, traps: [], physicsProps: props,
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 }, spawns,
    hunterSpawns: [{ x: 300, y: 400 }] };
  const content = structuredClone(contentById('content-6'));
  content.roster = { contestants: spawns.map((_, i) => `C${i}`), gladiators: gladiator ? [{ name: 'G', kit: 'warden' }] : [] };
  content.discovery = false;
  return { map, content };
}
async function game(options) {
  const { map, content } = fixture(options), s = await createGame(448, map, content);
  for (const p of s.players) p.bot = false;
  return s;
}
/** A started match on `map` with `actors`, which `arrange` may adjust first, disposed of after `t`. */
async function play(t, map, actors, arrange) {
  const { s, players } = await stagePhysics(map, { seed: 448, content: content(), actors });
  arrange?.(players);
  t.after(() => disposePhysics(s));
  return { s, players, ...startGame(s) };
}
const bot = (x, y = 400) => ({ role: 'contestant', x, y });
const standing = (role, x, y = 400, extra) => ({ role, bot: false, x, y, ...extra });
/** Step the match `ticks` times, calling `each(tick)` after every step. */
function run(s, ticks, each = () => {}) { for (let i = 0; i < ticks; i++) each(stepGame(s)); }
const cell = (x, y = 400, id = 'goal-cell') => ({ id, kind: 'cell', charge: 0, x, y });
/** The movement the core committed for `p`'s bot on a completed tick. */
const movement = (tick, match, p) => {
  const actor = match.ids.actorOfPlayer.get(p.id);
  return tick.inbound.find(row => row.type === 'command' && row.command.source === 'bot' && row.command.actor === actor).command.input.movement;
};

test('the core bot detours around a rotated crate and reaches the goal', async t => {
  const { s, players: [p] } = await play(t, field({ props: [{ id: 'crate', profile: 'crate', x: 300, y: 400, angle: Math.PI / 4 }], items: [cell(480)] }), [bot(150)]);
  let deviated = false;
  run(s, 150, () => { deviated ||= Math.abs(now(s, p).y - 400) > 5; });
  assert.ok(deviated, 'the crate caused a detour');
  assert.ok(now(s, p).x > 470, `the bot reached the goal past the crate: ${now(s, p).x}`);
});

test('an actor in the way causes a detour, while loot underfoot leaves the straight path intact', async t => {
  const blocked = await play(t, field({ items: [cell(480)] }), [bot(150), standing('contestant', 300)]);
  const [p, g] = blocked.players;
  let deviated = false;
  run(blocked.s, 120, () => { deviated ||= Math.abs(now(blocked.s, p).y - 400) > 5; });
  assert.ok(deviated, 'the bot went round the actor');
  assert.ok(now(blocked.s, p).x > now(blocked.s, g).x + 30, 'and passed it');
  // The loot is only a goal: the bot walks straight to it.
  const loot = await play(t, field({ items: [cell(220, 400, 'sensor')] }), [bot(150)]);
  let straight = true;
  run(loot.s, 30, () => { straight &&= Math.abs(now(loot.s, loot.players[0]).y - 400) <= 5; });
  assert.ok(straight, 'a loot item does not bend the path');
  assert.ok(now(loot.s, loot.players[0]).x > 190, 'it advanced toward the loot');
});

test('the core bot planner drives an actual contestant around a crate toward a cell', async () => {
  const s = await game({ props: [{ id: 'crate', profile: 'crate', x: 300, y: 400, angle: Math.PI / 6 }],
    items: [{ id: 'goal-cell', kind: 'cell', charge: 0, x: 500, y: 400 }] });
  try {
    const p = s.players[0];
    p.bot = true;
    let deviated = false;
    for (let i = 0; i < 100; i++) {
      step(s);
      if (Math.abs(now(s, p).y - 400) > 5) deviated = true;
    }
    assert.ok(deviated, 'bot chose an actual lateral motor path');
    assert.ok(now(s, p).x > 390, `bot advanced toward the cell: ${now(s, p).x}`);
  } finally { disposePhysics(s); }
});

test('a narrow corridor queues a bot behind an actor without tunneling, then it resumes when clear', async t => {
  const { s, players: [p, blocker], boundary } = await play(t, field({ obstacles: CORRIDOR, items: [cell(500)] }), [bot(200), standing('contestant', 300)]);
  run(s, 40);
  assert.ok(now(s, p).x < now(s, blocker).x - 20, `the bot waited outside the blocker: ${now(s, p).x}`);
  assert.ok(now(s, blocker).x - now(s, p).x < 30, 'it came to the queue instead of stopping at observation range');
  assert.ok(now(s, p).y > 390 && now(s, p).y < 410, `it stayed inside the corridor: ${now(s, p).y}`);
  assert.ok(boundary.teleport(blocker.id, [650, 500]));
  run(s, 60);
  assert.ok(now(s, p).x > 390, `it resumed once the corridor cleared: ${now(s, p).x}`);
});

test('hidden actors and wall-concealed props do not alter local plans', async t => {
  // Each match's bot walks east toward a cell at 480; what it commands over its first ticks is the plan.
  const commands = async (actors, options = {}, arrange) => {
    const { s, players: [p], match } = await play(t, field({ items: [cell(480)], ...options }), actors, arrange), out = [];
    run(s, 12, tick => out.push(movement(tick, match, p)));
    return out;
  };
  const alone = await commands([bot(150)]);
  assert.deepEqual(await commands([bot(150), standing('contestant', 300)], {}, ([, other]) => { other.cloak = 1000; }), alone, 'a cloaked actor is not avoided');
  assert.notDeepEqual(await commands([bot(150), standing('contestant', 300)]), alone, 'a visible one is');
  // A crate behind a wall that sight does not pass is not avoided: the bot plans as if it were not there.
  const wall = [{ id: 'wall', x: 230, y: 300, w: 4, h: 200 }], crate = [{ id: 'hidden', profile: 'crate', x: 300, y: 400 }];
  assert.notDeepEqual(await commands([bot(150)], { props: crate }), alone, 'a crate in the open is avoided');
  assert.deepEqual(await commands([bot(150)], { obstacles: wall, props: crate }), await commands([bot(150)], { obstacles: wall }), 'a crate behind a wall is not seen');
});

test('a game is refused without dynamic navigation', async () => {
  const content = structuredClone(contentById('content-6'));
  delete content.dynamicNavigation;
  await assert.rejects(() => createGame(448, field(), content), /dynamic navigation/);
});

test('a teleport discards a stale detour and the bot plans toward its goal from the new spot', async t => {
  const { s, players: [p], match, boundary } = await play(t, field({ props: [{ id: 'crate', profile: 'crate', x: 300, y: 400 }], items: [cell(480)] }), [bot(150)]);
  let detoured = false;
  run(s, 14, () => { detoured ||= Math.abs(now(s, p).y - 400) > 5; });
  assert.ok(detoured, 'the bot is mid-detour');
  assert.ok(boundary.teleport(p.id, [150, 650]));
  // The warp lands in its tick and the core clears the route there, so the bot plans afresh from the next.
  run(s, 3);
  const [dx, dy] = movement(stepGame(s), match, p);
  const toGoal = [480 - now(s, p).x, 400 - now(s, p).y], length = Math.hypot(...toGoal);
  assert.ok((dx * toGoal[0] + dy * toGoal[1]) / length > 0.9, `it heads for the goal from where it stands: ${[dx, dy]}`);
});
