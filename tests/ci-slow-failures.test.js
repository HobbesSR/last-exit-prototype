import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFailures, plan } from '../tools/ci/slow-failures.mjs';

// The tail of real `npm run test:slow` output on a failure, as tee captures it in CI.
const LOG = `✔ another test (12.5ms)
ℹ fail 2
✖ failing tests:

test at tests/slow/characterization-bots.test.js:12:27
✖ every bot-match tick and projection matches the nav-1 checkpoint: seed 1 (16807.700472ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

test at tests/slow/sweep.test.js:40:3
\x1b[31m✖ a sweep stays playable (2s)\x1b[39m
  Error: seed 9 unplayable
`;
const RUN = { sha: 'abc123', runUrl: 'http://forgejo/corey/astra_test/actions/runs/7' };

test('the slow-failure filer reads each failing test, its file and error from spec output', () => {
  assert.deepEqual(parseFailures(LOG), [
    { name: 'every bot-match tick and projection matches the nav-1 checkpoint: seed 1', file: 'tests/slow/characterization-bots.test.js',
      error: '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n  + actual - expected' },
    { name: 'a sweep stays playable', file: 'tests/slow/sweep.test.js', error: '  Error: seed 9 unplayable' },
  ]);
  assert.deepEqual(parseFailures('ℹ fail 0\n'), []);
});

test('the slow-failure filer plans one issue per test, one for a mass failure, and one for a job failure', () => {
  const failures = parseFailures(LOG), issues = plan(failures, RUN);
  assert.deepEqual(issues.map(issue => issue.title), failures.map(f => `Slow tier fails on main: ${f.name}`));
  assert.ok(issues.every(issue => issue.body.includes('abc123') && issue.body.includes(RUN.runUrl)));
  const many = Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, file: 'f.js', error: '' }));
  const [mass, ...none] = plan(many, RUN);
  assert.equal(none.length, 0);
  assert.equal(mass.title, 'Slow tier fails on main: 6 tests');
  assert.ok(many.every(f => mass.body.includes(`- ${f.name} `)));
  assert.equal(plan([], RUN)[0].title, 'Slow tier job fails on main');
});

test('the slow-failure filer reports a run CI killed at its time limit as one timeout issue', () => {
  const [timeout, ...none] = plan(parseFailures(LOG), { ...RUN, timedOut: true });
  assert.equal(none.length, 0);
  assert.equal(timeout.title, 'Slow tier times out on main');
  assert.ok(timeout.body.includes('- a sweep stays playable (`tests/slow/sweep.test.js`)'));
  assert.ok(!plan([], { ...RUN, timedOut: true })[0].body.includes('Already failed'));
});
