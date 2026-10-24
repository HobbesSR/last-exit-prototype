import test from 'node:test';
import assert from 'node:assert/strict';
import { solvePhysicsProjectiles } from '../shared/simulation/physics-projectiles.ts';

const player = (id, x, y) => ({ id, x, y, role: 'contestant', status: 'active', hp: 100, shield: 0 });
const bullet = (x, y, dx, dy) => ({ id: 1, owner: 'shooter', x, y, dx, dy, life: 10, damage: 10 });
const mask = (hole = false) => ({ width: 100, height: 100, obstacles: [], gates: [],
  playableArea: { cellSize: 10, rows: Array.from({ length: 10 }, (_, y) => ({ y,
    runs: hole && y === 5 ? [[0, 4], [5, 10]] : [[0, 10]] })) } });
const game = (map, target, shot) => ({ map, players: [target], projectiles: [shot], tick: 1 });
const still = target => ({ [`actor:${target.id}`]: Array.from({ length: 5 }, () => ({ x: target.x, y: target.y })) });

test('a bullet cannot cross a thin playable-mask void and hit after re-entry', () => {
  const target = player('target', 68, 55);
  const s = game(mask(true), target, bullet(30, 55, 45, 0));
  solvePhysicsProjectiles(s, still(target));
  assert.equal(target.hp, 100);
  assert.equal(s.projectiles.length, 0);
});

test('earliest geometry contact beats a later actor, while an earlier actor wins', () => {
  const wall = { id: 'wall', kind: 'building', x: 50, y: 40, w: 2, h: 20 };
  const map = { ...mask(), obstacles: [wall] };
  const behind = player('behind', 70, 55);
  const blocked = game(map, behind, bullet(20, 55, 65, 0));
  solvePhysicsProjectiles(blocked, still(behind));
  assert.equal(behind.hp, 100);
  assert.equal(blocked.projectiles.length, 0);
  const before = player('before', 36, 55);
  const hit = game(map, before, bullet(20, 55, 65, 0));
  solvePhysicsProjectiles(hit, still(before));
  assert.equal(before.hp, 90);
  assert.equal(hit.projectiles.length, 0);
  const tangent = player('tangent', 63, 55); // Actor radius 15 meets the radius-2 wall contact at x=48.
  const tied = game(map, tangent, bullet(20, 55, 65, 0));
  solvePhysicsProjectiles(tied, still(tangent));
  assert.equal(tangent.hp, 100, 'geometry wins an equal-time contact');
});

test('window remains passable to shots and a closed gate does not', () => {
  const target = player('target', 70, 55);
  const window = { ...mask(), obstacles: [{ id: 'window', kind: 'window', x: 50, y: 40, w: 2, h: 20 }] };
  solvePhysicsProjectiles(game(window, target, bullet(20, 55, 65, 0)), still(target));
  assert.equal(target.hp, 90);
  const gate = { ...mask(), gates: [{ id: 'gate', kind: 'door', x: 50, y: 55, w: 2, h: 20, open: false }] };
  solvePhysicsProjectiles(game(gate, target, bullet(20, 55, 65, 0)), still(target));
  assert.equal(target.hp, 90);
});

test('relative swept actor motion is retained with geometry timing', () => {
  const target = player('target', 70, 55);
  const s = game(mask(), target, bullet(20, 55, 45, 0));
  const path = { 'actor:target': [70, 63, 56, 49, 42].map(x => ({ x, y: 55 })) };
  solvePhysicsProjectiles(s, path);
  assert.equal(target.hp, 90);
  assert.equal(s.projectiles.length, 0);
});

test('legacy diamond outside is solid along its diagonal face', () => {
  const map = { width: 250, height: 250, obstacles: [], gates: [] };
  const target = player('target', 35, 35);
  const s = game(map, target, bullet(125, 125, -110, -110));
  solvePhysicsProjectiles(s, still(target));
  assert.equal(target.hp, 100);
  assert.equal(s.projectiles.length, 0);
});
