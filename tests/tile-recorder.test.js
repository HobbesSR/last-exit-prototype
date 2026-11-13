import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

// The browser modules import `/shared/...` by served path; point that at the repository for Node.
const root = new URL('..', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, next) { return next(s.startsWith('/shared/') ? ${JSON.stringify(root)} + s.slice(1) : s, c); }`));
const { TileCache } = await import('../public/tile-cache.js');
const { drawObstacle } = await import('../public/static-drawing.js');
const { themeColors } = await import('../public/palette.js');

// A recorded drawing must hold every call the obstacle makes, in order; a round focal rim is a path.
for (const side of ['N', 'S', 'W', 'E']) test(`a round obstacle's focal rim records on the ${side} side`, () => {
  const cache = new TileCache({ make: { graphics: () => ({}) } }, null, {});
  const tree = { id: 't', kind: 'tree', x: 600, y: 600, r: 20, appearance: { focalRim: { side, color: 'sodiumAmber' } } };
  const ink = themeColors('prototype');
  drawObstacle(cache.record(560, 560, 640, 640), tree, ink, {}, { palette: 'prototype' });
  const calls = cache.drawings[0].filter((_, i) => i % 2 === 0);
  const rim = calls.lastIndexOf('beginPath');
  assert.ok(rim > calls.lastIndexOf('fillCircle'), 'the rim is drawn after the trunk');
  assert.deepEqual(calls.slice(rim), ['beginPath', 'arc', 'strokePath']);
});
