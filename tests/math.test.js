import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as math from '../shared/math.ts';
import { CORE_ADAPTER_VERSION, loadCore } from '../shared/core.ts';
import { buildCore } from '../tools/build-core.mjs';
import { digester } from './helpers/float-digest.js';

const { atan, atan2, cos, hypot, sin } = math;

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
    // Comments are blanked but keep their newlines, so reported lines stay true.
    const code = readFileSync(path.join('shared', file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, c => c.replace(/[^\n]/g, ''));
    code.split('\n').forEach((line, i) => {
      // `**` is Math.pow; only a literal like 2 ** 20 is exact everywhere.
      if (banned.test(line) || /\*\*/.test(line.replace(/\b\d+ \*\* \d+\b/g, ''))) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

/** A digest over arguments of every scale. rust/core/src/math.rs's tests compute the same one. */
function digestOf({ sin, cos, atan, atan2, hypot }) {
  const { mix, hex } = digester();
  const xs = inputs(20000);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = xs[(i * 7 + 3) % xs.length];
    mix(sin(x)); mix(cos(x)); mix(atan(x)); mix(atan2(y, x)); mix(hypot(x, y));
  }
  return hex();
}

/**
 * A digest over what digestOf's inputs miss: signed zeros, subnormals, infinities, NaN, and
 * |x| past math.ts's MEDIUM, where sin and cos first reduce with `%`. rust/core/src/math.rs's
 * tests compute the same one natively.
 */
function edgeDigestOf({ sin, cos, atan, atan2, hypot }) {
  const { mix, hex } = digester();
  const special = [0, -0, 1, -1, 1e-310, -1e-310, 1e6, -1e6, 1e300, -1e300, Infinity, -Infinity, NaN];
  for (const a of special) {
    mix(sin(a)); mix(cos(a)); mix(atan(a));
    for (const b of special) { mix(atan2(a, b)); mix(hypot(a, b)); }
  }
  const large = [];
  for (let i = 0, x = 823549.6658963379; i < 200; i++, x *= 1.37) large.push(i % 2 ? -x : x);
  for (let i = 0; i < large.length; i++) {
    const x = large[i], y = large[(i + 1) % large.length];
    mix(sin(x)); mix(cos(x)); mix(atan(x)); mix(atan2(y, x)); mix(hypot(x, y));
  }
  return hex();
}

test('the math module returns the same bits on every platform', () => {
  // It holds on x86 and ARM alike (#566). If it moves, the simulation's results moved, and
  // that is a fixture version decision (31), not a test update.
  assert.equal(digestOf(math), '5a8ef1eb');
  assert.equal(edgeDigestOf(math), '774d7a76');
});

test('the Rust core computes the same bits as the math module (docs/27)', async () => {
  const core = await loadCore(readFileSync(buildCore()));
  const ported = { sin: core.math_sin, cos: core.math_cos, atan: core.math_atan, atan2: core.math_atan2, hypot: core.math_hypot };
  assert.equal(digestOf(ported), '5a8ef1eb');
  assert.equal(edgeDigestOf(ported), '774d7a76');
});

test('the core loader refuses a module of another adapter version', async () => {
  // A hand-assembled module whose only export is adapter_version, returning 1.
  const stale = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00, 0x07, 0x13, 0x01, 0x0f, ...new TextEncoder().encode('adapter_version'), 0x00, 0x00,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x01, 0x0b);
  await assert.rejects(loadCore(stale), new RegExp(`adapter version 1, this loader ${CORE_ADAPTER_VERSION}`));
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
  // Another engine may round these last bits differently, so they get the same 1 ulp. A wrong
  // signed zero or a NaN is billions of ulps away, so those cases are still checked exactly.
  const special = [0, -0, 1, -1, 1e-310, -1e-310, 1e300, -1e300, Infinity, -Infinity, NaN];
  for (const a of special) {
    // Past 2^19·π/2 sin and cos are deterministic but not accurate (math.ts); the game never goes there.
    if (!(Number.isFinite(a) && Math.abs(a) > 1e6)) assert.ok(ulps(sin(a), Math.sin(a)) <= 1 && ulps(cos(a), Math.cos(a)) <= 1, `${a}`);
    assert.ok(ulps(atan(a), Math.atan(a)) <= 1, `${a}`);
    for (const b of special) assert.ok(ulps(atan2(a, b), Math.atan2(a, b)) <= 1 && ulps(hypot(a, b), Math.hypot(a, b)) <= 1, `${a}, ${b}`);
  }
});
