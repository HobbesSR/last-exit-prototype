import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';
import { createPhysicsWorld } from '../shared/physics/world.ts';

const bodies = [
  { id: 'wall', kind: 'static', x: 150, y: 200, shape: { kind: 'box', hx: 2, hy: 100 } },
  { id: 'actor:c0', kind: 'actor', x: 100, y: 200, shape: { kind: 'circle', radius: 12 }, friction: 0 },
];
const world = await createPhysicsWorld();
const expected = [];
try {
  bodies.forEach(body => world.queueAddBody(body)); world.commitMutations();
  world.setMotor('actor:c0', { x: 180, y: 0, accel: 3600 });
  for (let i = 1; i <= 8; i++) { world.step(); world.drainContacts(); expected.push(world.snapshot()); }
} finally { world.dispose(); }
const server = await createArenaServer({ replayDir: 'test-results/physics-browser-replays' });
const base = await listen(server);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const actual = await page.evaluate(async bodies => {
    const { createPhysicsWorld } = await import('/shared/physics/world.ts');
    const world = await createPhysicsWorld();
    const frames = [];
    try {
      bodies.forEach(body => world.queueAddBody(body)); world.commitMutations();
      world.setMotor('actor:c0', { x: 180, y: 0, accel: 3600 });
      for (let i = 1; i <= 8; i++) { world.step(); world.drainContacts(); frames.push(world.snapshot()); }
    } finally { world.dispose(); }
    let disposed = false;
    try { world.counts(); } catch { disposed = true; }
    return { frames, disposed };
  }, bodies);
  assert.deepEqual(JSON.parse(JSON.stringify(actual.frames)), JSON.parse(JSON.stringify(expected)));
  assert.equal(actual.disposed, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, browser: browser.version(), ticks: 8,
    checks: ['shared production WASM bootstrap', 'Node/Chrome gameplay state equality', 'browser disposal'] }));
} finally { await browser.close(); await server.close(); }
