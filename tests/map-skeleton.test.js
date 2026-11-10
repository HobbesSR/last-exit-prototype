import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARIES, validateLibrary, bundledLibrary } from '../map/chain.ts';
import { placer, DEFAULT_CHAIN_PARAMS, adjacencyCompatibility } from '../map/macro/src/chain/placement.ts';
import { buildSkeleton, filterSlotDomains, skeletonPartRule } from '../map/macro/src/chain/skeleton.ts';
import { zonePlan, planTiles } from '../map/macro/src/chain/zone-plan.ts';
import { layoutSlots, makeZones } from '../map/macro/src/chain/zones.ts';
import { stream } from '../map/macro/src/chain/random.ts';
import { orientedDesigns } from '../map/macro/src/chain/declared-grid.ts';
import { solveWfc } from '../map/macro/src/wfc.ts';

test('connectivitySkeleton validation accepts valid configs and rejects malformed values', () => {
  const base = bundledLibrary(DEFAULT_CHAIN_PARAMS);
  assert.equal(validateLibrary(base).errors.length, 0);

  // Valid boolean
  assert.equal(validateLibrary({ ...base, connectivitySkeleton: true }).errors.length, 0);
  assert.equal(validateLibrary({ ...base, connectivitySkeleton: false }).errors.length, 0);

  // Valid configs
  assert.equal(validateLibrary({ ...base, connectivitySkeleton: { algorithm: 'wilson' } }).errors.length, 0);
  assert.equal(validateLibrary({ ...base, connectivitySkeleton: { algorithm: 'prim', extraOpenShare: 0.15 } }).errors.length, 0);
  assert.equal(validateLibrary({ ...base, connectivitySkeleton: { algorithm: 'kruskal', filterParts: true, shortcutPriority: true } }).errors.length, 0);

  // Invalid algorithm
  const badAlgo = validateLibrary({ ...base, connectivitySkeleton: { algorithm: 'invalid' } });
  assert.ok(badAlgo.errors.some(e => e.includes('unknown skeleton algorithm')));

  // Invalid extraOpenShare
  const badShare = validateLibrary({ ...base, connectivitySkeleton: { extraOpenShare: 1.5 } });
  assert.ok(badShare.errors.some(e => e.includes('extraOpenShare must be a number between 0 and 1')));

  // Invalid type
  const badType = validateLibrary({ ...base, connectivitySkeleton: 'yes' });
  assert.ok(badType.errors.some(e => e.includes('must be a boolean or object')));
});

test('buildSkeleton produces valid spanning trees across all three algorithms (wilson, prim, kruskal)', () => {
  const params = { ...DEFAULT_CHAIN_PARAMS, zoneWidth: 12, zoneHeight: 6 };
  const plan = zonePlan(params);
  const mask = layoutSlots(params, plan);
  const zones = new Map(makeZones(params, plan).map(z => [z.id, z]));
  const library = bundledLibrary(params); // sparse / alternate since #895
  const fillByZone = (zone) => library.tiles.filter(t => t.fillable !== false && t.weight !== 0);

  // Pick set pieces via placer stream 0
  const rand = stream('test-skeleton-tree', 'placement', 0);
  const assigned = new Array(mask.length);
  const instances = [];

  for (const algo of ['wilson', 'prim', 'kruskal']) {
    const resTreeOnly = buildSkeleton(mask, assigned, instances, zones, fillByZone, library, rand, {
      algorithm: algo, extraOpenShare: 0,
    });
    // With 0 set pieces, every slot is a fill node, so nodes = mask.length
    assert.equal(resTreeOnly.treeSeams.length, mask.length - 1, `${algo} tree seam count`);
    assert.equal(resTreeOnly.extraSeams.length, 0, `${algo} extra seam count`);
    assert.equal(resTreeOnly.forcedSeams.length, mask.length - 1, `${algo} forced seam count`);

    // With 15% extra seams
    const resWithLoops = buildSkeleton(mask, assigned, instances, zones, fillByZone, library, rand, {
      algorithm: algo, extraOpenShare: 0.15,
    });
    assert.equal(resWithLoops.treeSeams.length, mask.length - 1);
    assert.ok(resWithLoops.extraSeams.length > 0, `${algo} has extra open seams`);
    assert.equal(resWithLoops.forcedSeams.length, resWithLoops.treeSeams.length + resWithLoops.extraSeams.length);
  }
});

test('multi-part domain filtering prunes split tiles that cannot bridge forced-open sides', () => {
  const library = bundledLibrary(DEFAULT_CHAIN_PARAMS);

  // Author a synthetic tile with 2 completely disconnected parts:
  // rows 0..2 are rubble, rows 3..5 are open, with a full hint (no portal) between them.
  const splitTile = {
    id: 'synthetic-split-tile',
    defaultCellClass: 'open',
    legend: { R: 'rubble' },
    cells: [
      'RRRRRR',
      'RRRRRR',
      'RRRRRR',
      '......',
      '......',
      '......',
    ],
    segments: {
      'h:3,0': { passability: 'not-passable-hint' },
      'h:3,1': { passability: 'not-passable-hint' },
      'h:3,2': { passability: 'not-passable-hint' },
      'h:3,3': { passability: 'not-passable-hint' },
      'h:3,4': { passability: 'not-passable-hint' },
      'h:3,5': { passability: 'not-passable-hint' },
    },
    orientations: [0, 90],
  };

  const testLib = {
    ...library,
    tiles: [...library.tiles, splitTile],
  };

  // Create a grid cell with the split tile options (orientation 0 has split N/S, orientation 90 has split W/E)
  const grid = [
    {
      domain: [
        { templateId: splitTile.id, orientation: 0, difficulty: 0, weight: 1 },
        { templateId: splitTile.id, orientation: 90, difficulty: 0, weight: 1 },
      ],
      links: [],
    },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
  ];

  // Force open North (slot 1 to South of slot 0) and South (slot 0 to South of slot 2)
  // Slot 0 has forced sides North and South.
  // Orientation 0 cannot bridge North and South (the hint divides top from bottom).
  // Orientation 90 CAN bridge North and South (the division runs vertically).
  const forcedSeams = [
    { slotA: 1, slotB: 0, dir: 'S', isTree: true },
    { slotA: 0, slotB: 2, dir: 'S', isTree: true },
  ];

  const ok = filterSlotDomains(grid, testLib, forcedSeams);
  assert.equal(ok, true);

  const remaining = grid[0].domain.map(d => d.orientation);
  assert.deepEqual(remaining, [90], 'orientation 0 is pruned because its parts cannot bridge North and South');

  // If forced sides also require West (N, S, E, W), neither 0 (split N/S) nor 90 (split W/E) can bridge all sides.
  // The domain should become empty and filterSlotDomains must return false (not silently keep options).
  const fourSides = [
    { slotA: 1, slotB: 0, dir: 'S', isTree: true },
    { slotA: 0, slotB: 2, dir: 'S', isTree: true },
    { slotA: 0, slotB: 3, dir: 'E', isTree: true },
    { slotA: 4, slotB: 0, dir: 'E', isTree: true },
  ];
  const gridEmpty = [
    {
      domain: [
        { templateId: splitTile.id, orientation: 0, difficulty: 0, weight: 1 },
        { templateId: splitTile.id, orientation: 90, difficulty: 0, weight: 1 },
      ],
      links: [],
    },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
  ];
  const okEmpty = filterSlotDomains(gridEmpty, testLib, fourSides);
  assert.equal(okEmpty, false, 'returns false when all options in domain are pruned');
  assert.equal(gridEmpty[0].domain.length, 0, 'domain is emptied rather than silently retaining invalid options');

  // Singleton domain with a split tile that cannot bridge forced sides:
  // Orientation 0 cannot bridge North and South. It must be pruned, emptying the domain and returning false.
  const gridSingleton = [
    {
      domain: [
        { templateId: splitTile.id, orientation: 0, difficulty: 0, weight: 1 },
      ],
      links: [],
    },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: 'field', orientation: 0, difficulty: 0, weight: 1 }], links: [] },
  ];
  const okSingleton = filterSlotDomains(gridSingleton, testLib, forcedSeams);
  assert.equal(okSingleton, false, 'returns false when sole option in singleton domain cannot bridge forced sides');
  assert.equal(gridSingleton[0].domain.length, 0, 'singleton domain is emptied when sole option fails');
});

test('multi-part filter rejects E/W split tile when east and west neighbors have crossings in different parts', () => {
  const library = bundledLibrary(DEFAULT_CHAIN_PARAMS);

  // Tile A (middle): split horizontally into upper (rows 0..1 open) and lower (rows 4..5 open)
  // separated by a rubble barrier (rows 2..3). Both open parts touch West (x=0) and East (x=5) geometrically.
  const splitTile = {
    id: 'ew-split-tile',
    defaultCellClass: 'open',
    legend: { R: 'rubble' },
    cells: [
      '......',
      '......',
      'RRRRRR',
      'RRRRRR',
      '......',
      '......',
    ],
    segments: {
      'h:2,0': { passability: 'not-passable-hint' },
      'h:2,1': { passability: 'not-passable-hint' },
      'h:2,2': { passability: 'not-passable-hint' },
      'h:2,3': { passability: 'not-passable-hint' },
      'h:2,4': { passability: 'not-passable-hint' },
      'h:2,5': { passability: 'not-passable-hint' },
      'h:4,0': { passability: 'not-passable-hint' },
      'h:4,1': { passability: 'not-passable-hint' },
      'h:4,2': { passability: 'not-passable-hint' },
      'h:4,3': { passability: 'not-passable-hint' },
      'h:4,4': { passability: 'not-passable-hint' },
      'h:4,5': { passability: 'not-passable-hint' },
      'v:0,2': { passability: 'not-passable-hint' },
      'v:0,3': { passability: 'not-passable-hint' },
      'v:6,2': { passability: 'not-passable-hint' },
      'v:6,3': { passability: 'not-passable-hint' },
    },
    orientations: [0],
  };

  // West neighbor (slot 1): East border has open on rows 0..2, hinted hut on rows 3..5
  const upperOnlyTile = {
    id: 'upper-only-tile',
    defaultCellClass: 'open',
    legend: { H: 'hut' },
    cells: [
      '......',
      '......',
      '......',
      'HHHHHH',
      'HHHHHH',
      'HHHHHH',
    ],
    segments: {
      'h:3,0': { passability: 'not-passable-hint' },
      'h:3,1': { passability: 'not-passable-hint' },
      'h:3,2': { passability: 'not-passable-hint' },
      'h:3,3': { passability: 'not-passable-hint' },
      'h:3,4': { passability: 'not-passable-hint' },
      'h:3,5': { passability: 'not-passable-hint' },
      'v:6,3': { passability: 'not-passable-hint' },
      'v:6,4': { passability: 'not-passable-hint' },
      'v:6,5': { passability: 'not-passable-hint' },
    },
    orientations: [0],
  };

  // East neighbor (slot 2): West border has hinted hut on rows 0..2, open on rows 3..5
  const lowerOnlyTile = {
    id: 'lower-only-tile',
    defaultCellClass: 'open',
    legend: { H: 'hut' },
    cells: [
      'HHHHHH',
      'HHHHHH',
      'HHHHHH',
      '......',
      '......',
      '......',
    ],
    segments: {
      'h:3,0': { passability: 'not-passable-hint' },
      'h:3,1': { passability: 'not-passable-hint' },
      'h:3,2': { passability: 'not-passable-hint' },
      'h:3,3': { passability: 'not-passable-hint' },
      'h:3,4': { passability: 'not-passable-hint' },
      'h:3,5': { passability: 'not-passable-hint' },
      'v:0,0': { passability: 'not-passable-hint' },
      'v:0,1': { passability: 'not-passable-hint' },
      'v:0,2': { passability: 'not-passable-hint' },
    },
    orientations: [0],
  };

  const testLib = {
    ...library,
    tiles: [...library.tiles, splitTile, upperOnlyTile, lowerOnlyTile],
  };

  // Slot 0 is middle tile. Slot 1 is West neighbor. Slot 2 is East neighbor.
  const grid = [
    { domain: [{ templateId: splitTile.id, orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: upperOnlyTile.id, orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: lowerOnlyTile.id, orientation: 0, difficulty: 0, weight: 1 }], links: [] },
  ];

  // Seams: slot 1 (West) to slot 0 (dir 'E'), slot 0 to slot 2 (East, dir 'E')
  const forcedSeams = [
    { slotA: 1, slotB: 0, dir: 'E', isTree: true },
    { slotA: 0, slotB: 2, dir: 'E', isTree: true },
  ];

  const ok = filterSlotDomains(grid, testLib, forcedSeams);
  // Both parts touch West and East boundaries, but crossings are in different parts:
  // West crossing is in Part 0 (upper), East crossing is in Part 2 (lower; the rubble band is Part 1).
  // The filter must reject the split tile, emptying slot 0's domain and returning false.
  assert.equal(ok, false, 'rejects tile whose forced crossings belong to disconnected parts');
  assert.equal(grid[0].domain.length, 0, 'domain emptied when no part can bridge both crossings');

  // Control: both neighbours reach the upper part, so one part carries both crossings.
  const control = [
    { domain: [{ templateId: splitTile.id, orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: upperOnlyTile.id, orientation: 0, difficulty: 0, weight: 1 }], links: [] },
    { domain: [{ templateId: upperOnlyTile.id, orientation: 0, difficulty: 0, weight: 1 }], links: [] },
  ];
  assert.equal(filterSlotDomains(control, testLib, forcedSeams), true, 'keeps tile when one part carries every crossing');
  assert.equal(control[0].domain.length, 1);
});

test('skeletonPartRule enforces crossing-component consistency during WFC solve (#883 review 708)', () => {
  const library = bundledLibrary(DEFAULT_CHAIN_PARAMS);

  // Center tile: split horizontally into upper (rows 0..1) and lower (rows 4..5) parts by rubble (rows 2..3)
  const splitTile = {
    id: 'wfc-split-tile',
    defaultCellClass: 'open',
    legend: { R: 'rubble' },
    cells: [
      '......',
      '......',
      'RRRRRR',
      'RRRRRR',
      '......',
      '......',
    ],
    segments: {
      'h:2,0': { passability: 'not-passable-hint' },
      'h:2,1': { passability: 'not-passable-hint' },
      'h:2,2': { passability: 'not-passable-hint' },
      'h:2,3': { passability: 'not-passable-hint' },
      'h:2,4': { passability: 'not-passable-hint' },
      'h:2,5': { passability: 'not-passable-hint' },
      'h:4,0': { passability: 'not-passable-hint' },
      'h:4,1': { passability: 'not-passable-hint' },
      'h:4,2': { passability: 'not-passable-hint' },
      'h:4,3': { passability: 'not-passable-hint' },
      'h:4,4': { passability: 'not-passable-hint' },
      'h:4,5': { passability: 'not-passable-hint' },
      'v:0,2': { passability: 'not-passable-hint' },
      'v:0,3': { passability: 'not-passable-hint' },
      'v:6,2': { passability: 'not-passable-hint' },
      'v:6,3': { passability: 'not-passable-hint' },
    },
    orientations: [0],
  };

  // West neighbor option A: upper-only crossing (East border rows 0..2 open, 3..5 blocked)
  const westUpperTile = {
    id: 'wfc-west-upper',
    defaultCellClass: 'open',
    legend: { H: 'hut' },
    cells: [
      '......',
      '......',
      '......',
      'HHHHHH',
      'HHHHHH',
      'HHHHHH',
    ],
    segments: {
      'h:3,0': { passability: 'not-passable-hint' },
      'h:3,1': { passability: 'not-passable-hint' },
      'h:3,2': { passability: 'not-passable-hint' },
      'h:3,3': { passability: 'not-passable-hint' },
      'h:3,4': { passability: 'not-passable-hint' },
      'h:3,5': { passability: 'not-passable-hint' },
      'v:6,3': { passability: 'not-passable-hint' },
      'v:6,4': { passability: 'not-passable-hint' },
      'v:6,5': { passability: 'not-passable-hint' },
    },
    orientations: [0],
  };

  // West neighbor option B: lower-only crossing (East border rows 0..2 blocked, 3..5 open)
  const westLowerTile = {
    id: 'wfc-west-lower',
    defaultCellClass: 'open',
    legend: { H: 'hut' },
    cells: [
      'HHHHHH',
      'HHHHHH',
      'HHHHHH',
      '......',
      '......',
      '......',
    ],
    segments: {
      'h:3,0': { passability: 'not-passable-hint' },
      'h:3,1': { passability: 'not-passable-hint' },
      'h:3,2': { passability: 'not-passable-hint' },
      'h:3,3': { passability: 'not-passable-hint' },
      'h:3,4': { passability: 'not-passable-hint' },
      'h:3,5': { passability: 'not-passable-hint' },
      'v:6,0': { passability: 'not-passable-hint' },
      'v:6,1': { passability: 'not-passable-hint' },
      'v:6,2': { passability: 'not-passable-hint' },
    },
    orientations: [0],
  };

  // East neighbor: upper-only crossing (West border rows 0..2 open, 3..5 blocked)
  const eastUpperTile = {
    id: 'wfc-east-upper',
    defaultCellClass: 'open',
    legend: { H: 'hut' },
    cells: [
      '......',
      '......',
      '......',
      'HHHHHH',
      'HHHHHH',
      'HHHHHH',
    ],
    segments: {
      'h:3,0': { passability: 'not-passable-hint' },
      'h:3,1': { passability: 'not-passable-hint' },
      'h:3,2': { passability: 'not-passable-hint' },
      'h:3,3': { passability: 'not-passable-hint' },
      'h:3,4': { passability: 'not-passable-hint' },
      'h:3,5': { passability: 'not-passable-hint' },
      'v:0,3': { passability: 'not-passable-hint' },
      'v:0,4': { passability: 'not-passable-hint' },
      'v:0,5': { passability: 'not-passable-hint' },
    },
    orientations: [0],
  };

  const testLib = {
    ...library,
    tiles: [...library.tiles, splitTile, westUpperTile, westLowerTile, eastUpperTile],
  };

  const forcedSeams = [
    { slotA: 1, slotB: 0, dir: 'E', isTree: true },
    { slotA: 0, slotB: 2, dir: 'E', isTree: true },
  ];

  const opt = (id) => ({ templateId: id, orientation: 0, difficulty: 0, weight: 1 });

  // West neighbor has both lower-only and upper-only alternatives; East neighbor is upper-only.
  // Pre-solve domain filter passes because the upper-only alternative supports the skeleton.
  const grid = [
    { domain: [opt(splitTile.id)], links: [{ cell: 1, relation: 'W:must-open' }, { cell: 2, relation: 'E:must-open' }] },
    { domain: [opt(westLowerTile.id), opt(westUpperTile.id)], links: [{ cell: 0, relation: 'E:must-open' }] },
    { domain: [opt(eastUpperTile.id)], links: [{ cell: 0, relation: 'W:must-open' }] },
  ];

  assert.equal(filterSlotDomains(grid, testLib, forcedSeams), true, 'survives pre-solve filter with alternative options');

  // During WFC, westLowerTile is tried first, but skeletonPartRule rejects the inconsistent crossing.
  // The solver backjumps and successfully chooses westUpperTile.
  const partRule = skeletonPartRule(testLib, forcedSeams);
  const solved = solveWfc(grid, adjacencyCompatibility(testLib), () => 0.1, { accept: partRule });
  assert.ok(solved, 'WFC solve completes by backtracking out of the inconsistent component choice');
  assert.equal(solved[1].domain[0].templateId, westUpperTile.id, 'solver selects consistent upper-crossing alternative');

  // When only the lower-only choice is available on the west, the solve must fail (cannot yield an accepted skeleton)
  const failGrid = [
    { domain: [opt(splitTile.id)], links: [{ cell: 1, relation: 'W:must-open' }, { cell: 2, relation: 'E:must-open' }] },
    { domain: [opt(westLowerTile.id)], links: [{ cell: 0, relation: 'E:must-open' }] },
    { domain: [opt(eastUpperTile.id)], links: [{ cell: 0, relation: 'W:must-open' }] },
  ];
  const failSolved = solveWfc(failGrid, adjacencyCompatibility(testLib), () => 0.1, { accept: partRule });
  assert.equal(failSolved, null, 'lower-only choice cannot yield an accepted skeleton');
});

test('buildSkeleton rejects seams between unassigned fill slots when no zone options can connect', () => {
  const library = bundledLibrary(DEFAULT_CHAIN_PARAMS);

  // Tile A is 'open' class with not-passable-hint on its East edge
  const solidEastTile = {
    id: 'solid-east-tile',
    defaultCellClass: 'open',
    cells: Array(6).fill('......'),
    segments: {
      'v:6,0': { passability: 'not-passable-hint' },
      'v:6,1': { passability: 'not-passable-hint' },
      'v:6,2': { passability: 'not-passable-hint' },
      'v:6,3': { passability: 'not-passable-hint' },
      'v:6,4': { passability: 'not-passable-hint' },
      'v:6,5': { passability: 'not-passable-hint' },
    },
    orientations: [0],
  };

  // Tile B is 'rubble' class with not-passable-hint on its West edge
  const solidWestTile = {
    id: 'solid-west-tile',
    defaultCellClass: 'rubble',
    cells: Array(6).fill('RRRRRR'),
    legend: { R: 'rubble' },
    segments: {
      'v:0,0': { passability: 'not-passable-hint' },
      'v:0,1': { passability: 'not-passable-hint' },
      'v:0,2': { passability: 'not-passable-hint' },
      'v:0,3': { passability: 'not-passable-hint' },
      'v:0,4': { passability: 'not-passable-hint' },
      'v:0,5': { passability: 'not-passable-hint' },
    },
    orientations: [0],
  };

  const testLib = {
    ...library,
    tiles: [...library.tiles, solidEastTile, solidWestTile],
  };

  const mask = [
    { x: 0, y: 0, zoneId: 'zoneA' },
    { x: 1, y: 0, zoneId: 'zoneB' },
  ];
  const zones = new Map([
    ['zoneA', { id: 'zoneA' }],
    ['zoneB', { id: 'zoneB' }],
  ]);
  const fillByZone = (z) => z.id === 'zoneA' ? [solidEastTile] : [solidWestTile];
  const assigned = [undefined, undefined];
  const rand = stream('test-unassigned-connect', 'placement', 0);

  const res = buildSkeleton(mask, assigned, [], zones, fillByZone, testLib, rand, { algorithm: 'kruskal' });
  // Because solidEastTile and solidWestTile have different classes and no passable portals, they cannot connect East
  assert.equal(res.forcedSeams.length, 0, 'no candidate seam between zones that cannot connect');
});

test('placer with connectivitySkeleton solves the bundled sparse / alternate maps with zero sealed pocket refusals', () => {
  const params = { ...DEFAULT_CHAIN_PARAMS, zoneWidth: 12, zoneHeight: 6 };
  const library = structuredClone(bundledLibrary(params));
  library.connectivitySkeleton = { algorithm: 'kruskal', extraOpenShare: 0.15 };

  let pocketRefusals = 0;
  const attempts = [];
  const layout = placer({
    openFace: true,
    attempts: (att) => attempts.push(att),
    trace: (event) => {
      if (event.type === 'refusal' && (event.kind === 'sealed' || event.kind === 'pocket')) {
        pocketRefusals++;
      }
    },
  })('size-12-1', params, library);

  assert.ok(layout);
  assert.equal(layout.slots.length, 936);
  assert.equal(pocketRefusals, 0, 'zero sealed pocket refusals with connectivity skeleton');
});
