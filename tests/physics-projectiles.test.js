import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics } from '../shared/simulation.ts';
import { solvePhysicsProjectiles } from '../shared/simulation/phase-five.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';

// Real games (the projectile solver runs in the core, which needs a physics world). The scene is the
// bullet's lane at y 55 on a 1000 x 400 field of 10-unit cells; every other contestant is parked at y 300.
const bullet = (x, y, dx, dy) => ({ id: 1, owner: 'shooter', x, y, dx, dy, life: 10, damage: 10 });
const still = (p, n = 5) => ({ [`actor:${p.id}`]: Array.from({ length: n }, () => ({ x: p.x, y: p.y })) });

/** Build the map, create a game, seat one contestant at (x, y) with the others parked, fire `shot`, run `body`. */
async function scene({ obstacles = [], gates = [], hole = false }, x, y, shot, body) {
  const { map } = arena({ cols: 100, rows: 40, cellSize: 10, obstacles, gates });
  if (hole) map.playableArea.rows[5].runs = [[0, 4], [5, 100]];
  map.spawns = [200, 400, 600, 800].map(x => ({ x, y: 300 })); map.hunterSpawns = [{ x: 900, y: 300 }];
  const s = await createGame(7, map, { ...defaultContent(), roster: { contestants: ['C0', 'C1'], gladiators: [{ name: 'G0', kit: 'warden' }] } });
  try {
    const contestants = s.players.filter(p => p.role === 'contestant');
    contestants.forEach((p, i) => Object.assign(p, { x: 150 + i * 60, y: 300, hp: 100, shield: 0, bot: false }));
    const target = contestants[0];
    Object.assign(target, { x, y });
    s.projectiles = [shot];
    await body(s, target);
  } finally { disposePhysics(s); }
}

test('a bullet cannot cross a thin playable-mask void and hit after re-entry', async () => {
  await scene({ hole: true }, 68, 55, bullet(30, 55, 45, 0), (s, target) => {
    solvePhysicsProjectiles(s, still(target));
    assert.equal(target.hp, 100);
    assert.equal(s.projectiles.length, 0);
  });
});

test('earliest geometry contact beats a later actor, while an earlier actor wins', async () => {
  const wall = () => [{ id: 'wall', kind: 'building', x: 50, y: 40, w: 2, h: 20 }];
  await scene({ obstacles: wall() }, 70, 55, bullet(20, 55, 65, 0), (s, behind) => {
    solvePhysicsProjectiles(s, still(behind));
    assert.equal(behind.hp, 100);
    assert.equal(s.projectiles.length, 0);
  });
  await scene({ obstacles: wall() }, 36, 55, bullet(20, 55, 65, 0), (s, before) => {
    solvePhysicsProjectiles(s, still(before));
    assert.equal(before.hp, 90);
    assert.equal(s.projectiles.length, 0);
  });
  // Actor radius 15 meets the radius-2 wall contact at x=48.
  await scene({ obstacles: wall() }, 63, 55, bullet(20, 55, 65, 0), (s, tangent) => {
    solvePhysicsProjectiles(s, still(tangent));
    assert.equal(tangent.hp, 100, 'geometry wins an equal-time contact');
  });
});

test('window remains passable to shots and a closed gate does not', async () => {
  await scene({ obstacles: [{ id: 'window', kind: 'window', x: 50, y: 40, w: 2, h: 20 }] }, 70, 55, bullet(20, 55, 65, 0), (s, target) => {
    solvePhysicsProjectiles(s, still(target));
    assert.equal(target.hp, 90);
  });
  await scene({ gates: [{ id: 'gate', kind: 'door', x: 50, y: 55, w: 2, h: 20, open: false }] }, 70, 55, bullet(20, 55, 65, 0), (s, target) => {
    solvePhysicsProjectiles(s, still(target));
    assert.equal(target.hp, 100, 'the closed gate stops the shot');
  });
});

test('relative swept actor motion is retained with geometry timing', async () => {
  await scene({}, 70, 55, bullet(20, 55, 45, 0), (s, target) => {
    solvePhysicsProjectiles(s, { [`actor:${target.id}`]: [70, 63, 56, 49, 42].map(x => ({ x, y: 55 })) });
    assert.equal(target.hp, 90);
    assert.equal(s.projectiles.length, 0);
  });
});

test('a kill stops the run for its elimination and drops, then the next hit still resolves', async () => {
  // Two lethal hits in one call: the first elimination's mandatory drop returns at its sync boundary, and the run resumes
  // from what the core kept (27, step 5d.2). Both deaths land, in hit order, each with its loot on the ground.
  await scene({}, 300, 55, { ...bullet(255, 55, 40, 0), id: 1 }, (s, first) => {
    const second = s.players.find(p => p.role === 'contestant' && p !== first);
    Object.assign(second, { x: 600, y: 55 });
    s.projectiles.push({ ...bullet(555, 55, 40, 0), id: 2 });
    for (const [i, p] of [first, second].entries()) {
      p.hp = 5;
      p.inventory[0] = { kind: 'med', count: 1 };
      p.charging = { since: i };
    }
    const items = s.items.length;
    solvePhysicsProjectiles(s, { ...still(first), ...still(second) });
    assert.deepEqual([first.status, second.status], ['eliminated', 'eliminated']);
    assert.deepEqual(s.events.filter(e => e.kind === 'eliminated').map(e => e.target.name), [first.name, second.name]);
    assert.equal(s.items.length, items + 2, 'each death dropped its carried med');
    assert.ok([first, second].every(p => p.inventory.every(i => i === null) && p.charging === null));
    assert.equal(s.projectiles.length, 0);
  });
});
