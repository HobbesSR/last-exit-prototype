import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARY, generate } from '../../map/chain.ts';

// Moved from tests/map-clear-tiles.test.js (#1071): it builds a whole game map, slow-tier work (31).
const CLEAR = ['clear-rubble-bank', 'clear-rubble-bend', 'clear-rubble-center'];
const tile = id => CHAIN_LIBRARY.tiles.find(design => design.id === id);

test('game fill prefers varied ground and builds features instead of mostly plain fields', () => {
  const map = generate('fill-214-1');
  const owned = new Set(map.layout.setPieces.flatMap(piece => piece.slots.map(slot => `${slot.col},${slot.row}`)));
  const fill = map.layout.slots.filter(slot => !owned.has(`${slot.col},${slot.row}`));
  const fields = fill.filter(slot => slot.design === 'field').length;
  assert.ok(fields < fill.length / 2, `${fields}/${fill.length} fill slots are plain fields`);
  for (const id of CLEAR.filter(id => tile(id).fillable !== false)) assert.ok(fill.some(slot => slot.design === id), `${id} occurs in the fill`);
  assert.equal(tile('clear-rubble-center').fillable, false, 'the centered island is placed within an authored courtyard');
  assert.ok(map.results.some(result => result.brief.type === 'rubble' && result.elements.length), 'rubble builds physical features');
});
