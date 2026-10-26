/**
 * Sole owner of the non-exact math the simulation uses (#566). `+ - * /` and `Math.sqrt` are
 * IEEE-exact in every engine, but `Math.sin`, `cos`, `atan2`, `hypot` and the rest are not
 * specified to the bit: V8 returns different last bits on ARM and x86, and Safari and Firefox
 * use other libraries again. The server and every client must compute the same bits, so
 * `shared/` calls these instead (a test in tests/math.test.js holds the rule).
 *
 * sin, cos and atan2 are ports of fdlibm 5.3 (Sun Microsystems, freely redistributable;
 * see the notice below), written with exact operations only. JavaScript never fuses a
 * multiply and an add, so the port gives the same bits on every engine and CPU. Results are
 * within 1 ulp of the true value.
 *
 * ====================================================
 * Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
 *
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 */

const view = new DataView(new ArrayBuffer(8));

/** The high 32 bits of `x`'s IEEE representation, as fdlibm's `__HI`. */
function high(x: number): number {
  view.setFloat64(0, x);
  return view.getInt32(0);
}

function fromWords(hi: number, lo: number): number {
  view.setInt32(0, hi);
  view.setUint32(4, lo);
  return view.getFloat64(0);
}

const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;

/** sin(x + y) for |x| ≤ π/4, where y is the tail of the reduced argument (0 if unreduced). */
function kernelSin(x: number, y: number): number {
  if ((high(x) & 0x7fffffff) < 0x3e400000) return x; // |x| < 2^-27
  const z = x * x, v = z * x, r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (y === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

/** cos(x + y) for |x| ≤ π/4. */
function kernelCos(x: number, y: number): number {
  const ix = high(x) & 0x7fffffff;
  if (ix < 0x3e400000) return 1; // |x| < 2^-27
  const z = x * x, r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y)); // |x| < 0.3
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0); // x/4, or 0.28125 above 0.78125
  return (1 - qx) - ((0.5 * z - qx) - (z * r - x * y));
}

const INV_PIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
/** Beyond 2^19·π/2 the Cody–Waite reduction below runs out of bits. */
const MEDIUM = 823549.6658963379;
const TWO_PI = 6.283185307179586;
const reduced = [0, 0];

/**
 * Writes x − n·π/2 into `reduced` as a head and tail and returns n. Exact to fdlibm's accuracy
 * for |x| ≤ 2^19·π/2. Larger arguments, which the game never produces, are first brought
 * into range with `%` (exact by specification), so they are deterministic but not accurate.
 */
function remPio2(x: number): number {
  if (Math.abs(x) > MEDIUM) x %= TWO_PI;
  const hx = high(x), ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) { reduced[0] = x; reduced[1] = 0; return 0; } // |x| ≤ π/4
  const t = Math.abs(x), n = Math.floor(t * INV_PIO2 + 0.5), j = ix >> 20;
  let r = t - n * PIO2_1, w = n * PIO2_1T, y0 = r - w;
  if (j - ((high(y0) >> 20) & 0x7ff) > 16) { // cancellation: second step, good to 118 bits
    let u = r;
    w = n * PIO2_2; r = u - w; w = n * PIO2_2T - ((u - r) - w); y0 = r - w;
    if (j - ((high(y0) >> 20) & 0x7ff) > 49) { // third step, 151 bits
      u = r;
      w = n * PIO2_3; r = u - w; w = n * PIO2_3T - ((u - r) - w); y0 = r - w;
    }
  }
  const y1 = (r - y0) - w;
  if (hx < 0) { reduced[0] = -y0; reduced[1] = -y1; return -n; }
  reduced[0] = y0; reduced[1] = y1;
  return n;
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const n = remPio2(x) & 3, a = reduced[0], b = reduced[1];
  return n === 0 ? kernelSin(a, b) : n === 1 ? kernelCos(a, b) : n === 2 ? -kernelSin(a, b) : -kernelCos(a, b);
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const n = remPio2(x) & 3, a = reduced[0], b = reduced[1];
  return n === 0 ? kernelCos(a, b) : n === 1 ? -kernelSin(a, b) : n === 2 ? -kernelCos(a, b) : kernelSin(a, b);
}

const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];

export function atan(x: number): number {
  const hx = high(x), ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) { // |x| ≥ 2^66, or NaN
    if (x !== x) return x;
    return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3];
  }
  if (ix < 0x3fdc0000) { // |x| < 0.4375
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) { // |x| < 1.1875
      if (ix < 0x3fe60000) { id = 0; x = (2 * x - 1) / (2 + x); } // 7/16 ≤ |x| < 11/16
      else { id = 1; x = (x - 1) / (x + 1); }
    } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1 + 1.5 * x); } // |x| < 2.4375
    else { id = 3; x = -1 / x; }
  }
  const z = x * x, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const result = ATAN_HI[id] - ((x * (s1 + s2) - ATAN_LO[id]) - x);
  return hx < 0 ? -result : result;
}

const PI = 3.1415926535897931160e+00, PI_LO = 1.2246467991473531772e-16;
const negative = (x: number) => x < 0 || Object.is(x, -0);

/** Follows `Math.atan2` for every signed zero, infinity and NaN. */
export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  if (x === 1) return atan(y);
  let m = (negative(y) ? 1 : 0) | (negative(x) ? 2 : 0);
  if (y === 0) return m === 0 || m === 1 ? y : m === 2 ? PI : -PI;
  if (x === 0) return y < 0 ? -PI / 2 : PI / 2;
  if (x === Infinity || x === -Infinity) {
    if (y === Infinity || y === -Infinity) return [PI / 4, -PI / 4, 3 * PI / 4, -3 * PI / 4][m];
    return [0, -0, PI, -PI][m];
  }
  if (y === Infinity || y === -Infinity) return y < 0 ? -PI / 2 : PI / 2;
  const k = ((high(y) & 0x7fffffff) - (high(x) & 0x7fffffff)) >> 20; // exponent gap
  if (k > 60) m &= 1; // |y/x| > 2^60: ±π/2 whatever x's sign
  const z = k > 60 ? PI / 2 + 0.5 * PI_LO : x < 0 && k < -60 ? 0 : atan(Math.abs(y / x));
  return m === 0 ? z : m === 1 ? -z : m === 2 ? PI - (z - PI_LO) : (z - PI_LO) - PI;
}

/**
 * √(x² + y²) without overflow or underflow, by V8's own algorithm: scale by the larger
 * magnitude and add the squares (V8's Kahan compensation is zero for two terms). Every step
 * is exact, so this matches `Math.hypot` in V8 and gives the same bits in any engine. Two
 * arguments only: the simulation never needs more.
 */
export function hypot(x: number, y: number): number {
  x = Math.abs(x); y = Math.abs(y);
  if (x === Infinity || y === Infinity) return Infinity;
  if (x !== x || y !== y) return NaN;
  const max = x > y ? x : y;
  if (max === 0) return 0;
  const a = x / max, b = y / max;
  return Math.sqrt(a * a + b * b) * max;
}
