import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, TILE } from '../../shared/simulation.ts';
import { canOccupy } from '../../shared/movement.ts';
import { navigationGrid } from '../../shared/map.ts';
import PF from 'pathfinding';

test('200 generated maps have a no-key route for both body sizes', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = createGame(seed);
    for (const role of ['contestant', 'gladiator']) {
      const matrix = navigationGrid(s.map, role);
      const start = s.players[0], end = s.map.exit;
      const route = new PF.AStarFinder().findPath(Math.floor(start.x / TILE), Math.floor(start.y / TILE), Math.floor(end.x / TILE), Math.floor(end.y / TILE), new PF.Grid(matrix));
      assert.ok(route.length > 0, `seed ${seed}, ${role}`);
    }
    assert.ok(s.map.items.every(i => canOccupy(s.map, i.x, i.y, 12)), `loot seed ${seed}`);
    assert.ok(s.map.chargers.every(i => canOccupy(s.map, i.x, i.y, 25)), `chargers seed ${seed}`);
    for (const route of s.map.routes) for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i], length = Math.hypot(b.x - a.x, b.y - a.y);
      const samples = Math.ceil(length / 20);
      for (let j = 0; j <= samples; j++) assert.ok(canOccupy(s.map, a.x + (b.x - a.x) * j / samples, a.y + (b.y - a.y) * j / samples, 25), `seed ${seed} ${route.band} segment ${i} sample ${j}`);
    }
  }
});

