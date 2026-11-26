import { itemId } from './helpers/item-identity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, setInput, snapshot, playerView } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { collectBotIntent } from '../shared/simulation/bots.ts';
import { tickAllowance } from '../shared/simulation/bot-routes.ts';
import { canOccupy, sweptClear } from '../shared/movement.ts';
import { cellIndexAt, createDiscovery, discover, attachDiscovery } from '../shared/discovery.ts';
import { contentById, defaultContent } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';
import { generatedMap } from './helpers/room-harness.js';
import { everywhere, now, stagePhysics } from './helpers/scenario.js';
import { initCoreSight } from '../shared/sight-core.ts';
import { adoptPackedTiles } from '../shared/free-space.ts';
import { createKnowledgePlanner, packedTilesFor } from '../shared/navigation/knowledge.ts';

// Bots observe through the core's sight, as a game's do (sightOf).
const sight = await initCoreSight();

// Contestant bots know what they have discovered, like people (15, #230). On the shipped content and its
// engine (#920), which plans over tiles with route repair. Cases that only plan collect a bot's intent
// on a bare game record and never step.

const openMap = (items, buildings = []) => arena({ cols: 10, rows: 5, items, buildings }).map;

test('the sight that discovers cells remembers the items it sees, not ones under a roof', () => {
  const building = { id: 'b1', nodeId: 'node-1', x: 384, y: 192, w: 192, h: 192 };
  const map = openMap([{ id: 'in-view', kind: 'cell', x: 200, y: 320 }, { id: 'roofed', kind: 'cell', x: 480, y: 288 }], [building]);
  const memory = createDiscovery();
  discover(sight, memory, map, { x: 200, y: 200 });
  assert.equal(memory.items, undefined, 'only bots keep item memory');
  discover(sight, memory, map, { x: 200, y: 200 }, undefined, true);
  assert.deepEqual([...memory.items.keys()], ['in-view']);
});

test('a remembered item is forgotten once its spot is seen empty, and kept while out of sight', () => {
  const building = { id: 'b1', nodeId: 'node-1', x: 384, y: 192, w: 192, h: 192 };
  const map = openMap([], [building]);
  const memory = createDiscovery();
  memory.items = new Map([['taken', { id: 'taken', kind: 'cell', x: 200, y: 320 }], ['roofed', { id: 'roofed', kind: 'cell', x: 480, y: 288 }]]);
  discover(sight, memory, map, { x: 200, y: 200 }, undefined, true);
  assert.deepEqual([...memory.items.keys()], ['roofed']);
});

// A live chain map, as rooms play (the room arena): no street-block graph, so a route runs to its target.
// Dispose of the game with `disposePhysics`.
async function lone(seed = 4217) {
  const s = await createGame(seed, generatedMap(), defaultContent());
  for (const p of s.players) { p.bot = false; p.input = {}; }
  s.traps = []; s.items = [];
  for (const p of s.players) p.discovery?.items?.clear();
  const p = s.players[0]; p.bot = true;
  return { s, p };
}
test('a bot routes to a cell it has seen and not to one it has not', async t => {
  const cell = { id: 'far-cell', kind: 'cell', x: 5500, y: 960, charge: 0 };
  const { map } = arena({ cols: 32, rows: 10, items: [cell] });
  const { s, players: [bot] } = await stagePhysics(map, { actors: [{ role: 'contestant', x: 576, y: 960 }, { role: 'contestant', bot: false, x: 6000, y: 1660 }] });
  t.after(() => disposePhysics(s));
  const { match, boundary } = startGame(s);
  const end = () => match.botRoute(bot.id).at(-1);
  const toCell = at => at && Math.hypot(at.x - cell.x, at.y - cell.y) < 150;
  // Far beyond what it sees it has no cell to go to, so it plans an exploration and never a route to the cell.
  let planned = 0;
  for (let i = 0; i < 60; i++) { stepGame(s); if (end()) planned++; assert.ok(!toCell(end()), 'an unseen cell is not a destination'); }
  assert.ok(planned, 'it explores');
  assert.ok(boundary.teleport(bot.id, [5000, 960]));
  let known;
  for (let i = 0; i < 60 && !toCell(known); i++) { stepGame(s); known = end(); }
  assert.ok(toCell(known), 'a seen cell is');
});

test('a bot that knows of nothing it needs explores', async t => {
  const { s, p } = await lone();
  t.after(() => disposePhysics(s));
  delete s.itemSerial; // This scenario clears all ground records before setup.
  const { match } = startGame(s), start = { x: p.x, y: p.y }, before = match.memory(p.id).discovered.length;
  for (let i = 0; i < 300; i++) stepGame(s);
  const after = match.memory(p.id).discovered.length;
  assert.ok(after > before + 10, `discovered ${before} → ${after}`);
  assert.ok(Math.hypot(now(s, p).x - start.x, now(s, p).y - start.y) > 500, 'it went looking');
});

test('a bot enters a reachable roofed frontier cell rather than giving it up from outside (#354 review)', async t => {
  const cell = { id: 'indoor-cell', kind: 'cell', x: 864, y: 1632, charge: 0 };
  const { map } = arena({ cols: 10, rows: 20, items: [cell], buildings: [{ id: 'room', x: 768, y: 1536, w: 192, h: 192 }] });
  const roofedCell = cellIndexAt(map, cell.x, cell.y);
  assert.ok(canOccupy(map, cell.x, cell.y, 14), 'the room is walkable');
  const { s, players: [p] } = await stagePhysics(map, { content: defaultContent(),
    actors: [{ role: 'contestant', x: 576, y: 1632 }, { role: 'contestant', bot: false, x: 1800, y: 3700 }] });
  t.after(() => disposePhysics(s));
  // Discovery comes from the authoritative match, including the initially concealed roofed cell.
  const { match } = startGame(s);
  const actor = match.ids.actorOfPlayer.get(p.id);
  const memory = () => match.memory(p.id);
  let movedByIntent = false;
  const advance = () => {
    const tick = stepGame(s);
    const row = tick.inbound.find(row => row.type === 'command' && row.command.source === 'bot' && row.command.actor === actor);
    assert.ok(row, 'the core committed input for the exploring bot');
    movedByIntent ||= row.command.input.movement.some(component => component !== 0);
  };
  advance();
  assert.equal(memory().seen.includes(roofedCell), false, 'the roof conceals the frontier from outside');
  for (let i = 0; i < 400 && !memory().seen.includes(roofedCell); i++) advance();
  assert.ok(movedByIntent, 'the committed commands drove exploration');
  assert.ok(memory().seen.includes(roofedCell), 'the roofed cell is seen by going in');
  const inventory = match.snapshot().state.actors.find(entry => entry.word === actor).actor.inventory;
  assert.ok(memory().items.some(item => item.id === itemId(s, 'indoor-cell'))
    || inventory.slots.some(item => item?.equipment.kind.kind === 'cell'), 'the cell inside is seen, or already taken');
});

test('a contestant routes over unknown ground with the same intent until it surveys a wall (#424)', async t => {
  const cell = { id: 'far-cell', kind: 'cell', x: 5500, y: 960, charge: 0 };
  const wall = { id: 'hidden-wall', x: 3320, y: 768, w: 80, h: 384 };
  const worlds = [];
  for (const obstacles of [[wall], []]) {
    const { map } = arena({ cols: 32, rows: 10, items: [{ ...cell }], obstacles });
    adoptPackedTiles(map, packedTilesFor(structuredClone(map), 'contestant'));
    const { s, players: [bot] } = await stagePhysics(map, { actors: [
      { role: 'contestant', x: 5200, y: 960 }, { role: 'contestant', bot: false, x: 6000, y: 1660 },
    ] });
    t.after(() => disposePhysics(s));
    const { match, boundary } = startGame(s);
    const support = createKnowledgePlanner(s.map, 'contestant').support(cellIndexAt(s.map, 3360, 960));
    const learnedLayout = () => {
      const { discovered, surveyed } = match.memory(bot.id);
      return support.every(index => discovered.includes(index) || surveyed.includes(index));
    };
    const id = itemId(s, cell.id);
    stepGame(s);
    assert.ok(match.memory(bot.id).items.some(item => item.id === id), 'the core remembered the cell from its first view');
    assert.ok(boundary.teleport(bot.id, [576, 960]));
    worlds.push({ s, bot, match, boundary, learnedLayout });
  }

  const advance = ({ s, bot, match }) => {
    const tick = stepGame(s);
    const actor = match.ids.actorOfPlayer.get(bot.id);
    const command = tick.inbound.find(row => row.type === 'command' && row.command.source === 'bot' && row.command.actor === actor);
    assert.ok(command, 'the tick spent the contestant bot command');
    const pose = match.snapshot().poses.find(entry => entry.body.kind === 'actor' && entry.body.id === actor);
    assert.ok(pose, 'the bot has a committed pose');
    return { position: pose.at, route: match.botRoute(bot.id), input: command.command.input };
  };
  const nearCell = route => {
    const end = route?.at(-1);
    return end && Math.hypot(end.x - cell.x, end.y - cell.y) < 20;
  };
  const [blocked, open] = worlds;
  for (let i = 0; i < 120; i++) {
    assert.deepEqual(advance(blocked), advance(open), `route and command agree on tick ${blocked.s.tick}`);
    assert.deepEqual(blocked.match.memory(blocked.bot.id), open.match.memory(open.bot.id));
    assert.ok(worlds.every(world => !world.learnedLayout()), 'the wall tile is outside the known support');
  }
  const route = blocked.match.botRoute(blocked.bot.id);
  const actor = blocked.match.ids.actorOfPlayer.get(blocked.bot.id);
  const position = blocked.match.snapshot().poses.find(entry => entry.body.kind === 'actor' && entry.body.id === actor).at;
  assert.ok(nearCell(route), 'the speculative route targets the remembered cell across the unknown wall');
  const privateRoute = () => snapshot(blocked.s).players.find(player => player.id === blocked.bot.id).route;
  assert.deepEqual(privateRoute(), route, 'the private snapshot reads the planned route from the core');
  assert.ok(route.some((point, i) => !sweptClear(blocked.s.map, i ? route[i - 1] : { x: position[0], y: position[1] }, point, 12)),
    'the speculative route crosses the hidden wall');

  for (const { boundary, bot } of worlds) assert.ok(boundary.teleport(bot.id, [2500, 960]));
  let differentInput = false;
  for (let i = 0; i < 40; i++) {
    const a = advance(blocked), b = advance(open);
    if (i === 0) assert.deepEqual(privateRoute(), [], 'the private snapshot sees the core clear the route at the warp');
    if (!worlds.every(world => world.learnedLayout())) continue;
    differentInput ||= a.input.movement.some((value, axis) => value !== b.input.movement[axis]);
    if (differentInput && a.route?.some(({ x, y }) => x >= wall.x && x <= wall.x + wall.w
        && (y < wall.y || y > wall.y + wall.h))) {
      assert.notDeepEqual(a.route, b.route, 'the surveyed wall changes the route');
      return;
    }
  }
  assert.fail('the surveyed wall should change the route and movement command');
});

test('item, door and survey memory stay out of snapshots and every projection', async t => {
  const { s, p } = await lone();
  t.after(() => disposePhysics(s));
  p.discovery.items.set('remembered-cell', { id: 'remembered-cell', kind: 'cell', x: p.x + 5000, y: p.y });
  // Door observations and surveyed cells, which navigation's knowledge filter reads (22.6, #423), stay private too.
  p.discovery.gates = new Map([['remembered-door', { open: false, locked: true }]]);
  p.discovery.surveyed = new Set([1, 2, 3]);
  const frame = snapshot(s);
  for (const secret of ['remembered-cell', 'remembered-door', 'surveyed', 'revision']) {
    assert.equal(JSON.stringify(frame).includes(secret), false, secret);
    for (const viewer of s.players) assert.equal(JSON.stringify(playerView(s, frame, viewer.id)).includes(secret), false, viewer.id);
  }
});

// A wall at x 600–640 with a door in it, and a gap at its foot. Each bot saw the door locked, so it
// routes through the gap; then `see()` has the door seen open.
function doorScene(content, positions) {
  content = typeof content === 'string' ? contentById(content) : content;
  const cell = { id: 'cell', kind: 'cell', x: 1100, y: 330, charge: 0 };
  const map = { ...openMap([cell]), hazards: [], traps: [], chargers: [], stations: [], exit: { x: 1800, y: 100 },
    obstacles: [{ id: 'upper', x: 600, y: 0, w: 40, h: 300 }, { id: 'lower', x: 600, y: 360, w: 40, h: 440 }],
    gates: [{ id: 'door', x: 620, y: 330, w: 40, h: 60, open: true, locked: false, kind: 'door' }] };
  const memories = [];
  const players = positions.map(([x, y], i) => {
    const p = { id: `c${i}`, name: `contestant-${i + 1}`, role: 'contestant', kit: 'warden', bot: true, x, y, hp: 100, maxHp: 100, shield: 0, keys: 0,
      weapon: 0, kills: 0, level: 1, status: 'active', cooldown: 0, attackCd: 0, railCd: 0, cloak: 0, revealed: 0, boost: 0, stun: 0, heading: 0,
      input: {}, lastSeq: -1, inventory: Array(4).fill(null), selectedSlot: 0 };
    const memory = createDiscovery();
    memory.seen = new Set();
    for (let i = 0; i < 50; i++) { memory.discovered.add(i); memory.seen.add(i); }
    memory.items = new Map([[cell.id, { ...cell }]]);
    memory.gates = new Map([['door', { open: false, locked: true }]]);
    attachDiscovery(p, memory);
    memories.push(memory);
    return p;
  });
  const s = { tick: 0, phase: 'live', content, map, players, projectiles: [], effects: [], events: [], hazardX: -80, slots: 3, serial: 0 };
  const through = p => !p.route.some(q => q.y >= 800);
  // The bots stand still, so only what they know changes.
  for (; s.tick < 60 && players.some(p => !p.route?.length); s.tick++) for (const p of players) collectBotIntent(s, p);
  for (const p of players) assert.ok(p.route.length && !through(p), 'it routes round by the gap: ' + JSON.stringify(p.route));
  for (; s.tick % 20 !== 1; s.tick++) for (const p of players) collectBotIntent(s, p);
  const see = () => { for (const memory of memories) memory.gates.set('door', { open: true, locked: false }); };
  return { s, players, through, see };
}

// The same wall as `doorScene`, in a started match: a door in it, and a gap at its foot. The bot knows the door is
// locked, so it routes through the gap; a contestant with a key then opens the door, and the bot sees it open.
async function openedDoor(t, x, y) {
  const cell = { id: 'cell', kind: 'cell', x: 1100, y: 330, charge: 0 };
  const { map } = arena({ cols: 10, rows: 5, items: [cell], exit: { x: 1800, y: 100 },
    obstacles: [{ id: 'upper', x: 600, y: 0, w: 40, h: 300 }, { id: 'lower', x: 600, y: 360, w: 40, h: 440 }],
    gates: [{ id: 'door', x: 620, y: 330, w: 40, h: 60, open: false, locked: true, kind: 'door' }] });
  const knows = { surveyed: everywhere(map), gates: new Map([['door', { open: false, locked: true }]]) };
  // The bot starts where it sees the cell through the gap, and is moved to its place once it remembers the cell.
  const { s, players: [bot, opener] } = await stagePhysics(map, { actors: [{ role: 'contestant', x: 700, y: 880, knows },
    { role: 'contestant', bot: false, x: 575, y: 330 }, { role: 'contestant', bot: false, x: 1700, y: 880 }] });
  t.after(() => disposePhysics(s));
  opener.keys = 1;
  const { match, boundary } = startGame(s);
  for (let i = 0; i < 3; i++) stepGame(s);
  assert.ok(match.memory(bot.id).items.length, 'the bot remembers the cell');
  assert.ok(boundary.teleport(bot.id, [x, y]));
  const through = () => { const route = match.botRoute(bot.id); return route.length > 0 && !route.some(q => q.y >= 800); };
  for (let i = 0; i < 80 && !match.botRoute(bot.id).some(q => q.y >= 800); i++) stepGame(s);
  assert.ok(match.botRoute(bot.id).some(q => q.y >= 800), 'it routes round by the gap');
  assert.ok(setInput(s, opener.id, { seq: s.tick + 1, interact: true }));
  const opened = s.tick;
  for (let i = 0; i < 80 && !through(); i++) stepGame(s);
  assert.ok(through(), 'it takes the door in the end');
  return s.tick - opened;
}

test('replanning a door seen opening near a bot reroutes it soon, and one further off at its next repath (#470 part 2)', async t => {
  const near = await openedDoor(t, 420, 330), far = await openedDoor(t, 100, 330);
  assert.ok(near <= 20, `near: repaired within a sample of the door being seen, not after ${near}`);
  assert.ok(far > near, `further off: at its next repath, after ${far}, not with the near bot's ${near}`);
});

test(`under repair replanning a repair reserves its budget from the tick's shared allowance, and waits a tick when it is short (#470 part 2)`, () => {
  // Whatever earlier bots left this tick: none, or one short of a repair's budget.
  for (const left of [0, 499]) {
    const { s, players: [p], through, see } = doorScene('content-7', [[420, 330]]);
    see();
    tickAllowance(s).left = left;
    collectBotIntent(s, p);
    assert.equal(through(p), false, `with ${left} left it waits`);
    assert.equal(tickAllowance(s).left, left, 'and spends nothing');
    s.tick++;
    collectBotIntent(s, p);
    assert.ok(through(p), 'it repairs on the next tick');
  }
  // Two near bots and one further off, whose sliced repath competes with the repairs, with each tick
  // starting 520 short of nothing: the first repair leaves too little for the second, which waits.
  const { s, players, through, see } = doorScene('content-7', [[420, 330], [420, 300], [100, 330]]);
  see();
  const took = new Map();
  for (const seenAt = s.tick; s.tick < seenAt + 40 && took.size < players.length; s.tick++) {
    tickAllowance(s).left = 520;
    for (const p of players) {
      collectBotIntent(s, p);
      assert.ok(tickAllowance(s).left >= 0, `tick ${s.tick}: the allowance stays within the cap (${tickAllowance(s).left})`);
      if (!took.has(p) && through(p)) took.set(p, s.tick - seenAt);
    }
  }
  assert.deepEqual(players.map(p => took.get(p) !== undefined), [true, true, true], 'all take the door in the end');
  assert.equal(took.get(players[0]), 0, 'the first repairs at once');
  assert.equal(took.get(players[1]), 1, 'the second waits a tick');
});
