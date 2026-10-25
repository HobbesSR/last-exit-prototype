import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscovery } from '../shared/discovery.ts';
import { createPhysicsGame, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { dynamicNavigationWork, dynamicWaypoint } from '../shared/simulation/dynamic-navigation.ts';
import { discoveryGrid } from '../shared/discovery.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';

function fixture({ width = 800, height = 800, spawns = [{ x: 150, y: 400 }], gladiator = true,
  gates = [], obstacles = [], props = [] } = {}) {
  const map = { seed: 448, width, height,
    playableArea: { cellSize: 100, rows: Array.from({ length: Math.ceil(height / 100) }, (_, y) => ({ y, runs: [[0, Math.ceil(width / 100)]] })) },
    modules: [], buildings: [], obstacles, gates, hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [], physicsProps: props,
    entry: { x: 80, y: 400 }, exit: { x: width - 50, y: 400 }, spawns,
    hunterSpawns: [{ x: 300, y: 400 }] };
  const content = structuredClone(contentById('content-physics-8'));
  content.roster = { contestants: spawns.map((_, i) => `C${i}`),
    gladiators: gladiator ? [{ name: 'G', kit: 'warden' }] : [] };
  return { map, content };
}

async function game(options) {
  const { map, content } = fixture(options);
  const s = await createPhysicsGame(448, map, content);
  for (const p of s.players) p.bot = false;
  return s;
}

function giveDiscovery(p, { surveyed = new Set(), gates = new Map() } = {}) {
  p.discovery = { ...createDiscovery(), surveyed, gates };
}

function allSurveyed(s) {
  const { cols, rows } = discoveryGrid(s.map);
  return new Set(Array.from({ length: cols * rows }, (_, i) => i));
}

test('local detours honor the remembered door state and do not inspect hidden geometry', async () => {
  const doorA = await game({ gates: [{ id: 'remembered', x: 350, y: 400, w: 24, h: 60, open: true, kind: 'door' }] });
  const doorB = await game({ gates: [{ id: 'remembered', x: 350, y: 400, w: 24, h: 60, open: false, kind: 'door' }] });
  try {
    for (const s of [doorA, doorB]) {
      const p = s.players[0];
      p.discovery = { ...createDiscovery(), surveyed: allSurveyed(s), gates: new Map([['remembered', { open: false, locked: false }]]) };
    }
    const goal = { x: 480, y: 400 };
    assert.deepEqual(dynamicWaypoint(doorA, doorA.players[0], goal), dynamicWaypoint(doorB, doorB.players[0], goal),
      'live open/closed gate difference cannot override the contestant memory');
  } finally { disposePhysics(doorA); disposePhysics(doorB); }

  const clear = await game();
  const altered = await game({ obstacles: [{ id: 'unseen', x: 380, y: 560, w: 80, h: 80 }] });
  try {
    for (const s of [clear, altered]) giveDiscovery(s.players[0]);
    const goal = { x: 480, y: 400 };
    const a = dynamicWaypoint(clear, clear.players[0], goal);
    const b = dynamicWaypoint(altered, altered.players[0], goal);
    assert.deepEqual(a, clear.players[0], 'unsurveyed support queues the bot at its current pose');
    assert.deepEqual(b, altered.players[0], 'hidden obstacle geometry cannot select a different local waypoint');
    assert.deepEqual(a, b);

    for (const s of [clear, altered]) s.players[0].discovery.surveyed = allSurveyed(s);
    const surveyedA = dynamicWaypoint(clear, clear.players[0], goal);
    const surveyedB = dynamicWaypoint(altered, altered.players[0], goal);
    assert.notDeepEqual(surveyedA, clear.players[0], 'fully surveyed support permits a local detour');
    assert.notDeepEqual(surveyedB, altered.players[0]);
  } finally { disposePhysics(clear); disposePhysics(altered); }
});

test('crowd and authored prop workload stays capped without changing poses or the global route', async () => {
  const spawns = Array.from({ length: 27 }, (_, i) => ({ x: 180 + (i % 9) * 40, y: 300 + Math.floor(i / 9) * 40 }));
  const props = Array.from({ length: 64 }, (_, i) => ({ id: `crate-${String(i).padStart(2, '0')}`, profile: 'crate',
    x: 1000 + (i % 8) * 60, y: 200 + Math.floor(i / 8) * 60, angle: i % 2 ? Math.PI / 5 : 0 }));
  const s = await game({ width: 2400, height: 1600, spawns, gladiator: false, props });
  try {
    assert.equal(physicsRuntime(s).world.counts().dynamic, 64 + 27, 'all authored props and actors fit within the 128-body limit');
    const saved = new Map(s.players.map(p => {
      p.route = [{ x: p.x + 300, y: p.y }, { x: p.x + 600, y: p.y }];
      return [p.id, { x: p.x, y: p.y, route: p.route, points: structuredClone(p.route) }];
    }));
    for (const p of s.players) dynamicWaypoint(s, p, { x: p.x + 600, y: p.y });
    assert.ok(dynamicNavigationWork(s) > 0, 'the crowded case exercised bounded edge planning');
    assert.ok(dynamicNavigationWork(s) <= 1536, `tick edge work was ${dynamicNavigationWork(s)}`);
    for (const p of s.players) {
      const before = saved.get(p.id);
      assert.deepEqual({ x: p.x, y: p.y }, { x: before.x, y: before.y }, 'planning never moves actors');
      assert.equal(p.route, before.route, 'planning preserves the route object');
      assert.deepEqual(p.route, before.points, 'planning does not rewrite global route points');
    }
  } finally { disposePhysics(s); }
});
