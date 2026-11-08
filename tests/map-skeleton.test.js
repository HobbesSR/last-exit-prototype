import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARIES, validateLibrary, bundledLibrary } from '../map/chain.ts';
import { sparseSidesLibrary } from '../map/sparse-sides.ts';
import { placer, DEFAULT_CHAIN_PARAMS } from '../map/macro/src/chain/placement.ts';
import { buildSkeleton, filterSlotDomains } from '../map/macro/src/chain/skeleton.ts';
import { zonePlan, planTiles } from '../map/macro/src/chain/zone-plan.ts';
import { layoutSlots, makeZones } from '../map/macro/src/chain/zones.ts';
import { stream } from '../map/macro/src/chain/random.ts';
import { orientedDesigns } from '../map/macro/src/chain/declared-grid.ts';

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
  const library = sparseSidesLibrary(bundledLibrary(params), { fill: 'sparse', setPieces: 'alternate' });
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
  const grid = [{
    domain: [
      { templateId: splitTile.id, orientation: 0, difficulty: 0, weight: 1 },
      { templateId: splitTile.id, orientation: 90, difficulty: 0, weight: 1 },
    ],
    links: [],
  }, { domain: [], links: [] }, { domain: [], links: [] }];

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
    { domain: [], links: [] },
    { domain: [], links: [] },
    { domain: [], links: [] },
    { domain: [], links: [] },
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
    { domain: [], links: [] },
    { domain: [], links: [] },
  ];
  const okSingleton = filterSlotDomains(gridSingleton, testLib, forcedSeams);
  assert.equal(okSingleton, false, 'returns false when sole option in singleton domain cannot bridge forced sides');
  assert.equal(gridSingleton[0].domain.length, 0, 'singleton domain is emptied when sole option fails');
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

test('placer with connectivitySkeleton solves sparse/face maps with zero sealed pocket refusals', () => {
  const params = { ...DEFAULT_CHAIN_PARAMS, zoneWidth: 12, zoneHeight: 6 };
  const baseLib = bundledLibrary(params);
  const library = sparseSidesLibrary(baseLib, { fill: 'sparse', setPieces: 'face' });
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
