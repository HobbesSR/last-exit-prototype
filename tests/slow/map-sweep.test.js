import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, TILE } from '../../shared/simulation.ts';
import { canOccupy } from '../../shared/movement.ts';
import { navigationGrid } from '../../shared/map.ts';
import PF from 'pathfinding';
import { seeds as FIXTURE_SEEDS } from '../characterization-scenarios.js';

/**
 * The legacy generator (`shared/map/generate.ts`) makes the arenas tests play on; no room is
 * served one. Its output is pinned by the characterization map hashes on the fixture's four
 * seeds, so a sweep over unchanged code repeats one answer. Seeds 1 to 20 and the fixture's own
 * are the per-run witness (about 3 s). A change to the generator, `canOccupy` or the navigation
 * grid runs the full sweep with `LEGACY_MAP_SEEDS=200` (31; 200 seeds took 31 s, #822).
 */
const count = (() => {
  const text = process.env.LEGACY_MAP_SEEDS;
  if (text === undefined) return 20;
  if (!/^[1-9]\d{0,3}$/.test(text)) throw new RangeError(`LEGACY_MAP_SEEDS must be a whole number from 1 to 9999, not "${text}".`);
  return Number(text);
})();
const SEEDS = [...new Set([...Array.from({ length: count }, (_, i) => i + 1), ...FIXTURE_SEEDS])];

test(`legacy maps have a no-key route for both body sizes: seeds 1 to ${count} and the fixture's`, () => {
  for (const seed of SEEDS) {
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

