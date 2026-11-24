import assert from 'node:assert/strict';
import path from 'node:path';
import { collectBrowserErrors, serveWithBrowser } from './helpers/browser.js';
import { contentById } from '../shared/simulation/content.ts';
import { synchronizePhysics } from '../shared/simulation.ts';
import { arena } from './helpers/arena.js';
import { ensureItemIdentity } from '../shared/item-instances.ts';

// Heard gunfire's presentation (#684, 29.4): a cue reaches the player's own frame and is drawn, as a ring
// on screen and an edge arrow off it, and on the minimap, without a page error. Shots are arranged on the server.
const { server, base, browser } = await serveWithBrowser({ profileSummary: false, roomThreads: false, content: () => ({ ...structuredClone(contentById('content-8')), roster: { contestants: ['A', 'B', 'C'], gladiators: [] } }),
  generateMap: () => arena({ cols: 24, rows: 6, spawns: Array.from({ length: 8 }, (_, i) => ({ x: 500 + i * 300, y: 300 })) }).map,
  replayDir: path.resolve('test-results/hearing-replays') });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  collectBrowserErrors(page, errors, { consoleErrors: true });
  await page.goto(`${base}/?seed=4217`);
  const start = page.getByRole('button', { name: 'Start match', exact: true });
  await start.waitFor({ state: 'visible', timeout: 60000 });
  const room = new URL(page.url()).searchParams.get('room');
  const state = server.rooms.get(room);
  await state.ready;
  const shooters = ['hearing-near', 'hearing-far'];
  for (const id of shooters) assert.ok(state.match.join(id, 'contestant', undefined, id));
  const game = state.game, me = game.players.find(p => !p.bot && !shooters.includes(p.id));
  const positions = [1250, 4200];
  Object.assign(me, { x: 1200, y: 600 });
  shooters.forEach((id, i) => {
    const player = game.players.find(p => p.id === id), weapon = { kind: 'weapon', weaponType: 'pistol', ammo: 12 };
    ensureItemIdentity(game, weapon);
    Object.assign(player, { x: positions[i], y: 600, inventory: [weapon, null, null, null, null, null], selectedSlot: 0 });
  });
  synchronizePhysics(game);
  await start.click();
  await page.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().me?.id, null, { timeout: 120000 });
  for (const id of shooters) assert.ok(state.match.acceptInput(id, { seq: 1, tick: state.match.tick + 1, attack: true, aim: 0 }));
  await page.waitForFunction(() => (window.arenaDebug().me.heard?.length ?? 0) === 2, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.resolve('test-results/hearing.png') });
  // The cue fades: four seconds later the player's frame carries none.
  await page.waitForFunction(() => window.arenaDebug().me.heard === undefined, null, { timeout: 8000 });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true }));
} finally {
  await browser.close(); await server.close();
}
