import test from 'node:test';
import assert from 'node:assert/strict';
import { roofAt, roofConceals, roofGroups, roofOverhang, roofCellBorders, roofRevealed, stepRoofAlpha, openingDistance, buildingOpenings, ROOF_REVEAL_RANGE, ROOF_FADE_MS, ROOF_OVERHANG, playerZoom, markerScale, labelScale, seesPoint, seesActor, revealsActor, viewBounds, viewRadius, observeGates, POTENTIAL_RADIUS, MAX_VIEW_WIDTH, MAX_VIEW_HEIGHT, LABEL_SCREEN_PX, LABEL_FONT_PX, MARKER_ZOOM, LOD_LOW_ZOOM, LOD_LABEL_ZOOM, LOD_MEDIUM_ZOOM } from '../shared/view.ts';
import { visibilityPolygon, litPoint } from '../shared/movement.ts';
import { generateLiveMap } from '../map/live.ts';
import { hypot } from '../shared/math.ts';

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

test('declared roof cells drop overhang and edge seams where physically abutting any roof regardless of group', () => {
  // Two roofs touching East-West at x = 40, belonging to different fade groups (#349)
  const west = {
    id: 'west',
    groupId: 'group-1',
    origin: { x: 0, y: 0 },
    cellSize: 40,
    bounds: { x: 0, y: 0, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const east = {
    id: 'east',
    groupId: 'group-2',
    origin: { x: 40, y: 0 },
    cellSize: 40,
    bounds: { x: 40, y: 0, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const map = { roofs: [west, east], buildings: [] };

  const westBorders = roofCellBorders(west, west.cells[0], map);
  assert.equal(westBorders.hasE, false, 'east is not an internal cell');
  assert.equal(westBorders.abutsE, true, 'west roof physically abuts east roof on the east');
  assert.equal(westBorders.abutsW, false, 'west side faces open exterior');
  assert.equal(westBorders.abutsN, false);
  assert.equal(westBorders.abutsS, false);

  const eastBorders = roofCellBorders(east, east.cells[0], map);
  assert.equal(eastBorders.hasW, false, 'west is not an internal cell');
  assert.equal(eastBorders.abutsW, true, 'east roof physically abuts west roof on the west');
  assert.equal(eastBorders.abutsE, false, 'east side faces open exterior');

  // Multi-cell roof with internal cell neighbor
  const twoCell = {
    id: 'two-cell',
    groupId: 'group-3',
    origin: { x: 0, y: 100 },
    cellSize: 40,
    bounds: { x: 0, y: 100, w: 80, h: 40 },
    cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  };
  const map2 = { roofs: [twoCell], buildings: [] };
  const cell0 = roofCellBorders(twoCell, twoCell.cells[0], map2);
  assert.equal(cell0.hasE, true, 'has internal east neighbor');
  assert.equal(cell0.abutsE, false);

  // Mixed map: declared roof physically abutting undeclared building
  const declared = {
    id: 'dec',
    groupId: 'g-dec',
    origin: { x: 0, y: 0 },
    cellSize: 40,
    bounds: { x: 0, y: 0, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const undeclared = { id: 'undec', x: 40, y: 0, w: 40, h: 40 };
  const mixedMap = { roofs: [declared], buildings: [undeclared] };
  const decBorders = roofCellBorders(declared, declared.cells[0], mixedMap);
  assert.equal(decBorders.abutsE, true, 'declared roof abuts undeclared building on east');

  // Unequal cell sizes: 40-unit roof abutting 48-unit roof (#349 review)
  const roof40 = {
    id: 'r40',
    groupId: 'g-40',
    origin: { x: 0, y: 0 },
    cellSize: 40,
    bounds: { x: 0, y: 0, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const roof48 = {
    id: 'r48',
    groupId: 'g-48',
    origin: { x: 40, y: 0 },
    cellSize: 48,
    bounds: { x: 40, y: 0, w: 48, h: 48 },
    cells: [{ x: 0, y: 0 }],
  };
  const unequalMap = { roofs: [roof40, roof48], buildings: [] };
  const b40 = roofCellBorders(roof40, roof40.cells[0], unequalMap);
  const b48 = roofCellBorders(roof48, roof48.cells[0], unequalMap);
  assert.equal(b40.abutsE, true, '40-unit cell abuts 48-unit cell on east');
  assert.equal(b48.abutsW, true, '48-unit cell abuts 40-unit cell on west');
  assert.deepEqual(b40.e.covered, [{ start: 0, end: 40 }]);
  assert.deepEqual(b40.e.exposed, []);
  assert.deepEqual(b48.w.covered, [{ start: 0, end: 40 }]);
  assert.deepEqual(b48.w.exposed, [{ start: 40, end: 48 }], '48-unit cell preserves exposed 8-unit interval');

  // Staggered origins with positive overlap length (#349 review)
  const stag1 = {
    id: 'stag1',
    groupId: 'g-stag1',
    origin: { x: 0, y: 0 },
    cellSize: 40,
    bounds: { x: 0, y: 0, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const stag2 = {
    id: 'stag2',
    groupId: 'g-stag2',
    origin: { x: 40, y: 10 },
    cellSize: 40,
    bounds: { x: 40, y: 10, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const stagMap = { roofs: [stag1, stag2], buildings: [] };
  const bStag1 = roofCellBorders(stag1, stag1.cells[0], stagMap);
  const bStag2 = roofCellBorders(stag2, stag2.cells[0], stagMap);
  assert.equal(bStag1.abutsE, true, 'staggered roof abuts on east (30-unit overlap)');
  assert.equal(bStag2.abutsW, true, 'staggered roof abuts on west (30-unit overlap)');
  assert.deepEqual(bStag1.e.covered, [{ start: 10, end: 40 }]);
  assert.deepEqual(bStag1.e.exposed, [{ start: 0, end: 10 }], 'stag1 preserves exposed y=0..10 interval');
  assert.deepEqual(bStag2.w.covered, [{ start: 10, end: 40 }]);
  assert.deepEqual(bStag2.w.exposed, [{ start: 40, end: 50 }], 'stag2 preserves exposed y=40..50 interval');

  // North/South staggered origins with distinct X/Y coordinates (#349 review)
  const roofSouth = {
    id: 'rSouth',
    groupId: 'g-south',
    origin: { x: 3000, y: 100 },
    cellSize: 40,
    bounds: { x: 3000, y: 100, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const roofNorth = {
    id: 'rNorth',
    groupId: 'g-north',
    origin: { x: 3020, y: 60 },
    cellSize: 40,
    bounds: { x: 3020, y: 60, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const nsMap = { roofs: [roofSouth, roofNorth], buildings: [] };
  const bSouth = roofCellBorders(roofSouth, roofSouth.cells[0], nsMap);
  const bNorth = roofCellBorders(roofNorth, roofNorth.cells[0], nsMap);
  assert.equal(bSouth.abutsN, true);
  assert.equal(bNorth.abutsS, true);
  assert.deepEqual(bSouth.n.covered, [{ start: 3020, end: 3040 }]);
  assert.deepEqual(bSouth.n.exposed, [{ start: 3000, end: 3020 }], 'south roof north edge preserves exposed x=3000..3020');
  assert.deepEqual(bNorth.s.covered, [{ start: 3020, end: 3040 }]);
  assert.deepEqual(bNorth.s.exposed, [{ start: 3040, end: 3060 }], 'north roof south edge preserves exposed x=3040..3060');

  // Corner touch (0 overlap length): does NOT abut (#349 review)
  const corner1 = {
    id: 'c1',
    groupId: 'g-c1',
    origin: { x: 0, y: 0 },
    cellSize: 40,
    bounds: { x: 0, y: 0, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const corner2 = {
    id: 'c2',
    groupId: 'g-c2',
    origin: { x: 40, y: 40 },
    cellSize: 40,
    bounds: { x: 40, y: 40, w: 40, h: 40 },
    cells: [{ x: 0, y: 0 }],
  };
  const cornerMap = { roofs: [corner1, corner2], buildings: [] };
  const bCorner1 = roofCellBorders(corner1, corner1.cells[0], cornerMap);
  assert.equal(bCorner1.abutsE, false, 'corner touch has 0 overlap length, does not abut east');
  assert.equal(bCorner1.abutsS, false, 'corner touch has 0 overlap length, does not abut south');
  assert.deepEqual(bCorner1.e.covered, []);
  assert.deepEqual(bCorner1.e.exposed, [{ start: 0, end: 40 }]);
});

test('roofs are revealed or covered, never partly, and fade between them at a constant rate', () => {
  assert.equal(roofRevealed(true, Infinity), true, 'inside reveals');
  assert.equal(roofRevealed(false, Infinity), false, 'a roof with no opening stays covered from outside');
  assert.equal(roofRevealed(false, 0), true, 'standing on a threshold cell reveals');
  assert.equal(roofRevealed(false, ROOF_REVEAL_RANGE), true, 'at a window reveals');
  assert.equal(roofRevealed(false, ROOF_REVEAL_RANGE + 1), false, 'nearing an opening holds nothing partial');
  assert.equal(stepRoofAlpha(1, true, ROOF_FADE_MS), 0, 'a full fade takes ROOF_FADE_MS');
  assert.equal(stepRoofAlpha(0, false, ROOF_FADE_MS), 1);
  assert.equal(stepRoofAlpha(1, true, ROOF_FADE_MS / 4), 0.75, 'constant rate, not eased');
  assert.equal(stepRoofAlpha(0.75, true, ROOF_FADE_MS / 4), 0.5);
  assert.equal(stepRoofAlpha(0.5, false, ROOF_FADE_MS / 2), 1, 'a flip mid-fade reverses from the current alpha for the remaining share');
  assert.equal(stepRoofAlpha(0.2, true, ROOF_FADE_MS * 10), 0, 'it stops at the target');
  assert.equal(stepRoofAlpha(0.5, true, -16), 0.5, 'a negative frame delta does not move it');
  const group = [{ id: 'a', x: 0, y: 0, w: 200, h: 200 }];
  const map = { gates: [{ x: 90, y: 190, w: 20, h: 20, buildingId: 'a' }], obstacles: [{ kind: 'window', x: 0, y: 50, w: 10, h: 60, buildingId: 'a' }, { kind: 'window', x: 500, y: 0, w: 10, h: 60, buildingId: 'z' }] };
  assert.equal(openingDistance(map, group, { x: 100, y: 260 }), 50);
  assert.equal(openingDistance(map, group, { x: -30, y: 80 }), 30, 'windows count, and other buildings\' do not');
  assert.equal(openingDistance({ gates: [], obstacles: [] }, group, { x: 0, y: 0 }), Infinity);
});

test('the nearest opening is the whole-map scan it replaced, and follows gates replaced or added', () => {
  const map = generateLiveMap(1), groups = [...new Set(roofGroups(map).values())];
  // The former rule: every gate and window on the map, checked for each group (#549).
  const scanned = (gates, group, point) => {
    const ids = new Set(group.flatMap(item => [item.id, item.buildingId].filter(Boolean)));
    const distance = box => hypot(Math.max(box.x - point.x, 0, point.x - box.x - box.w), Math.max(box.y - point.y, 0, point.y - box.y - box.h));
    const boxes = [...group.flatMap(item => (item.thresholds ?? []).map(t => ({ x: item.origin.x + t.x * item.cellSize, y: item.origin.y + t.y * item.cellSize, w: item.cellSize, h: item.cellSize }))),
      ...gates.filter(g => g.buildingId && ids.has(g.buildingId)), ...map.obstacles.filter(o => o.kind === 'window' && o.buildingId && ids.has(o.buildingId))];
    return Math.min(Infinity, ...boxes.map(distance));
  };
  const moved = map.gates.map(g => ({ ...g, x: g.x + 37 })), openings = buildingOpenings(map);
  assert.ok(groups.length > 10 && map.gates.some(g => g.buildingId) && map.obstacles.some(o => o.kind === 'window'));
  for (const group of groups) {
    const { x, y } = group[0].origin ?? group[0];
    for (const point of [{ x, y }, { x: x - 150, y: y + 90 }]) {
      assert.equal(openingDistance(map, group, point, openings), scanned(map.gates, group, point));
      assert.equal(openingDistance({ ...map, gates: moved }, group, point), scanned(moved, group, point));
    }
  }
  // A door pushed onto the same array, as a fixture may, is seen by the next index.
  const group = groups[0], at = group[0].origin ?? group[0], id = group[0].buildingId ?? group[0].id;
  map.gates.push({ id: 'pushed', x: at.x - 400, y: at.y, w: 10, h: 10, buildingId: id });
  assert.equal(openingDistance(map, group, { x: at.x - 400, y: at.y }, buildingOpenings(map)), 0);
});

test('level of detail zoom thresholds maintain strict progression below player zoom', () => {
  assert.ok(LOD_LOW_ZOOM < LOD_LABEL_ZOOM, 'low LOD is tighter than label culling');
  assert.ok(LOD_LABEL_ZOOM < LOD_MEDIUM_ZOOM, 'label culling sits between low and medium LOD');
  assert.ok(LOD_MEDIUM_ZOOM < playerZoom(1440, 1000), 'all LOD thresholds sit strictly below contestant camera zoom');
});

test('declared roofs support concave and holed shapes, spatial containment, and per-room concealment', () => {
  // L-shaped roof on cells (0,0), (1,0), (0,1) at cellSize 40
  const lRoof = {
    id: 'l-roof',
    groupId: 'wing-1',
    bounds: { x: 0, y: 0, w: 80, h: 80 },
    origin: { x: 0, y: 0 },
    cellSize: 40,
    cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
  };
  const annexRoof = {
    id: 'annex',
    groupId: 'wing-1',
    bounds: { x: 120, y: 0, w: 40, h: 40 },
    origin: { x: 0, y: 0 },
    cellSize: 40,
    cells: [{ x: 3, y: 0 }],
  };
  const shedRoof = {
    id: 'shed',
    groupId: 'shed-group',
    bounds: { x: 0, y: 120, w: 40, h: 40 },
    origin: { x: 0, y: 0 },
    cellSize: 40,
    cells: [{ x: 0, y: 3 }],
  };
  const map = {
    buildings: [],
    roofs: [lRoof, annexRoof, shedRoof],
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
  // Viewer in room 1 (lRoof), target in room 2 (annexRoof) sharing groupId 'wing-1' -> concealed (sight is per-room!)
  assert.equal(roofConceals(map, { x: 20, y: 20 }, { x: 130, y: 20 }), true);
  // Viewer in wing-1, target in shed (shed-group) -> concealed
  assert.equal(roofConceals(map, { x: 20, y: 20 }, { x: 20, y: 130 }), true);
});

test('roofGroups partitions declared roofs by groupId directly', () => {
  const r1 = { id: 'r1', groupId: 'house', bounds: { x: 0, y: 0, w: 40, h: 40 }, origin: { x: 0, y: 0 }, cellSize: 40, cells: [{ x: 0, y: 0 }] };
  const r2 = { id: 'r2', groupId: 'house', bounds: { x: 40, y: 0, w: 40, h: 40 }, origin: { x: 0, y: 0 }, cellSize: 40, cells: [{ x: 1, y: 0 }] };
  const r3 = { id: 'r3', groupId: 'shed', bounds: { x: 200, y: 0, w: 40, h: 40 }, origin: { x: 0, y: 0 }, cellSize: 40, cells: [{ x: 5, y: 0 }] };
  const map = { buildings: [], gates: [], roofs: [r1, r2, r3] };
  const groups = roofGroups(map);
  assert.deepEqual(groups.get('r1')?.map(r => r.id), ['r1', 'r2']);
  assert.equal(groups.get('r1'), groups.get('r2'), 'members share group list instance');
  assert.deepEqual(groups.get('r3')?.map(r => r.id), ['r3']);
});

test('openingDistance measures distance to declared roof threshold cells and windows with buildingId', () => {
  const roof = {
    id: 'hall-roof',
    groupId: 'hall',
    bounds: { x: 0, y: 0, w: 80, h: 80 },
    origin: { x: 0, y: 0 },
    cellSize: 40,
    cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    thresholds: [{ x: 0, y: 1 }], // Cell at (0..40, 40..80)
    buildingId: 'b-hall',
  };
  const map = {
    gates: [{ x: 0, y: 40, w: 40, h: 10, buildingId: 'b-hall' }],
    obstacles: [{ kind: 'window', x: 70, y: 0, w: 10, h: 40, buildingId: 'b-hall' }],
  };
  // Inside threshold cell (x: 20, y: 50) -> distance 0
  assert.equal(openingDistance(map, [roof], { x: 20, y: 50 }), 0);
  // 30 units south of the threshold cell (x: 20, y: 110)
  assert.equal(openingDistance(map, [roof], { x: 20, y: 110 }), 30);
  // Near the window (x: 100, y: 20) -> distance 20
  assert.equal(openingDistance(map, [roof], { x: 100, y: 20 }), 20);
});

test('mixed maps with declared roofs and undeclared buildings both conceal and group', () => {
  const declaredRoof = {
    id: 'dec-1',
    groupId: 'g-dec',
    bounds: { x: 0, y: 0, w: 80, h: 80 },
    origin: { x: 0, y: 0 },
    cellSize: 40,
    cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], // notch at (1,1) -> (40..80, 40..80)
    buildingId: 'b-dec',
  };
  const legacyBuilding = {
    id: 'b-legacy',
    x: 500,
    y: 500,
    w: 200,
    h: 200,
  };
  const map = {
    roofs: [declaredRoof],
    buildings: [
      { id: 'b-dec', x: 0, y: 0, w: 80, h: 80 },
      legacyBuilding,
    ],
    gates: [],
  };

  // Declared roof containment
  assert.equal(roofAt(map, { x: 20, y: 20 })?.id, 'dec-1');
  // Declared roof notch is outdoors (not claimed by b-dec)
  assert.equal(roofAt(map, { x: 60, y: 60 }), null);
  // Legacy building is indoors
  assert.equal(roofAt(map, { x: 550, y: 550 })?.id, 'b-legacy');

  // Both conceal an eye outside
  assert.equal(roofConceals(map, { x: 300, y: 300 }, { x: 20, y: 20 }), true);
  assert.equal(roofConceals(map, { x: 300, y: 300 }, { x: 550, y: 550 }), true);
  // Declared and legacy conceal each other
  assert.equal(roofConceals(map, { x: 20, y: 20 }, { x: 550, y: 550 }), true);
  assert.equal(roofConceals(map, { x: 550, y: 550 }, { x: 20, y: 20 }), true);

  // Groups contain both declared and legacy
  const groups = roofGroups(map);
  assert.deepEqual(groups.get('dec-1')?.map(r => r.id), ['dec-1']);
  assert.deepEqual(groups.get('b-legacy')?.map(r => r.id), ['b-legacy']);
});

test('roof geometry works with non-40 cell size and non-zero origins', () => {
  const roof = {
    id: 'odd-roof',
    groupId: 'odd',
    origin: { x: 123, y: 456 },
    cellSize: 48,
    cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }],
    bounds: { x: 123, y: 456, w: 48, h: 96 },
  };
  const map = { roofs: [roof], buildings: [] };

  // Inside cell (0, 0)
  assert.equal(roofAt(map, { x: 123 + 24, y: 456 + 24 })?.id, 'odd-roof');
  // Inside cell (0, 1)
  assert.equal(roofAt(map, { x: 123 + 24, y: 456 + 72 })?.id, 'odd-roof');
  // Just outside cell (1, 0)
  assert.equal(roofAt(map, { x: 123 + 50, y: 456 + 24 }), null);
  // Just outside on the negative side
  assert.equal(roofAt(map, { x: 120, y: 456 + 24 }), null);
});

test('live map: roofs have unique ids, keep map id order, and declare multi-room groups', () => {
  // #530's inward grounds, infill, #534's market, #647's yards and #532's extra huts change object/loot counts.
  // Pin the resulting map IDs so roof creation cannot renumber obstacles, gates or items (#343).
  const map1 = generateLiveMap(1);
  assert.equal(map1.obstacles?.at(-1)?.id, 'o768', 'obstacle IDs stay pinned on seed 1');
  assert.equal(map1.gates?.at(-1)?.id, 'door-444', 'gate IDs stay pinned on seed 1');
  assert.equal(map1.items?.at(-1)?.id, 'item-1782', 'item IDs stay pinned on seed 1');

  const map2 = generateLiveMap(2);
  assert.equal(map2.obstacles?.at(-1)?.id, 'o864', 'obstacle IDs stay pinned on seed 2');
  assert.equal(map2.gates?.at(-1)?.id, 'door-560', 'gate IDs stay pinned on seed 2');
  assert.equal(map2.items?.at(-1)?.id, 'item-1805', 'item IDs stay pinned on seed 2');

  for (const map of [map1, map2]) {
    const ids = new Set(map.roofs.map(r => r.id));
    assert.equal(ids.size, map.roofs.length, 'all roof ids are distinct across the live map');

    // Roof groups must declare multi-room compounds, not drop to all singletons
    const groups = roofGroups(map);
    const uniqueGroupLists = [...new Set([...groups.values()])];
    const groupSizes = uniqueGroupLists.map(list => list.length).sort((a, b) => b - a);
    assert.ok(groupSizes.some(size => size > 1), 'compound buildings declare multi-room groups');

    const samplePoints = map.roofs.map(r => ({
      id: r.id,
      pt: {
        x: r.origin.x + (r.cells[0].x + 0.5) * r.cellSize,
        y: r.origin.y + (r.cells[0].y + 0.5) * r.cellSize,
      },
    }));

    for (let i = 0; i < Math.min(samplePoints.length, 20); i++) {
      for (let j = i + 1; j < Math.min(samplePoints.length, 20); j++) {
        const a = samplePoints[i], b = samplePoints[j];
        assert.equal(roofConceals(map, a.pt, b.pt), true, `roof ${a.id} conceals roof ${b.id}`);
        assert.equal(roofConceals(map, b.pt, a.pt), true, `roof ${b.id} conceals roof ${a.id}`);
      }
    }
  }
});
