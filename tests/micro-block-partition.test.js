import test from 'node:test';
import assert from 'node:assert/strict';
import { planBlock } from '../map/micro/strategies/block.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { REGION_SHAPES, regionExample } from '../map/micro/region-examples.ts';

// The lab's shapes are concave where micro-block's masks are mostly not. There, a lot
// attached to a side that is boundary for only part of its length once walled the
// alleys in two, so the block's portals were joined only because its lots bridged them.
test('a block on any lab shape passes the brief partition check, so its portals are joined by inference (#508)', () => {
  let planned = 0, total = 0;
  for (const { id: shape } of REGION_SHAPES) for (const [width, height] of [[24, 18], [36, 30], [48, 44]]) for (let seed = 1; seed <= 10; seed++) {
    const input = regionExample({ type: 'block', shape, width, height, seed }), { lots, alleys } = planBlock(input);
    total++;
    if (!lots.length) continue;
    planned++;
    assert.deepEqual(validateBriefPartition(input, [...lots, alleys]), [], `${shape} ${width}×${height} seed ${seed}`);
  }
  assert.ok(planned >= 150, `${planned} of ${total} have lots`);
});

test('a lot that would cut the alleys in two is refused, and the block falls back to fewer lots', () => {
  // The neck's only lot would cut its west strip off from the east portal, so it stays open whole.
  assert.equal(planBlock(regionExample({ type: 'block', shape: 'neck', width: 24, height: 18, seed: 1 })).lots.length, 0);
});
