import test from 'node:test';
import assert from 'node:assert/strict';
import { tracePlacement } from '../map/tools/core.ts';
import { CHAIN_LIBRARY, chainParams } from '../map/chain.ts';
import { placement, PLACEMENT_ATTEMPTS } from '../map/macro/src/chain/placement.ts';

const params = { mode: 'playground', zoneWidth: 2, zoneHeight: 2 };

test('placement recording retains a serializable replay of the unchanged layout', () => {
  const recording = tracePlacement('trace-tool', params);
  assert.equal(recording.error, null);
  assert.equal(recording.truncated, false);
  assert.deepEqual(recording.layout, placement('trace-tool', chainParams(params), CHAIN_LIBRARY));
  const slots = new Map();
  const assigned = new Map();
  for (const event of JSON.parse(JSON.stringify(recording.events))) {
    if (event.type === 'attempt-start') { slots.clear(); assigned.clear(); for (const slot of event.slots) slots.set(slot.slot, slot); }
    if (event.type === 'set-piece-slot') assigned.set(event.slot, event);
    if (event.type === 'collapse') for (const slot of event.slots) assigned.set(slot.slot, slot);
    if (event.type === 'undo') for (const slot of event.slots) assigned.delete(slot);
  }
  assert.deepEqual([...assigned].map(([index, tile]) => ({ col: slots.get(index).col, row: slots.get(index).row, design: tile.design, orientation: tile.orientation }))
    .sort((a, b) => a.row - b.row || a.col - b.col), recording.layout.slots);
  assert.equal(recording.events.at(-1).outcome, 'placed');
});

test('collection limit retains a prefix while placement completes normally', () => {
  const full = tracePlacement('trace-tool', params);
  const limited = tracePlacement('trace-tool', params, undefined, 0);
  assert.equal(limited.truncated, true);
  assert.deepEqual(limited.events, []);
  assert.deepEqual(limited.layout, full.layout);
  assert.equal(limited.error, null);
  assert.throws(() => tracePlacement('x', params, undefined, -1), /limit/);
});

test('a failed placement keeps all attempts and their pre-choice failures', () => {
  const library = structuredClone(CHAIN_LIBRARY);
  // The library stays structurally valid, but no anchor can cover this piece.
  const piece = library.setPieces.find(p => library.setPieceClasses.some(c => c.setPieces.includes(p.id)));
  piece.tiles = piece.tiles.map(tile => ({ ...tile, dx: tile.dx + 10000 }));
  const recording = tracePlacement('trace-failure', {}, library);
  assert.ok(recording.error?.includes('placement found no valid layout'));
  assert.equal(recording.layout, null);
  assert.equal(recording.events.filter(e => e.type === 'attempt-start').length, PLACEMENT_ATTEMPTS);
  assert.ok(recording.events.some(e => e.type === 'set-piece-failed'));
  assert.equal(recording.events.filter(e => e.type === 'attempt-end').length, PLACEMENT_ATTEMPTS);
});
