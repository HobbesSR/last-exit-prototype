import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareMeasuredSource, hashSource } from '../tools/depot-cord-source.mjs';

const rawHash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const path = 'tools/example.js';
const entry = (text, cleanup) => ({ path, text, ...(cleanup && { cleanup }) });
const compare = (actual, measured) => compareMeasuredSource(path, actual, measured, rawHash(measured.text));

test('source hash changes only CRLF line endings', () => {
  assert.equal(hashSource('a\r\nb\r\n'), hashSource('a\nb\n'));
  assert.notEqual(hashSource('a\n'), hashSource('a'));
});

test('comparison accepts line ending and EOF newline differences', () => {
  const measured = entry('const x = 1;\nnext();\n');
  const result = compare('const x = 1;\r\nnext();\r\n\r\n', measured);
  assert.deepEqual(result, {
    path, measuredSha256: rawHash(measured.text), finalSha256: rawHash(measured.text),
    normalization: 'utf8-lf-single-final-newline', historicalCleanup: false,
  });
  assert.equal(compare('const x = 1;\nnext();', measured).finalSha256, rawHash(measured.text));
});

test('comparison rejects token edits, unrecorded whitespace and invalid archives', () => {
  const measured = entry('const x = 1;\n');
  assert.throws(() => compare('const x = 2;\n', measured));
  assert.throws(() => compare('const x = 1; \n', measured));
  assert.throws(() => compareMeasuredSource(path, measured.text, undefined, rawHash(measured.text)));
  assert.throws(() => compareMeasuredSource(path, measured.text, entry('const x = 2;\n'), rawHash(measured.text)));
  assert.throws(() => compareMeasuredSource(path, measured.text, { ...measured, path: 'other' }, rawHash(measured.text)));
});

test('recorded historical cleanup applies only to the measured source', () => {
  const cleanupPath = 'map/micro/experiments/depot-canvas.ts';
  const measured = { path: cleanupPath, text: 'const x = 1; \t\nnext();  \n', cleanup: 'trailing-whitespace' };
  const compareCleanup = (actual) => compareMeasuredSource(cleanupPath, actual, measured, rawHash(measured.text));
  const result = compareCleanup('const x = 1;\nnext();\n');
  assert.equal(result.historicalCleanup, true);
  assert.throws(() => compareCleanup('const x = 1; \nnext();\n'));
  assert.throws(() => compareCleanup('const x = 1;\nnext(); extra\n'));
});

test('cleanup metadata cannot authorize another path or an unknown cleanup', () => {
  const forged = entry('const x = 1; \n', 'trailing-whitespace');
  assert.throws(() => compare('const x = 1;\n', forged), /Unauthorized measured source cleanup/);
  const unknown = entry('const x = 1;\n', 'unknown');
  assert.throws(() => compare(unknown.text, unknown), /Unauthorized measured source cleanup/);
});
