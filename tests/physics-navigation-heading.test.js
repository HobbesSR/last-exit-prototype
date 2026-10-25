import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics, step } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { collectBotIntent } from '../shared/simulation/bots.ts';
import { actorRadius } from '../shared/simulation/actor-physics.ts';
import { visiblePoint, visibleTo } from '../shared/simulation/visibility.ts';
import { VISION } from '../shared/movement.ts';

function fixture({ spawns = [{ x: 150, y: 400 }], gladiator = false, obstacles = [], items = [] } = {}) {
  const map = { seed: 448, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles, gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items, traps: [], routes: [], nodes: [], streets: [], physicsProps: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 }, spawns,
    hunterSpawns: [{ x: 300, y: 400 }] };
  const content = structuredClone(contentById('content-physics-8'));
  content.roster = { contestants: spawns.map((_, i) => `C${i}`), gladiators: gladiator ? [{ name: 'G', kit: 'warden' }] : [] };
  content.discovery = false;
  return { map, content };
}

test('point sight applies strict range, roof concealment, and cover; actor exceptions remain separate', async () => {
  const { map, content } = fixture({ gladiator: true });
  const s = await createPhysicsGame(448, map, content);
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

test('collectBotIntent preserves heading when a P8 bot queues with no enemy', async () => {
  const { map, content } = fixture({ spawns: [{ x: 200, y: 400 }, { x: 300, y: 400 }],
    obstacles: [{ id: 'top', x: 100, y: 100, w: 500, h: 280 },
      { id: 'bottom', x: 100, y: 420, w: 500, h: 280 }],
    items: [{ id: 'goal-cell', kind: 'cell', charge: 0, x: 500, y: 400 }] });
  const s = await createPhysicsGame(448, map, content);
  try {
    const [p, blocker] = s.players;
    p.heading = 1.25;
    blocker.bot = false;
    let queued = false, closest = Infinity, lastIntent;
    for (let i = 0; i < 120; i++) {
      p.heading = 1.25;
      const intent = collectBotIntent(s, p);
      lastIntent = intent.input;
      closest = Math.min(closest, blocker.x - p.x);
      if (intent.input.x === 0 && intent.input.y === 0) {
        assert.ok(blocker.x - p.x <= actorRadius(s, p) + actorRadius(s, blocker) + 5,
          `bot queued before reaching actor contact: gap=${blocker.x - p.x}`);
        assert.equal(intent.input.aim, p.heading);
        queued = true;
        break;
      }
      step(s);
    }
    assert.equal(queued, true, `the actual bot planner queued at contact; closest=${closest}, last=${JSON.stringify(lastIntent)}`);
  } finally { disposePhysics(s); }
});
