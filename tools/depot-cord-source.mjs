import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const lf = (text) => text.replace(/\r\n/g, '\n');
const canonical = (text) => `${lf(text).replace(/\n+$/, '')}\n`;
const cleanupPaths = new Set(['map/micro/experiments/depot-canvas.ts', 'tools/depot-cord-audit.mjs']);

// Git's text checkout may change line endings; preserve all other bytes here.
export function hashSource(text) {
  return sha256(lf(text));
}

export function compareMeasuredSource(path, actualText, measuredEntry, wantedRawSha) {
  assert.ok(measuredEntry && typeof measuredEntry.text === 'string', `Missing measured source: ${path}`);
  assert.equal(measuredEntry.path, path, `Measured source path mismatch: ${path}`);
  assert.equal(sha256(measuredEntry.text), wantedRawSha, `Measured source hash mismatch: ${path}`);
  assert.ok(measuredEntry.cleanup === undefined ||
    (measuredEntry.cleanup === 'trailing-whitespace' && cleanupPaths.has(path)),
  `Unauthorized measured source cleanup: ${path}`);

  const historicalCleanup = measuredEntry.cleanup === 'trailing-whitespace';
  const expected = historicalCleanup
    ? lf(measuredEntry.text).replace(/[ \t]+$/gm, '')
    : measuredEntry.text;
  const finalText = canonical(actualText);
  assert.equal(finalText, canonical(expected), `Source differs from measured source: ${path}`);
  return {
    path,
    measuredSha256: wantedRawSha,
    finalSha256: sha256(finalText),
    normalization: 'utf8-lf-single-final-newline',
    historicalCleanup,
  };
}
