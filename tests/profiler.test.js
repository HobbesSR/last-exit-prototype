import test from 'node:test';
import assert from 'node:assert/strict';
import * as profiler from '../shared/profiler.js';

test('profiler call rates use the same rolling window as frame timings', () => {
  profiler.reset(); profiler.enable(true);
  for (let i = 0; i < 900; i++) { profiler.start('one'); profiler.stop('one'); profiler.observe('packet', 50); profiler.frame(); }
  let report = profiler.report();
  assert.equal(report.find(s => s.name === 'one').calls, 1);
  assert.equal(report.find(s => s.name === 'one').samples, 600);
  assert.equal(report.find(s => s.name === 'packet').calls, 900, 'event totals remain lifetime totals');
  for (let i = 0; i < 600; i++) profiler.frame();
  report = profiler.report(); assert.equal(report.find(s => s.name === 'one').calls, 0);
  profiler.enable(false);
});
