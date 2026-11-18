//! The core's non-exact math: a port of `shared/math.ts`, which stays the reference (docs/27,
//! "One math library on both sides"). Every function here must return the bits that file
//! returns, on every platform. This crate's tests and `tests/math.test.js` (through the WASM
//! module) hold the same digest over both.
//!
//! Only IEEE-exact operations are used: `+ - * /`, `sqrt`, `abs`, `floor` and `%`. Never fuse a
//! multiply and an add (`rust/core/clippy.toml` forbids `mul_add` and the platform's
//! transcendentals).
//!
//! sin, cos and atan2 are ports of fdlibm 5.3 (Sun Microsystems, freely redistributable; see the
//! notice below); hypot follows V8's algorithm.
//!
//! ====================================================
//! Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
//!
//! Permission to use, copy, modify, and distribute this
//! software is freely granted, provided that this notice
//! is preserved.
//! ====================================================

// The constants are fdlibm's, digit for digit; some carry more digits than an f64 holds.
#![allow(clippy::excessive_precision, clippy::approx_constant)]

/// The high 32 bits of `x`'s IEEE representation, as fdlibm's `__HI`.
fn high(x: f64) -> i32 {
    (x.to_bits() >> 32) as i32
}

fn from_words(hi: i32, lo: u32) -> f64 {
    f64::from_bits(((hi as u32 as u64) << 32) | lo as u64)
}

const S1: f64 = -1.66666666666666324348e-01;
const S2: f64 = 8.33333333332248946124e-03;
const S3: f64 = -1.98412698298579493134e-04;
const S4: f64 = 2.75573137070700676789e-06;
const S5: f64 = -2.50507602534068634195e-08;
const S6: f64 = 1.58969099521155010221e-10;

/// sin(x + y) for |x| ≤ π/4, where y is the tail of the reduced argument (0 if unreduced).
fn kernel_sin(x: f64, y: f64) -> f64 {
    if (high(x) & 0x7fffffff) < 0x3e400000 {
        return x; // |x| < 2^-27
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if y == 0.0 {
        return x + v * (S1 + z * r);
    }
    x - ((z * (0.5 * y - v * r) - y) - v * S1)
}

const C1: f64 = 4.16666666666666019037e-02;
const C2: f64 = -1.38888888888741095749e-03;
const C3: f64 = 2.48015872894767294178e-05;
const C4: f64 = -2.75573143513906633035e-07;
const C5: f64 = 2.08757232129817482790e-09;
const C6: f64 = -1.13596475577881948265e-11;

/// cos(x + y) for |x| ≤ π/4.
fn kernel_cos(x: f64, y: f64) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix < 0x3e400000 {
        return 1.0; // |x| < 2^-27
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3fd33333 {
        return 1.0 - (0.5 * z - (z * r - x * y)); // |x| < 0.3
    }
    // x/4, or 0.28125 above 0.78125
    let qx = if ix > 0x3fe90000 {
        0.28125
    } else {
        from_words(ix - 0x00200000, 0)
    };
    (1.0 - qx) - ((0.5 * z - qx) - (z * r - x * y))
}

const INV_PIO2: f64 = 6.36619772367581382433e-01;
const PIO2_1: f64 = 1.57079632673412561417e+00;
const PIO2_1T: f64 = 6.07710050650619224932e-11;
const PIO2_2: f64 = 6.07710050630396597660e-11;
const PIO2_2T: f64 = 2.02226624879595063154e-21;
const PIO2_3: f64 = 2.02226624871116645580e-21;
const PIO2_3T: f64 = 8.47842766036889956997e-32;
/// Beyond 2^19·π/2 the Cody–Waite reduction below runs out of bits.
const MEDIUM: f64 = 823549.6658963379;
const TWO_PI: f64 = 6.283185307179586;

/// x − n·π/2 as a head and tail, and n. Exact to fdlibm's accuracy for |x| ≤ 2^19·π/2. Larger
/// arguments, which the game never produces, are first brought into range with `%` (exact, as
/// JavaScript's is), so they are deterministic but not accurate.
fn rem_pio2(mut x: f64) -> (i32, f64, f64) {
    if x.abs() > MEDIUM {
        x %= TWO_PI;
    }
    let hx = high(x);
    let ix = hx & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return (0, x, 0.0); // |x| ≤ π/4
    }
    let t = x.abs();
    let n = (t * INV_PIO2 + 0.5).floor();
    let j = ix >> 20;
    let mut r = t - n * PIO2_1;
    let mut w = n * PIO2_1T;
    let mut y0 = r - w;
    if j - ((high(y0) >> 20) & 0x7ff) > 16 {
        // cancellation: second step, good to 118 bits
        let mut u = r;
        w = n * PIO2_2;
        r = u - w;
        w = n * PIO2_2T - ((u - r) - w);
        y0 = r - w;
        if j - ((high(y0) >> 20) & 0x7ff) > 49 {
            // third step, 151 bits
            u = r;
            w = n * PIO2_3;
            r = u - w;
            w = n * PIO2_3T - ((u - r) - w);
            y0 = r - w;
        }
    }
    let y1 = (r - y0) - w;
    // n < 2^20 here, so the conversion is exact; JavaScript's `& 3` reads the same low bits.
    let n = n as i32;
    if hx < 0 { (-n, -y0, -y1) } else { (n, y0, y1) }
}

pub fn sin(x: f64) -> f64 {
    if !x.is_finite() {
        return f64::NAN;
    }
    let (n, a, b) = rem_pio2(x);
    match n & 3 {
        0 => kernel_sin(a, b),
        1 => kernel_cos(a, b),
        2 => -kernel_sin(a, b),
        _ => -kernel_cos(a, b),
    }
}

pub fn cos(x: f64) -> f64 {
    if !x.is_finite() {
        return f64::NAN;
    }
    let (n, a, b) = rem_pio2(x);
    match n & 3 {
        0 => kernel_cos(a, b),
        1 => -kernel_sin(a, b),
        2 => -kernel_cos(a, b),
        _ => kernel_sin(a, b),
    }
}

const ATAN_HI: [f64; 4] = [
    4.63647609000806093515e-01,
    7.85398163397448278999e-01,
    9.82793723247329054082e-01,
    1.57079632679489655800e+00,
];
const ATAN_LO: [f64; 4] = [
    2.26987774529616870924e-17,
    3.06161699786838301793e-17,
    1.39033110312309984516e-17,
    6.12323399573676603587e-17,
];
const AT: [f64; 11] = [
    3.33333333333329318027e-01,
    -1.99999999998764832476e-01,
    1.42857142725034663711e-01,
    -1.11111104054623557880e-01,
    9.09088713343650656196e-02,
    -7.69187620504482999495e-02,
    6.66107313738753120669e-02,
    -5.83357013379057348645e-02,
    4.97687799461593236017e-02,
    -3.65315727442169155270e-02,
    1.62858201153657823623e-02,
];

pub fn atan(mut x: f64) -> f64 {
    let hx = high(x);
    let ix = hx & 0x7fffffff;
    let id: usize;
    if ix >= 0x44100000 {
        // |x| ≥ 2^66, or NaN
        if x.is_nan() {
            return x;
        }
        return if hx > 0 {
            ATAN_HI[3] + ATAN_LO[3]
        } else {
            -ATAN_HI[3] - ATAN_LO[3]
        };
    }
    if ix < 0x3fdc0000 {
        // |x| < 0.4375
        if ix < 0x3e400000 {
            return x; // |x| < 2^-27
        }
        let z = x * x;
        let w = z * z;
        let (s1, s2) = atan_series(z, w);
        return x - x * (s1 + s2);
    }
    x = x.abs();
    if ix < 0x3ff30000 {
        // |x| < 1.1875
        if ix < 0x3fe60000 {
            id = 0; // 7/16 ≤ |x| < 11/16
            x = (2.0 * x - 1.0) / (2.0 + x);
        } else {
            id = 1;
            x = (x - 1.0) / (x + 1.0);
        }
    } else if ix < 0x40038000 {
        id = 2; // |x| < 2.4375
        x = (x - 1.5) / (1.0 + 1.5 * x);
    } else {
        id = 3;
        x = -1.0 / x;
    }
    let z = x * x;
    let w = z * z;
    let (s1, s2) = atan_series(z, w);
    let result = ATAN_HI[id] - ((x * (s1 + s2) - ATAN_LO[id]) - x);
    if hx < 0 { -result } else { result }
}

fn atan_series(z: f64, w: f64) -> (f64, f64) {
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    (s1, s2)
}

const PI: f64 = 3.1415926535897931160e+00;
const PI_LO: f64 = 1.2246467991473531772e-16;

/// Follows `Math.atan2` for every signed zero, infinity and NaN.
pub fn atan2(y: f64, x: f64) -> f64 {
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    if x == 1.0 {
        return atan(y);
    }
    // sign_negative is `x < 0 || Object.is(x, -0)` for a number that is not NaN.
    let mut m = (y.is_sign_negative() as usize) | ((x.is_sign_negative() as usize) << 1);
    if y == 0.0 {
        return match m {
            0 | 1 => y,
            2 => PI,
            _ => -PI,
        };
    }
    if x == 0.0 {
        return if y < 0.0 { -PI / 2.0 } else { PI / 2.0 };
    }
    if x.is_infinite() {
        if y.is_infinite() {
            return [PI / 4.0, -PI / 4.0, 3.0 * PI / 4.0, -3.0 * PI / 4.0][m];
        }
        return [0.0, -0.0, PI, -PI][m];
    }
    if y.is_infinite() {
        return if y < 0.0 { -PI / 2.0 } else { PI / 2.0 };
    }
    let k = ((high(y) & 0x7fffffff) - (high(x) & 0x7fffffff)) >> 20; // exponent gap
    if k > 60 {
        m &= 1; // |y/x| > 2^60: ±π/2 whatever x's sign
    }
    let z = if k > 60 {
        PI / 2.0 + 0.5 * PI_LO
    } else if x < 0.0 && k < -60 {
        0.0
    } else {
        atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}

/// √(x² + y²) without overflow or underflow, by V8's own algorithm: scale by the larger magnitude
/// and add the squares. Every step is exact, so it matches `Math.hypot` in V8.
pub fn hypot(x: f64, y: f64) -> f64 {
    let x = x.abs();
    let y = y.abs();
    if x == f64::INFINITY || y == f64::INFINITY {
        return f64::INFINITY;
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    let max = if x > y { x } else { y };
    if max == 0.0 {
        return 0.0;
    }
    let a = x / max;
    let b = y / max;
    (a * a + b * b).sqrt() * max
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The arguments of `tests/math.test.js`'s `inputs`: a fixed linear congruential sequence.
    fn inputs(count: usize) -> Vec<f64> {
        let mut state: f64 = 1.0;
        (0..count)
            .map(|i| {
                // In doubles, as JavaScript computes it: the product can pass 2^53 and round, and
                // IEEE rounding is the same here.
                state = (state * 1103515245.0 + 12345.0) % 2147483648.0;
                let scale = [1e-3, 1e-2, 1e-1, 1e0, 1e1, 1e2, 1e3, 1e4, 1e5][i % 9];
                (state / 2147483648.0 - 0.5) * scale
            })
            .collect()
    }

    /// FNV-1a over exact output bits, as `tests/math.test.js`'s `digester`. NaN is mixed as the
    /// one canonical NaN, whatever its payload.
    struct Digest(u32);

    impl Digest {
        fn new() -> Self {
            Digest(0x811c9dc5)
        }
        fn mix(&mut self, value: f64) {
            let value = if value.is_nan() { f64::NAN } else { value };
            for byte in value.to_bits().to_be_bytes() {
                self.0 = (self.0 ^ byte as u32).wrapping_mul(0x01000193);
            }
        }
        fn hex(&self) -> String {
            format!("{:x}", self.0)
        }
    }

    /// `tests/math.test.js`'s `digestOf`, so the native build is held to it too.
    #[test]
    fn matches_the_typescript_digest() {
        let mut digest = Digest::new();
        let xs = inputs(20000);
        for i in 0..xs.len() {
            let x = xs[i];
            let y = xs[(i * 7 + 3) % xs.len()];
            digest.mix(sin(x));
            digest.mix(cos(x));
            digest.mix(atan(x));
            digest.mix(atan2(y, x));
            digest.mix(hypot(x, y));
        }
        assert_eq!(digest.hex(), "5a8ef1eb");
    }

    /// `tests/math.test.js`'s `edgeDigestOf`: signed zeros, subnormals, infinities, NaN, and |x|
    /// past `MEDIUM`, where sin and cos first reduce with `%`.
    #[test]
    fn matches_the_typescript_edge_digest() {
        let mut digest = Digest::new();
        let special = [
            0.0,
            -0.0,
            1.0,
            -1.0,
            1e-310,
            -1e-310,
            1e6,
            -1e6,
            1e300,
            -1e300,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NAN,
        ];
        for a in special {
            digest.mix(sin(a));
            digest.mix(cos(a));
            digest.mix(atan(a));
            for b in special {
                digest.mix(atan2(a, b));
                digest.mix(hypot(a, b));
            }
        }
        let mut large = Vec::with_capacity(200);
        let mut x = MEDIUM;
        for i in 0..200 {
            large.push(if i % 2 == 1 { -x } else { x });
            x *= 1.37;
        }
        for i in 0..large.len() {
            let x = large[i];
            let y = large[(i + 1) % large.len()];
            digest.mix(sin(x));
            digest.mix(cos(x));
            digest.mix(atan(x));
            digest.mix(atan2(y, x));
            digest.mix(hypot(x, y));
        }
        assert_eq!(digest.hex(), "774d7a76");
    }

    #[test]
    fn follows_atan2_signed_zeros() {
        assert!(atan2(0.0, 0.0).to_bits() == 0.0f64.to_bits());
        assert!(atan2(-0.0, 0.0).to_bits() == (-0.0f64).to_bits());
        assert_eq!(atan2(0.0, -0.0), PI);
        assert_eq!(atan2(-0.0, -0.0), -PI);
    }
}
