import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atan, atan2, cos, hypot, sin } from '../shared/math.ts';

const bits = new DataView(new ArrayBuffer(16));
const ulps = (a, b) => {
  if (Object.is(a, b)) return 0;
  bits.setFloat64(0, a); bits.setFloat64(8, b);
  return Math.abs(Number(bits.getBigInt64(0) - bits.getBigInt64(8)));
};

/** Arguments of every scale the simulation sees, from a fixed linear congruential sequence. */
function inputs(count) {
  const out = [];
  let state = 1;
  for (let i = 0; i < count; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out.push((state / 2147483648 - 0.5) * 10 ** (i % 9 - 3));
  }
  return out;
}

test('shared/ computes non-exact math only through shared/math.ts (#566)', () => {
  // Engines and CPUs disagree in the last bit for these; server and clients must not.
  const banned = /\bMath\.(sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b/;
  const offenders = [];
  for (const file of readdirSync('shared', { recursive: true })) {
    if (!file.endsWith('.ts') || file === 'math.ts') continue;
    const code = readFileSync(path.join('shared', file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    code.split('\n').forEach((line, i) => {
      // `**` is Math.pow; only a literal like 2 ** 20 is exact everywhere.
      if (banned.test(line) || /\*\*/.test(line.replace(/\b\d+ \*\* \d+\b/g, ''))) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the math module returns the same bits on every platform', () => {
  // A digest of exact output bits: it holds on x86 and ARM alike (#566). If it moves, the
  // simulation's results moved, and that is a fixture version decision (31), not a test update.
  let digest = 0x811c9dc5;
  const mix = value => {
    bits.setFloat64(0, value);
    for (let i = 0; i < 8; i++) digest = Math.imul(digest ^ bits.getUint8(i), 0x01000193) >>> 0;
  };
  const xs = inputs(20000);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = xs[(i * 7 + 3) % xs.length];
    mix(sin(x)); mix(cos(x)); mix(atan(x)); mix(atan2(y, x)); mix(hypot(x, y));
  }
  assert.equal(digest.toString(16), '5a8ef1eb');
});

test('the math module stays within 1 ulp of the engine and follows its special cases', () => {
  const xs = inputs(50000);
  let worst = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = xs[(i * 7 + 3) % xs.length];
    worst = Math.max(worst, ulps(sin(x), Math.sin(x)), ulps(cos(x), Math.cos(x)), ulps(atan(x), Math.atan(x)),
      ulps(atan2(y, x), Math.atan2(y, x)), ulps(hypot(x, y), Math.hypot(x, y)));
  }
  assert.ok(worst <= 1, `${worst} ulps`);
  const special = [0, -0, 1, -1, 1e-310, -1e-310, 1e300, -1e300, Infinity, -Infinity, NaN];
  for (const a of special) {
    // Past 2^19·π/2 sin and cos are deterministic but not accurate (math.ts); the game never goes there.
    if (!(Number.isFinite(a) && Math.abs(a) > 1e6)) assert.ok(Object.is(sin(a), Math.sin(a)) && Object.is(cos(a), Math.cos(a)), `${a}`);
    assert.ok(Object.is(atan(a), Math.atan(a)), `${a}`);
    for (const b of special) assert.ok(Object.is(atan2(a, b), Math.atan2(a, b)) && Object.is(hypot(a, b), Math.hypot(a, b)), `${a}, ${b}`);
  }
});
