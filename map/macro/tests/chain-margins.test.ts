import assert from 'node:assert/strict';
import test from 'node:test';
import type { Cell } from '../../kernel/cell.ts';
import { applyClearConstraints, clearFootprint } from '../../kernel/margins.ts';
import type { Run } from '../../kernel/run.ts';
import { briefs } from '../src/chain/briefs.ts';
import type { ChainLibrary } from '../src/chain/library.ts';
import type { ChainParams, Layout, LayoutRegions, ResolvedLayout, Zone } from '../src/chain/types.ts';

const cell = (x: number, y: number): Cell => ({ x, y });
const cells = (x0: number, y0: number, x1: number, y1: number): Cell[] => {
  const result: Cell[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) result.push(cell(x, y));
  return result;
};
const coordinates = (items: readonly Cell[]): string[] => items.map(({ x, y }) => `${x},${y}`);

test('clear footprint is a canonical union with endpoint caps, independent of run grouping', () => {
  const playable = cells(0, 0, 5, 3);
  const whole: Run = { axis: 'h', x: 1, y: 2, length: 3 };
  const split: Run[] = [{ axis: 'h', x: 1, y: 2, length: 1 }, { axis: 'h', x: 2, y: 2, length: 2 }];
  const expected = [...cells(0, 1, 4, 2)];
  assert.deepEqual(clearFootprint([whole], playable), expected);
  assert.deepEqual(clearFootprint([...split, whole], playable), expected);
  assert.deepEqual(clearFootprint([{ axis: 'v', x: 1, y: 0, length: 2 }], playable), cells(0, 0, 1, 2));
  assert.deepEqual(clearFootprint([whole], cells(2, 1, 3, 2)), cells(2, 1, 3, 2));
  assert.throws(() => clearFootprint([{ axis: 'q', x: 1, y: 1, length: 1 } as unknown as Run], playable), /axis/);
});

test('inherited clear constraints are idempotent and keep access context near original ownership', () => {
  const owned = [cell(1, 1), cell(2, 1)];
  const clear = [cell(0, 1), cell(1, 1), cell(4, 1)];
  const first = applyClearConstraints(owned, clear);
  assert.deepEqual(first.fillCells, [cell(2, 1)]);
  assert.deepEqual(first.clearCells, [cell(0, 1), cell(1, 1)]);
  assert.deepEqual(applyClearConstraints(owned, clear, first.clearCells), first);
  assert.deepEqual(applyClearConstraints(owned, [cell(1, 1), cell(2, 1)]).fillCells, []);
});

const params: ChainParams = { mode: 'playground', zoneWidth: 1, zoneHeight: 1, contestantCount: 1,
  hunterCount: 1, exitCount: 1, lootChance: 0, lootTierStep: 0 };
const layout: Layout = { seed: 'margin-test', params, library: 'margin-test', slots: [], setPieces: [] };
const library = { cellClasses: { a: { regionType: 'open' }, b: { regionType: 'open' }, c: { regionType: 'open' } } } as unknown as ChainLibrary;
const zones: Zone[] = [{ id: 'all', tier: 1, bonus: 0, lootChance: 0, cells: { x0: 0, y0: 0, x1: 29, y1: 29 } }];
const index = (x: number, y: number): number => y * 30 + x;
const region = (id: string, positions: Cell[]) => ({ id, seed: 1, class: id, cells: positions.map(({ x, y }) => index(x, y)).sort((a, b) => a - b) });

test('macro briefs clear resolved guarantees across owners, including endpoint third owner and internal seams', () => {
  const a = [cell(1, 1), cell(1, 2), cell(2, 1), cell(2, 2)];
  const b = [cell(3, 1), cell(3, 2)];
  const c = [cell(2, 0)]; // Endpoint cap touches an owner outside the two sides of the seam.
  const found: LayoutRegions = { regions: [region('a', a), region('b', b), region('c', c)],
    boundaries: [], portals: [], graph: [] };
  const segments: ResolvedLayout['segments'] = {
    'v:3,1': { guarantee: 'guaranteed', stated: ['any', 'any'] },
    'v:3,2': { guarantee: 'guaranteed', stated: ['passable', 'unstated'] },
    'h:1,2': { guarantee: 'guaranteed', stated: ['passable', 'unstated'] },
    'h:2,2': { guarantee: 'guaranteed', stated: ['passable', 'unstated'] },
  };
  const resolved: ResolvedLayout = { width: 30, height: 30, cells: Array(900).fill(''), segments };
  const list = briefs(layout, resolved, found, zones, library, 3);
  const [first, second, third] = list;
  assert.deepEqual(first!.cells, [cell(1, 1), cell(2, 1), cell(1, 2), cell(2, 2)]); // Ownership survives empty fill.
  assert.deepEqual(first!.fillCells, []);
  assert.deepEqual(second!.fillCells, []);
  assert.deepEqual(third!.fillCells, []);
  assert.deepEqual(first!.internalGuaranteed, [{ axis: 'h', x: 1, y: 2, length: 2 }]);
  assert.deepEqual(second!.internalGuaranteed, []);
  assert.deepEqual(third!.clearCells, [cell(2, 0), cell(1, 1), cell(2, 1), cell(3, 1)]);
  assert.ok(coordinates(first!.clearCells!).includes('3,1')); // Adjacent owner's clear context.
  assert.ok(coordinates(second!.clearCells!).includes('2,1'));
});

test('a guaranteed strip can split fill without splitting region identity', () => {
  const owned = cells(0, 0, 4, 0);
  const result = applyClearConstraints(owned, [cell(2, 0)]);
  assert.deepEqual(result.fillCells, [cell(0, 0), cell(1, 0), cell(3, 0), cell(4, 0)]);
  assert.deepEqual(owned.length, 5);
});

test('a right-edge segment cannot wrap into a playable cell on the next row', () => {
  const found: LayoutRegions = { regions: [region('a', [cell(29, 1)]), region('b', [cell(0, 2)])],
    boundaries: [], portals: [], graph: [] };
  const resolved: ResolvedLayout = { width: 30, height: 30, cells: Array(900).fill(''), segments: {
    'v:30,1': { guarantee: 'guaranteed', stated: ['passable', 'passable'] },
    'h:0,30': { guarantee: 'guaranteed', stated: ['passable', 'passable'] },
  } };
  const list = briefs(layout, resolved, found, zones, library, 3);
  for (const brief of list) {
    assert.deepEqual(brief.fillCells, brief.cells);
    assert.deepEqual(brief.clearCells, []);
    assert.deepEqual(brief.internalGuaranteed, []);
  }
});
