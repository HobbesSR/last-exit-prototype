import test from 'node:test';
import assert from 'node:assert/strict';
import { roofAt, roofConceals, roofGroups, roofOverhang, roofTargetAlpha, openingDistance, ROOF_FADE_RANGE, ROOF_FADE_FLOOR, ROOF_OVERHANG, playerZoom, markerScale, labelScale, seesPoint, seesActor, revealsActor, viewBounds, viewRadius, observeGates, POTENTIAL_RADIUS, MAX_VIEW_WIDTH, MAX_VIEW_HEIGHT, LABEL_SCREEN_PX, LABEL_FONT_PX, MARKER_ZOOM, LOD_LOW_ZOOM, LOD_LABEL_ZOOM, LOD_MEDIUM_ZOOM } from '../shared/view.ts';
import { visibilityPolygon, litPoint } from '../shared/movement.ts';

test('full viewport corners are visible across supported sizes and zooms within server coverage', () => {
  const eye = { x: 3000, y: 2000 }, map = { obstacles: [], gates: [] };
  for (const [width, height] of [[390, 844], [1440, 1000], [2560, 1440], [7680, 2160]]) {
    const bounds = viewBounds(eye, width, height, playerZoom(width, height));
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

// docs/15: obstacles conceal dynamic actors, including allies, except explicit gladiator reveals.
// This predicate is the single owner of that rule; the world view and the minimap both call it.
test('sight applies concealment, viewport and reveals in the order the information rules state', () => {
  const eye = { x: 1000, y: 1000 };
  const sight = {
    eye,
    bounds: { x: 500, y: 500, width: 1000, height: 1000 },
    points: Array.from({ length: 64 }, (_, i) => {
      const angle = -Math.PI + i * Math.PI * 2 / 64;
      return { angle, x: eye.x + Math.cos(angle) * 400, y: eye.y + Math.sin(angle) * 400, length: 400 };
    })
  };
  const open = { buildings: [] };
  const roofed = { buildings: [{ id: 'shed', x: 1150, y: 950, w: 100, h: 100 }] };
  const gladiator = { id: 'g', role: 'gladiator', x: eye.x, y: eye.y, revealed: 0, cloak: 0 };
  const contestant = { id: 'c', role: 'contestant', x: eye.x, y: eye.y, revealed: 0, cloak: 0 };
  const target = extra => ({ id: 't', role: 'contestant', x: 1200, y: 1000, revealed: 0, cloak: 0, ...extra });

  assert.equal(seesPoint(sight, open, 1200, 1000), true);
  assert.equal(seesPoint(sight, roofed, 1200, 1000), false, 'a roof conceals what is under it');
  assert.equal(seesPoint(sight, open, 1900, 1000), false, 'beyond the lit polygon is unseen');
  assert.equal(seesPoint(null, open, 1200, 1000), false, 'no computed sight knows nothing');

  assert.equal(seesActor(sight, open, contestant, target()), true);
  assert.equal(seesActor(sight, open, contestant, target({ cloak: 6 })), false, 'cloak hides an unrevealed actor');
  assert.equal(seesActor(sight, roofed, contestant, target()), false, 'a contestant cannot see through a roof');
  // The exception, and the case the two views disagreed on before this predicate was shared.
  assert.equal(revealsActor(gladiator, target({ revealed: 12 })), true);
  assert.equal(revealsActor(contestant, target({ revealed: 12 })), false, 'only gladiators hold reveals');
  assert.equal(seesActor(sight, roofed, gladiator, target({ revealed: 12 })), true, 'a reveal beats concealment');
  assert.equal(seesActor(sight, roofed, gladiator, target({ revealed: 12, cloak: 8 })), true, 'a reveal beats cloak');
  assert.equal(seesActor(null, open, gladiator, target({ revealed: 12 })), true, 'a reveal needs no sight polygon');
  assert.equal(seesActor(sight, roofed, gladiator, target()), false, 'an unrevealed actor is still concealed');
});

test('roof groups join abutting rooms that share a door, and nothing else', () => {
  const room = (id, x, y, w = 200, h = 200) => ({ id, x, y, w, h });
  const door = (x, y, w, h, buildingId) => ({ id: `door-${x}-${y}`, x, y, w, h, kind: 'door', open: false, locked: false, buildingId });
  const buildings = [room('a', 0, 0), room('b', 200, 0), room('c', 0, 200), room('d', 600, 0), room('e', 800, 0)];
  // a|b door on the shared vertical edge; c touches a but has no door onto it; d and e touch with no door.
  const gates = [door(190, 80, 20, 40, 'a'), door(900, 20, 20, 40, 'e'), door(680, -9, 40, 18, 'd')];
  const groups = roofGroups({ buildings, gates });
  assert.deepEqual(groups.get('a').map(b => b.id), ['a', 'b']);
  assert.equal(groups.get('a'), groups.get('b'), 'members share one group');
  assert.deepEqual(groups.get('c').map(b => b.id), ['c']);
  assert.deepEqual(groups.get('d').map(b => b.id), ['d']);
  assert.deepEqual(groups.get('e').map(b => b.id), ['e'], 'an exterior door joins nothing');
  assert.equal(roofGroups({ buildings: undefined, gates: [] }).size, 0, 'a map without buildings has no groups');
});

test('a roof overhangs every side except where its group abuts', () => {
  const a = { id: 'a', x: 0, y: 0, w: 200, h: 200 }, b = { id: 'b', x: 200, y: 0, w: 200, h: 200 };
  assert.deepEqual(roofOverhang(a, [a]), { n: ROOF_OVERHANG, e: ROOF_OVERHANG, s: ROOF_OVERHANG, w: ROOF_OVERHANG });
  assert.deepEqual(roofOverhang(a, [a, b]), { n: ROOF_OVERHANG, e: 0, s: ROOF_OVERHANG, w: ROOF_OVERHANG });
  assert.deepEqual(roofOverhang(b, [a, b]), { n: ROOF_OVERHANG, e: ROOF_OVERHANG, s: ROOF_OVERHANG, w: 0 });
});

test('roofs fade toward an opening and vanish for a viewer inside', () => {
  assert.equal(roofTargetAlpha(true, 0), 0);
  assert.equal(roofTargetAlpha(false, Infinity), 1, 'a roof with no opening never fades');
  assert.equal(roofTargetAlpha(false, ROOF_FADE_RANGE), 1);
  assert.equal(roofTargetAlpha(false, 0), ROOF_FADE_FLOOR, 'it stays partly opaque at the threshold');
  assert.ok(roofTargetAlpha(false, ROOF_FADE_RANGE / 2) < 1 && roofTargetAlpha(false, ROOF_FADE_RANGE / 2) > ROOF_FADE_FLOOR);
  const group = [{ id: 'a', x: 0, y: 0, w: 200, h: 200 }];
  const map = { gates: [{ x: 90, y: 190, w: 20, h: 20, buildingId: 'a' }], obstacles: [{ kind: 'window', x: 0, y: 50, w: 10, h: 60, buildingId: 'a' }, { kind: 'window', x: 500, y: 0, w: 10, h: 60, buildingId: 'z' }] };
  assert.equal(openingDistance(map, group, { x: 100, y: 260 }), 50);
  assert.equal(openingDistance(map, group, { x: -30, y: 80 }), 30, 'windows count, and other buildings\' do not');
  assert.equal(openingDistance({ gates: [], obstacles: [] }, group, { x: 0, y: 0 }), Infinity);
});

test('level of detail zoom thresholds maintain strict progression below player zoom', () => {
  assert.ok(LOD_LOW_ZOOM < LOD_LABEL_ZOOM, 'low LOD is tighter than label culling');
  assert.ok(LOD_LABEL_ZOOM < LOD_MEDIUM_ZOOM, 'label culling sits between low and medium LOD');
  assert.ok(LOD_MEDIUM_ZOOM < playerZoom(1440, 1000), 'all LOD thresholds sit strictly below contestant camera zoom');
});

test('declared roofs support concave and holed shapes, spatial containment, and group concealment', () => {
  // L-shaped roof on cells (0,0), (1,0), (0,1) at cellSize 40
  const lRoof = {
    id: 'l-roof',
    groupId: 'wing-1',
    bounds: { x: 0, y: 0, w: 80, h: 80 },
    cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
  };
  const annexRoof = {
    id: 'annex',
    groupId: 'wing-1',
    bounds: { x: 120, y: 0, w: 40, h: 40 },
    cells: [{ x: 3, y: 0 }],
  };
  const shedRoof = {
    id: 'shed',
    groupId: 'shed-group',
    bounds: { x: 0, y: 120, w: 40, h: 40 },
    cells: [{ x: 0, y: 3 }],
  };
  const map = {
    buildings: [],
    roofs: [lRoof, annexRoof, shedRoof],
    playableArea: { cellSize: 40, rows: [] },
  };

  // Inside L-shaped roof
  assert.equal(roofAt(map, { x: 20, y: 20 })?.id, 'l-roof');
  assert.equal(roofAt(map, { x: 60, y: 20 })?.id, 'l-roof');
  assert.equal(roofAt(map, { x: 20, y: 60 })?.id, 'l-roof');
  // In the notch of the L (cell 1,1) -> outside the roof!
  assert.equal(roofAt(map, { x: 60, y: 60 }), null);
  // Outside bounds
  assert.equal(roofAt(map, { x: 200, y: 200 }), null);

  // Concealment
  // Target inside, viewer outside -> concealed
  assert.equal(roofConceals(map, { x: 200, y: 200 }, { x: 20, y: 20 }), true);
  // Viewer and target both inside same roof -> not concealed
  assert.equal(roofConceals(map, { x: 60, y: 20 }, { x: 20, y: 60 }), false);
  // Target in notch (outside), viewer inside -> not concealed
  assert.equal(roofConceals(map, { x: 20, y: 20 }, { x: 60, y: 60 }), false);
  // Viewer in room 1 (lRoof), target in room 2 (annexRoof) sharing groupId 'wing-1' -> not concealed
  assert.equal(roofConceals(map, { x: 20, y: 20 }, { x: 130, y: 20 }), false);
  // Viewer in wing-1, target in shed (shed-group) -> concealed
  assert.equal(roofConceals(map, { x: 20, y: 20 }, { x: 20, y: 130 }), true);
});

test('roofGroups partitions declared roofs by groupId directly', () => {
  const r1 = { id: 'r1', groupId: 'house', bounds: { x: 0, y: 0, w: 40, h: 40 }, cells: [{ x: 0, y: 0 }] };
  const r2 = { id: 'r2', groupId: 'house', bounds: { x: 40, y: 0, w: 40, h: 40 }, cells: [{ x: 1, y: 0 }] };
  const r3 = { id: 'r3', groupId: 'shed', bounds: { x: 200, y: 0, w: 40, h: 40 }, cells: [{ x: 5, y: 0 }] };
  const map = { buildings: [], gates: [], roofs: [r1, r2, r3] };
  const groups = roofGroups(map);
  assert.deepEqual(groups.get('r1')?.map(r => r.id), ['r1', 'r2']);
  assert.equal(groups.get('r1'), groups.get('r2'), 'members share group list instance');
  assert.deepEqual(groups.get('r3')?.map(r => r.id), ['r3']);
});

test('openingDistance measures distance to declared roof threshold cells', () => {
  const roof = {
    id: 'hall',
    groupId: 'hall',
    bounds: { x: 0, y: 0, w: 80, h: 80 },
    cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    thresholds: [{ x: 0, y: 1 }], // Cell at (0..40, 40..80)
  };
  const map = { gates: [], obstacles: [], playableArea: { cellSize: 40, rows: [] } };
  // Standing inside threshold cell (e.g. x: 20, y: 50)
  assert.equal(openingDistance(map, [roof], { x: 20, y: 50 }), 0);
  // 30 units south of the threshold cell (x: 20, y: 110)
  assert.equal(openingDistance(map, [roof], { x: 20, y: 110 }), 30);
});
