import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHutGeneration } from '../map/micro/strategies/hut.ts';
import { chainBrief } from './helpers/chain-briefs.js';
import { cellsOf } from './helpers/cells.js';

const input = n => chainBrief({ id: 'diagnostics', type: 'hut', seed: 1, cellSize: 40,
  cells: cellsOf(n, n), portals: [] });

test('yard diagnostics distinguish excluded candidates from accepted handoffs', () => {
  const small = [], large = [];
  buildHutGeneration(input(6), { observeYard: event => small.push(event) });
  assert.equal(small[0].outcome, 'no-eligible-candidates');
  assert.equal(small[0].considered, small[0].filtered);
  assert.equal(small[0].probed, 0);
  const brief = input(12), result = buildHutGeneration(brief, { observeYard: event => large.push(event) });
  const event = large[0];
  assert.equal(event.outcome, 'delegated');
  assert.ok(event.considered > 36, 'static exclusions do not consume the candidate cap');
  assert.ok(event.eligibleOffers.length <= 36);
  assert.equal(event.eligibleOffers.length, event.considered - event.filtered);
  assert.equal(event.probed, event.probes.length);
  assert.equal(event.accepted, event.probes.filter(p => p.verdict === 'accepted').length);
  assert.equal(event.accepted, result.offers.length);
  assert.equal(Object.values(event.refusals).reduce((a, b) => a + b, 0), event.probed - event.accepted);
  assert.deepEqual(buildHutGeneration(brief, { observeYard: e => {
    e.eligibleOffers.length = 0; e.probes.length = 0; e.refusals.changed = 1;
  } }), result, 'observer receives detached data');
});

test('dense retained portals exclude every boundary box independently of the cap', () => {
  const brief = input(24), events = [];
  for (let i = 0; i + 2 <= 24; i += 3) brief.portals.push(
    { id: `n${i}`, axis: 'h', x: i, y: 0, length: 2 }, { id: `s${i}`, axis: 'h', x: i, y: 24, length: 2 },
    { id: `w${i}`, axis: 'v', x: 0, y: i, length: 2 }, { id: `e${i}`, axis: 'v', x: 24, y: i, length: 2 });
  const node = buildHutGeneration(brief, { observeYard: event => events.push(event) });
  assert.equal(events[0].considered, 72, 'all unique complete rectangles are considered, beyond the cap');
  assert.equal(events[0].filtered, 72);
  assert.equal(events[0].eligibleOffers.length, 0);
  assert.equal(events[0].outcome, 'no-eligible-candidates');
  assert.deepEqual(node.retained.brief, node.input);
});

test('terminal empty huts expose no-fill and no-house outcomes', () => {
  const events = [];
  buildHutGeneration({ ...input(6), fillCells: [] }, { observeYard: event => events.push(event) });
  buildHutGeneration(input(2), { observeYard: event => events.push(event) });
  assert.deepEqual(events.map(e => e.outcome), ['no-fill', 'no-house']);
});
