import test from 'node:test';
import assert from 'node:assert/strict';
import { encodingDamage } from '../tools/lib/encoding-damage.mjs';

const utf8 = text => Buffer.from(text, 'utf8');
/** What PowerShell 5.1 does: read UTF-8 bytes as cp1252, then write the text back as UTF-8. */
const doubleEncode = text => utf8([...utf8(text)].map(b => new TextDecoder('windows-1252').decode(Uint8Array.of(b))).join(''));

test('clean UTF-8 passes, including the symbols the docs use', () => {
  assert.deepEqual(encodingDamage(utf8('// Past 2^19·π/2: |x| ≤ π/4, ±0, √(x² + y²), x − n — “quoted” ✔\n')), []);
});

test('a byte-order mark and double-encoded UTF-8 are both reported (#1179)', () => {
  assert.deepEqual(encodingDamage(Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), utf8('fine\n')])),
    ['starts with a UTF-8 byte-order mark']);
  const damaged = encodingDamage(Buffer.concat([utf8('line one\n'), doubleEncode('// 2^19·π/2 ≤ x — ✔\n')]));
  assert.deepEqual(damaged.map(p => p.match(/it was "(.*)"\)$/)[1]), ['·', 'π', '≤', '—', '✔']);
  assert.ok(damaged.every(p => p.startsWith('line 2: ')));
});
