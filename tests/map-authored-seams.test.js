import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAIN_LIBRARIES, CHAIN_LIBRARY } from '../map/chain.ts';
import { gridSize } from '../map/macro/src/chain/declared-grid.ts';
import { briefs, chainZones } from '../map/macro/src/chain/briefs.ts';
import { regions } from '../map/macro/src/chain/regions.ts';
import { guaranteesPassability, resolution } from '../map/macro/src/chain/resolution.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';

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

const HINT = 'not-passable-hint';
/** Whether a tile's side, by its six segments, is the half-and-half pattern (`hhhPPP` either way). */
const halfAndHalf = (tile, spec) => {
  const side = Array.from({ length: 6 }, (_, i) => tile.segments?.[spec.segment(i)]?.passability);
  const half = (a, b) => side.slice(0, 3).every(p => p === a) && side.slice(3).every(p => p === b);
  return half(HINT, 'passable') || half('passable', HINT);
};

// Since the sparse-sides adoption (#851, #895), an exposed half-and-half side may also be hinted whole (52.1).
test('authored inward seams lose their guarantee while every exposed region edge keeps its original prescription or is hinted whole', () => {
  for (const library of CHAIN_LIBRARIES) {
    let affected = 0, internal = 0, exposed = 0;
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
          const hintedWhole = halfAndHalf(original, spec) && Array.from({ length: 6 }, (_, i) => current.segments?.[spec.segment(i)]?.passability).every(p => p === HINT);
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
              if (!hintedWhole) assert.deepEqual(actual, before, `${where} keeps its original external prescription`);
            }
          }
        }
      }
    }
    assert.ok(affected > 100 && internal > 0 && exposed > 0,
      `${library.name} exercises the authored variants: ${affected} variant tiles, ${internal} internal and ${exposed} exposed segments`);
  }
  assert.equal(CHAIN_LIBRARIES.length, 3, 'all three library sizes are checked');
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
    // Alternate borders (#851) keep some of the original's external portals, never new ones.
    const before = new Set(original.portals.map(portal => JSON.stringify(portal)));
    assert.ok(current.portals.length > 0, `${piece}: keeps an external portal`);
    for (const portal of current.portals) assert.ok(before.has(JSON.stringify(portal)), `${piece}: ${portal.id} is one of the original runs`);
    assert.ok(original.internalGuaranteed.length > 0, `${piece}: original repeated seams were guaranteed`);
    assert.deepEqual(current.internalGuaranteed, [], `${piece}: variant seams are no longer guaranteed`);
    assert.ok(current.fillCells.length > original.fillCells.length, `${piece}: fill grows`);
    const built = buildRegion(current), previous = buildRegion(original);
    assert.equal(previous.manifest.structures, 0, `${piece}: original seams suppress structures`);
    assert.ok(built.manifest.structures > 0, `${piece}: current fill builds structures`);
    if (type === 'block') assert.ok(built.elements.some(element => /\/lot-\d+\//.test(element.label)), 'block builds a designed child building');
    if (type === 'compound') assert.ok(built.manifest.rooms > 0, 'compound builds rooms');
  }
});

test('authored inward variants stay out of the random fill', () => {
  for (const library of CHAIN_LIBRARIES) {
    const variants = library.tiles.filter(tile => /-ground-inward-/.test(tile.id));
    assert.ok(variants.length > 0, `${library.name} has inward variants`);
    assert.ok(variants.every(tile => tile.fillable === false), `${library.name} inward variants have fillable: false`);
  }
});

test('all resolved libraries contain the L variant alongside their rectangular hall, with compatible prescriptions', () => {
  const sides = [['n', 0, -1, 'h:0'], ['e', 1, 0, 'v:6'], ['s', 0, 1, 'h:6'], ['w', -1, 0, 'v:0']];
  const isHall = (x, y) => x >= 0 && x < 6 && y >= 0 && y < 5 && (y < 2 || x < 3);
  for (const library of CHAIN_LIBRARIES) {
    const piece = library.setPieces.find(p => p.id === 'pillar-hall-winged');
    assert.ok(piece, `${library.name} has pillar-hall-winged`);
    const owner = library.setPieceClasses.find(c => c.setPieces.includes('pillar-hall'));
    assert.ok(owner.setPieces.includes(piece.id));
    assert.ok(library.setPieces.some(p => p.id === 'pillar-hall'));
    assert.equal(piece.primaryRegionClass, 'hall');
    assert.equal(piece.tiles.length, 30);
    const original = library.tiles.find(t => t.id === 'hall-ground');
    assert.ok(original);
    const fieldSet = library.tileSets.find(s => s.id === 'fields');
    const field = library.tiles.find(t => t.id === fieldSet.members[0]);
    assert.equal(field.defaultCellClass, 'open');
    assert.ok(Object.values(field.segments).every(s => s.passability === 'any' && Object.keys(s).length === 1));
    for (const slot of piece.tiles) {
      const { dx: x, dy: y, tileSetId } = slot;
      if (!isHall(x, y)) { assert.equal(tileSetId, 'fields'); continue; }
      const mask = sides.filter(([, dx, dy]) => isHall(x + dx, y + dy)).map(([d]) => d).join('');
      assert.equal(tileSetId.replace(/-sp-\d+$/, ''), `hall-ground-inward-${mask}-tiles`);
      const set = library.tileSets.find(s => s.id === tileSetId);
      const tile = library.tiles.find(t => t.id === set.members[0]);
      assert.equal(tile.defaultCellClass, 'hall');
      for (const [d, dx, dy, prefix] of sides) for (let k = 0; k < 6; k++) {
        const key = `${prefix},${k}`;
        if (isHall(x + dx, y + dy)) assert.equal(tile.segments[key].passability, 'not-passable-hint', `${library.name} ${x},${y} ${d}`);
        else if (!(halfAndHalf(original, { segment: j => `${prefix},${j}` }) && Array.from({ length: 6 }, (_, j) => tile.segments[`${prefix},${j}`]?.passability).every(p => p === HINT)))
          assert.deepEqual(tile.segments[key], original.segments[key], `${library.name} exposed ${x},${y} ${d}`);
      }
    }
  }
});

test('a placed winged variant becomes an L-shaped hall brief with real portals and structural wings', () => {
  const library = CHAIN_LIBRARY, piece = library.setPieces.find(p => p.id === 'pillar-hall-winged');
  assert.ok(piece);
  const ox = 25, oy = 12, slots = [];
  for (let y = -1; y <= 5; y++) for (let x = -1; x <= 6; x++) {
    const slot = piece.tiles.find(t => t.dx === x && t.dy === y);
    const set = library.tileSets.find(s => s.id === (slot?.tileSetId ?? 'fields'));
    slots.push({ col: ox + x, row: oy + y, design: set.members[0], orientation: 0 });
  }
  const params = { mode: 'playground', zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
  for (const seed of ['1', '7', '533']) {
    const layout = { seed, params, library: library.name, slots, setPieces: [] };
    const resolved = resolution(layout, library), found = regions(resolved, layout.seed);
    const region = found.regions.find(r => r.class === 'hall');
    assert.ok(region);
    assert.equal(region.cells.length, 21 * 36);
    const input = briefs(layout, resolved, found, chainZones(params), library, 40).find(b => b.id === region.id);
    assert.ok(input.portals.length > 0);
    assert.equal(input.internalGuaranteed.length, 0);
    const result = buildRegion(input);
    const wings = result.elements.filter(e => e.label.startsWith('hall-wing-'));
    assert.ok(wings.some(e => e.template.parts.length > 0), seed);
    assert.deepEqual(validatePortalReach({ ...input, blockers: result.elements.flatMap(e => elementShapes(e)) }, { search: 'thorough' }).errors, [], seed);
  }
});
