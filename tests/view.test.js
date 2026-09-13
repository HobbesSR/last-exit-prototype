import test from 'node:test';
import assert from 'node:assert/strict';
import { playerZoom, markerScale, labelScale, viewBounds, viewRadius, observeGates, POTENTIAL_RADIUS, MAX_VIEW_WIDTH, MAX_VIEW_HEIGHT, LABEL_SCREEN_PX, LABEL_FONT_PX, MARKER_ZOOM } from '../shared/view.ts';
import { visibilityPolygon, litPoint } from '../shared/movement.ts';

test('full viewport corners are visible across supported sizes and zooms within server coverage', () => {
  const eye = { x: 3000, y: 2000 }, map = { obstacles: [], gates: [] };
  for (const [width, height] of [[390, 844], [1440, 1000], [2560, 1440], [7680, 2160]]) for (const overview of [false, true]) {
    const bounds = viewBounds(eye, width, height, playerZoom(width, height, overview));
    assert.ok(bounds.width <= MAX_VIEW_WIDTH && bounds.height <= MAX_VIEW_HEIGHT);
    const radius = viewRadius(bounds, eye);
    assert.ok(radius + 100 < POTENTIAL_RADIUS, 'network margin covers interpolation and movement');
    const polygon = visibilityPolygon(map, eye, radius);
    for (const x of [bounds.x, bounds.x + bounds.width]) for (const y of [bounds.y, bounds.y + bounds.height]) assert.ok(litPoint(polygon, eye, x, y));
  }
});

test('doors retain observed state through unseen changes, then refresh when seen', () => {
  const eye = { x: 200, y: 200 }, bounds = viewBounds(eye, 1440, 1000, 1);
  const gate = { id: 'door', x: 500, y: 200, open: false };
  const map = { obstacles: [], gates: [gate] }, memory = new Map();
  assert.equal(observeGates(map, eye, bounds, memory, 1)[0].known, true);
  map.obstacles = [{ x: 300, y: 100, w: 40, h: 200 }]; gate.open = true;
  const stale = observeGates(map, eye, bounds, memory, 2)[0];
  assert.equal(stale.open, false); assert.equal(stale.stale, true); assert.equal(stale.lastSeenTick, 1);
  assert.equal(gate.open, true, 'presentation does not mutate collision state');
  map.obstacles = [];
  const seen = observeGates(map, eye, bounds, memory, 3)[0];
  assert.equal(seen.open, true); assert.equal(seen.stale, false); assert.equal(seen.lastSeenTick, 3);
  const far = observeGates(map, eye, viewBounds(eye, 100, 100, 1), new Map(), 4)[0];
  assert.equal(far.known, false); assert.equal(far.open, false, 'unknown is not current secret state');
});

test('markers keep a constant apparent size as a directed camera pulls back, never shrinking below life size', () => {
  const contestant = 43; // The sprite's display size in world units.
  for (const [width, height] of [[390, 844], [1440, 1000], [2560, 1440]]) {
    const played = playerZoom(width, height);
    assert.equal(markerScale(played), 1, 'a player view draws markers at life size');
    // A whole arena view of the real world is two orders of magnitude wider than a player's.
    const arena = Math.min((width - 40) / 24000, (height - 150) / 12000);
    const scale = markerScale(arena);
    assert.ok(contestant * arena < 6, 'an unscaled marker would be a few pixels across');
    assert.ok(Math.abs(contestant * scale * arena - contestant * MARKER_ZOOM) < 1e-9, 'the scaled marker is screen sized');
    for (const zoom of [arena, played, 0.5, 2]) {
      const marker = markerScale(zoom);
      assert.ok(Math.abs(LABEL_FONT_PX * labelScale(zoom, marker) * marker * zoom - LABEL_SCREEN_PX) < 1e-9, 'names hold one pixel height');
      assert.ok(labelScale(zoom, marker) * LABEL_FONT_PX <= LABEL_FONT_PX, 'names are drawn below their authored size, never upscaled');
    }
  }
});
