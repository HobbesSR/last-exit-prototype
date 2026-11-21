import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, step } from '../shared/simulation.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { storeDrift } from '../shared/simulation/player-store.ts';
import { generatedMap } from './helpers/room-harness.js';

// The core's player store (#1214 stage 6c.2) is uploaded once a tick, by phase 1, so every write to its fields inside a
// tick must reach it as well as the records, its equipment included (6c.3c.1). A bot match on the default arena, with traps and hazard areas so the
// environment, eliminations and respawns run too, holds the store equal to a fresh upload of the records after every
// tick. A writer that misses the store shows here as the field and player it left behind.
const KINDS = ['mine', 'turret', 'flame', 'spider'];

test('every write inside a tick reaches the core\'s player store (#1214 stage 6c.2)', async () => {
  const map = structuredClone(generatedMap());
  map.traps = map.items.filter((_, i) => i % 5 === 0).map((item, i) => {
    const kind = KINDS[i % 4], trap = { id: `trap-${i}`, kind, x: item.x, y: item.y, homeX: item.x, homeY: item.y, heading: 0, offset: i * 7 };
    if (i % 3) trap.cooldown = 0;
    return trap;
  });
  map.hazards = map.items.filter((_, i) => i % 13 === 1).map(at => ({ x: at.x - 120, y: at.y - 120, w: 240, h: 240 }));
  const s = await createGame(4217, map, defaultContent());
  try {
    // Written between ticks, as tests and commands do; phase 1's upload takes them. Each gladiator starts beside a
    // contestant, both nearly dead, in a hazard area of its own, so kills, eliminations and respawns all happen early.
    const gladiators = s.players.filter(p => p.role === 'gladiator'), contestants = s.players.filter(p => p.role === 'contestant');
    gladiators.forEach((g, i) => {
      const c = contestants[i];
      Object.assign(g, { x: c.x + 40, y: c.y, hp: 6, viewLagTicks: 3 }); c.hp = 6;
      s.map.hazards.push({ x: g.x - 60, y: g.y - 60, w: 120, h: 120 });
    });
    const r = physicsRuntime(s);
    let ticks = 0;
    const seen = new Set();
    for (; ticks < 600 && s.phase === 'live'; ticks++) {
      step(s);
      for (const p of s.players) seen.add(p.status);
      const drift = storeDrift(s, r);
      assert.deepEqual(drift, [], `tick ${s.tick}`);
    }
    assert.ok(ticks >= 300, `the match ran (${ticks} ticks)`);
    assert.ok(seen.has('respawning') && seen.has('eliminated'), `eliminations and a respawn happened (${[...seen]})`);
  } finally { disposePhysics(s); }
});
