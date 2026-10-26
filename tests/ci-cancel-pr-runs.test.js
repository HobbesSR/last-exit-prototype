import test from 'node:test';
import assert from 'node:assert/strict';
import { runsToCancel } from '../tools/ci/cancel-pr-runs.mjs';

test('closing a pull request cancels only its own active CI runs', () => {
  const run = (id, fields) => ({ id, workflow_id: 'ci.yml', event: 'pull_request', prettyref: '#573', status: 'running', ...fields });
  const runs = [
    run(1), run(2, { status: 'waiting' }), run(3, { status: 'blocked' }),
    run(4, { status: 'success' }), run(5, { status: 'cancelled' }),
    run(6, { prettyref: '#57' }), run(7, { prettyref: '#5730' }),
    run(8, { event: 'push', prettyref: 'main' }),
    // This workflow's own run, triggered by the same close.
    run(9, { workflow_id: 'cancel-closed-pr.yml' }),
  ];
  assert.deepEqual(runsToCancel(runs, '573').map(r => r.id), [1, 2, 3]);
});
