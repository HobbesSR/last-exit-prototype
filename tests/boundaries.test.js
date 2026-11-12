import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as simulation from '../shared/simulation.ts';
import * as map from '../shared/map.ts';

test('public simulation/map exports and acyclic shared dependencies remain stable', () => {
  assert.deepEqual(Object.keys(simulation).sort(), ['VERSION', 'HZ', 'DURATION', 'CELL_CHARGE_TICKS', 'GLADIATOR_RESPAWN_TICKS', 'HAZARD_GRACE_TICKS', 'KITS', 'POTENTIAL', 'TILE', 'createGameRecord', 'joinGame', 'setInput', 'couldSee', 'visibleTo', 'playerView', 'step', 'snapshot', 'PHYSICS_VERSION', 'createGame', 'disposePhysics', 'enqueuePhysicsImpulse', 'enqueuePhysicsAttachment', 'synchronizePhysics'].sort());
  assert.deepEqual(Object.keys(map).sort(), ['WORLD_WIDTH', 'WORLD_HEIGHT'].sort());
  const files = readdirSync('shared', { recursive: true }).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts')).map(f => path.resolve('shared', f));
  const graph = new Map(files.map(file => {
    const refs = [...readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map(m => path.resolve(path.dirname(file), m[1]));
    if (file.includes(`${path.sep}simulation${path.sep}`)) assert.ok(!refs.includes(path.resolve('shared/simulation.ts')), 'internals cannot import simulation facade');
    if (file.includes(`${path.sep}map${path.sep}`)) assert.ok(!refs.includes(path.resolve('shared/map.ts')), 'internals cannot import map facade');
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
