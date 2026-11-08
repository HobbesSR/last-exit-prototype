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

  filterSlotDomains(grid, testLib, forcedSeams);

  const remaining = grid[0].domain.map(d => d.orientation);
  assert.deepEqual(remaining, [90], 'orientation 0 is pruned because its parts cannot bridge North and South');
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
