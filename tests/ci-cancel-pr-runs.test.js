import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRuns } from '../tools/ci/cancel-pr-runs.mjs';

const run = (id, fields) => ({ id, event: 'pull_request', prettyref: '#573', status: 'running', ...fields });

test('closing a pull request cancels only its own active CI runs', async () => {
  const runs = [
    run(1), run(2, { status: 'waiting' }), run(3, { status: 'blocked' }),
    run(4, { status: 'success' }),
    run(6, { prettyref: '#57' }), run(7, { prettyref: '#5730' }),
    run(8, { event: 'push', prettyref: 'main' }),
  ];
  assert.deepEqual((await activeRuns(async () => runs, '573')).map(r => r.id), [1, 2, 3]);
});

test('closing a pull request finds its runs past the first page', async () => {
  // 50 other active runs fill page one; the target is on page two (review 432).
  const pages = [Array.from({ length: 50 }, (_, i) => run(100 + i, { prettyref: '#1' })), [run(9)]];
  const asked = [];
  const found = await activeRuns(async n => { asked.push(n); return pages[n - 1] ?? []; }, '573');
  assert.deepEqual(found.map(r => r.id), [9]);
  assert.deepEqual(asked, [1, 2]);
});
