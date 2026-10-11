import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAIN_LIBRARIES, CHAIN_LIBRARY } from '../map/chain.ts';
import { gridSize } from '../map/macro/src/chain/declared-grid.ts';
import { briefs } from '../map/macro/src/chain/briefs.ts';
import { regions } from '../map/macro/src/chain/regions.ts';
import { guaranteesPassability, resolution } from '../map/macro/src/chain/resolution.ts';
import { buildRegion } from '../map/micro/region-types.ts';

const SIDES = {
  N: { dx: 0, dy: -1, opposite: 'S', segment: i => `h:0,${i}` },
  E: { dx: 1, dy: 0, opposite: 'W', segment: i => `v:6,${i}` },
  S: { dx: 0, dy: 1, opposite: 'N', segment: i => `h:6,${i}` },
  W: { dx: -1, dy: 0, opposite: 'E', segment: i => `v:0,${i}` },
};
const CLASS = ['block', 'depot', 'compound'];
const PIECES = [
  ['city-block', 'block'],
  ['depot-yard', 'depot'],
  ['walled-base', 'compound'],
];
const PARAMS = { mode: 'playground', zoneWidth: 4, zoneHeight: 3,
  exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };

const ground = id => CLASS.find(kind => id === `${kind}-ground` || id.startsWith(`${kind}-ground-inward-`));
const tileOf = library => {
  const sets = new Map(library.tileSets.map(set => [set.id, set.members[0]]));
  const tiles = new Map(library.tiles.map(tile => [tile.id, tile]));
  return slot => tiles.get(sets.get(slot.tileSetId));
};

test('authored inward seams lose their guarantee while every exposed region edge keeps its original prescription', () => {
  let affected = 0, internal = 0, exposed = 0;
  for (const library of CHAIN_LIBRARIES) {
    const tile = tileOf(library), originals = new Map(library.tiles.map(t => [t.id, t]));
    for (const piece of library.setPieces) {
      const slots = new Map(piece.tiles.map(slot => [`${slot.dx},${slot.dy}`, slot]));
      for (const slot of piece.tiles) {
        const current = tile(slot), kind = ground(current.id);
        if (!kind || current.id === `${kind}-ground`) continue;
        affected++;
        const original = originals.get(`${kind}-ground`);
        assert.ok(original, `${library.name} ${piece.id}: original ${kind} ground`);
        for (const [side, spec] of Object.entries(SIDES)) {
          const neighbor = slots.get(`${slot.dx + spec.dx},${slot.dy + spec.dy}`);
          const across = neighbor && tile(neighbor);
          for (let i = 0; i < 6; i++) {
            const key = spec.segment(i), actual = current.segments?.[key], before = original.segments?.[key];
            const where = `${library.name} ${piece.id} (${slot.dx},${slot.dy}) ${side}:${i}`;
            if (across?.defaultCellClass === kind) {
              internal++;
              const facing = across.segments?.[SIDES[spec.opposite].segment(i)]?.passability;
              assert.equal(guaranteesPassability(actual?.passability, facing), false, `${where} must not reserve a same-class seam`);
            } else {
              exposed++;
              assert.deepEqual(actual, before, `${where} keeps its original external prescription`);
            }
          }
        }
      }
    }
  }
  assert.ok(affected > 500 && internal > 0 && exposed > 0, 'all three library sizes exercise the authored variants');
});

/** Surround one exact set-piece footprint with field, so its original edge portals are derived. */
function pieceBrief(pieceId, type, originalGround = false) {
  const library = CHAIN_LIBRARY, piece = library.setPieces.find(p => p.id === pieceId);
  assert.ok(piece, pieceId);
  const tile = tileOf(library), width = Math.max(...piece.tiles.map(slot => slot.dx)) + 1;
  const height = Math.max(...piece.tiles.map(slot => slot.dy)) + 1;
  const pieceSlots = new Map(piece.tiles.map(slot => [`${slot.dx},${slot.dy}`, slot]));
  const slots = [];
  for (let row = 0; row < height + 2; row++) for (let col = 0; col < width + 2; col++) {
    const inside = pieceSlots.get(`${col - 1},${row - 1}`);
    const authored = inside ? tile(inside).id : 'field';
    slots.push({ col, row, design: originalGround && ground(authored) ? `${type}-ground` : authored, orientation: 0 });
  }
  const { width: gridWidth, height: gridHeight } = gridSize(PARAMS);
  const zones = [{ id: 'fixture', tier: 3, bonus: 0, lootChance: 0.1,
    cells: { x0: 0, y0: 0, x1: gridWidth - 1, y1: gridHeight - 1 } }];
  const layout = { seed: 'authored-seam', params: PARAMS, library: 'fixture', slots, setPieces: [] };
  const resolved = resolution(layout, library), found = regions(resolved, layout.seed);
  const brief = briefs(layout, resolved, found, zones, library, 40).find(b => b.type === type);
  assert.ok(brief, `${pieceId} yields a ${type} brief`);
  return brief;
}

test('representative set pieces retain external portals and regain contiguous building fill', () => {
  for (const [piece, type] of PIECES) {
    const current = pieceBrief(piece, type), original = pieceBrief(piece, type, true);
    assert.deepEqual(current.portals, original.portals, `${piece}: derived external portal runs and ids`);
    assert.ok(original.internalGuaranteed.length > 0, `${piece}: original repeated seams were guaranteed`);
    assert.deepEqual(current.internalGuaranteed, [], `${piece}: variant seams are no longer guaranteed`);
    assert.ok(current.fillCells.length > original.fillCells.length, `${piece}: fill grows`);
    const built = buildRegion(current), previous = buildRegion(original);
    assert.equal(previous.manifest.structures, 0, `${piece}: original seams suppress structures`);
    assert.ok(built.manifest.structures > 0, `${piece}: current fill builds structures`);
    if (type === 'block') assert.ok(built.manifest.designed > 0, 'block builds a designed child building');
    if (type === 'compound') assert.ok(built.manifest.rooms > 0, 'compound builds rooms');
  }
});
