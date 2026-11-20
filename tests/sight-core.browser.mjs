import assert from 'node:assert/strict';
import { collectBrowserErrors, serveWithBrowser } from './helpers/browser.js';
import { VISION } from '../shared/sight.ts';
import { initCoreSight } from '../shared/sight-core.ts';
import { buildCore } from '../tools/build-core.mjs';
import { readArena } from '../tools/room-arena.mjs';

// The Rust core in Chrome (#1175 stage 2, docs/27): the client page loads it as it starts, and the
// polygons it casts there equal the core's in Node bit for bit. Each side flattens its points to float64
// bytes, so a signed zero or a last-bit difference fails; tests/sight-core.test.js pins Node's polygons
// by digest across its edge cases.
const { map } = readArena();
let state = 11;
const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
const origins = Array.from({ length: 120 }, () => ({ x: next() * map.width, y: next() * map.height }));
// All closed, all open, and alternating, so the open-gate mask is read per gate.
const gateStates = [map.gates.map(() => false), map.gates.map(() => true), map.gates.map((_, i) => i % 2 === 0)];

/** Per polygon its length, then each point's x, y, angle and length, as float64 bytes in hex. */
const bytesOf = values => Array.from(new Uint8Array(new Float64Array(values).buffer), b => b.toString(16).padStart(2, '0')).join('');
buildCore(); // Node's core is the embedded module, built before its first use.
const { visibilityPolygon } = await initCoreSight(), expected = [];
for (const states of gateStates) {
  map.gates.forEach((g, i) => { g.open = states[i]; });
  for (const origin of origins) {
    const points = visibilityPolygon(map, origin, VISION);
    expected.push(points.length);
    for (const p of points) expected.push(p.x, p.y, p.angle, p.length);
  }
}

const { server, base, browser } = await serveWithBrowser({ replayDir: 'test-results/sight-core-browser-replays' });
try {
  const page = await browser.newPage();
  const errors = []; collectBrowserErrors(page, errors);
  // The client loads the core before its scene, so a failed load or an adapter mismatch is a page error.
  await page.goto(base);
  // client.js sets arenaDebug after its top-level await of the core, so this shows it got past the load.
  await page.waitForFunction(() => typeof window.arenaDebug === 'function');
  const actual = await page.evaluate(async ({ map, origins, gateStates, radius }) => {
    const { initCoreSight } = await import('/shared/sight-core.ts');
    const sight = await initCoreSight(), values = [];
    for (const states of gateStates) {
      map.gates.forEach((g, i) => { g.open = states[i]; });
      for (const origin of origins) {
        const points = sight.visibilityPolygon(map, origin, radius);
        values.push(points.length);
        for (const p of points) values.push(p.x, p.y, p.angle, p.length);
      }
    }
    return Array.from(new Uint8Array(new Float64Array(values).buffer), b => b.toString(16).padStart(2, '0')).join('');
  }, { map, origins, gateStates, radius: VISION });
  assert.ok(actual === bytesOf(expected), 'the core\'s polygons in Chrome equal its polygons in Node, byte for byte');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, browser: browser.version(), polygons: origins.length * gateStates.length,
    checks: ['client page loads the core', 'Chrome core / Node core polygon byte equality'] }));
} finally { await browser.close(); await server.close(); }
