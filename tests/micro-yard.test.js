import test from 'node:test';
import assert from 'node:assert/strict';
import { hunterBlockFits, floodHunterYard } from '../map/micro/yard.ts';
import { portalEntranceBlocks } from '../map/micro/portals.ts';

test('hunter yards cannot cross a one-cell neck or a diagonal corner', () => {
  // Two 3x2 yards joined only by a one-cell corridor; a third touches diagonally.
  const clear = (x, y) => (y >= 0 && y < 2 && ((x >= 0 && x < 3) || (x >= 5 && x < 8)))
    || (y === 0 && x >= 3 && x < 5) || (x >= 8 && x < 10 && y >= 2 && y < 4);
  const fits = hunterBlockFits(clear);
  const { reached } = floodHunterYard(fits, [{ x: 0, y: 0 }, { x: 3, y: 0 }]);
  assert.deepEqual([...reached.keys()], ['0,0', '1,0']);
  assert.ok(!fits(3, 0), 'invalid seed cannot stand in the neck');
  const union = floodHunterYard(fits, [{ x: 0, y: 0 }, { x: 5, y: 0 }]).reached;
  assert.deepEqual([...union.keys()].sort(), ['0,0', '1,0', '5,0', '6,0']);
  assert.ok(!union.has('8,2'), 'diagonal contact is not a step');
});

test('yard component ids preserve seed order and count preceding blocks', () => {
  const fits = hunterBlockFits((x, y) => y >= 0 && y < 2 && ((x >= -3 && x < 0) || (x >= 2 && x < 4)));
  const labels = new Map();
  floodHunterYard(fits, [{ x: -3, y: 0 }], labels);
  floodHunterYard(fits, [{ x: 2, y: 0 }], labels);
  assert.deepEqual([...labels], [['-3,0', 0], ['-2,0', 0], ['2,0', 2]]);
  floodHunterYard(fits, [{ x: -2, y: 0 }], labels);
  assert.equal(labels.get('-2,0'), 0, 'an existing component retains its id');
});

test('portal entrance blocks straddle horizontal and vertical seams in run order', () => {
  assert.deepEqual(portalEntranceBlocks({ axis: 'h', x: -2, y: 7, length: 4 }),
    [{ x: -2, y: 6 }, { x: -1, y: 6 }, { x: 0, y: 6 }]);
  assert.deepEqual(portalEntranceBlocks({ axis: 'v', x: 7, y: -2, length: 3 }),
    [{ x: 6, y: -2 }, { x: 6, y: -1 }]);
  assert.deepEqual(portalEntranceBlocks({ axis: 'h', x: 0, y: 0, length: 1 }), []);
});
