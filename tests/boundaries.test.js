import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as simulation from '../shared/simulation.js';
import * as map from '../shared/map.js';
import { invalidateGraph } from '../shared/map/graph.js';

test('public simulation/map exports and acyclic shared dependencies remain stable', () => {
  assert.deepEqual(Object.keys(simulation).sort(), ['VERSION', 'HZ', 'DURATION', 'CELL_CHARGE_TICKS', 'GLADIATOR_RESPAWN_TICKS', 'HAZARD_GRACE_TICKS', 'KITS', 'POTENTIAL', 'TILE', 'generateMap', 'createGame', 'joinGame', 'setInput', 'couldSee', 'visibleTo', 'playerView', 'step', 'snapshot'].sort());
  assert.deepEqual(Object.keys(map).sort(), ['WORLD_WIDTH', 'WORLD_HEIGHT', 'BLOCK_SIZE', 'blockAt', 'blockRoute', 'generateMap', 'navigationGrid'].sort());
  const files = readdirSync('shared', { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.resolve('shared', f));
  const graph = new Map(files.map(file => {
    const refs = [...readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map(m => path.resolve(path.dirname(file), m[1]));
    if (file.includes(`${path.sep}simulation${path.sep}`)) assert.ok(!refs.includes(path.resolve('shared/simulation.js')), 'internals cannot import simulation facade');
    if (file.includes(`${path.sep}map${path.sep}`)) assert.ok(!refs.includes(path.resolve('shared/map.js')), 'internals cannot import map facade');
    return [file, refs];
  }));
  const done = new Set();
  function visit(file, stack = []) {
    assert.ok(!stack.includes(file), `dependency cycle: ${[...stack, file].join(' -> ')}`);
    if (done.has(file)) return;
    for (const ref of graph.get(file) || []) visit(ref, [...stack, file]);
    done.add(file);
  }
  for (const file of files) visit(file);
});

test('navigation caches follow map identity, doors, obstacle replacement and append', () => {
  const m = { width: 1200, height: 1200, obstacles: [], gates: [{ id: 'door', x: 620, y: 620, w: 20, h: 100, open: false, locked: false }] };
  const bounds = { x: 13, y: 13, width: 5, height: 5 };
  const grid = () => map.navigationGrid(m, 'contestant', bounds);
  const closed = grid(); assert.equal(grid(), closed);
  assert.notEqual(map.navigationGrid(structuredClone(m), 'contestant', bounds), closed);
  m.gates[0].open = true;
  const opened = grid(); assert.notDeepEqual(opened, closed); assert.equal(grid(), opened);
  m.obstacles = [{ id: 'wall', x: 600, y: 600, w: 40, h: 40 }];
  const replaced = grid(); assert.notDeepEqual(replaced, opened);
  m.obstacles.push({ id: 'wall2', x: 540, y: 540, w: 40, h: 40 });
  assert.notDeepEqual(grid(), replaced);
  m.gates[0].open = false;
  const unlocked = map.navigationGrid(m, 'contestant', bounds, true);
  m.gates[0].locked = true;
  assert.notDeepEqual(map.navigationGrid(m, 'contestant', bounds, true), unlocked);
});

test('graph routing retains neighbor tie-breaking and explicit generation invalidation', () => {
  const nodes = [{ id: 'a', neighbors: ['b', 'c'] }, { id: 'b', neighbors: ['a', 'd'] }, { id: 'c', neighbors: ['a', 'd'] }, { id: 'd', neighbors: ['b', 'c'] }];
  const m = { nodes }, route = () => map.blockRoute(m, nodes[0], nodes[3]);
  assert.deepEqual(route().map(n => n.id), ['a', 'b', 'd']);
  assert.equal(route(), route());
  nodes[0].neighbors.reverse(); invalidateGraph(m);
  assert.deepEqual(route().map(n => n.id), ['a', 'c', 'd']);
});
