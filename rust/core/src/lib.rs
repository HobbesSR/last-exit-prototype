//! The simulation core (docs/27), built natively for `cargo test` and to `wasm32-unknown-unknown`
//! as the one module Node and the browser both load (`shared/core.ts`).
//!
//! The WASM module uses plain exports, not wasm-bindgen: the adapter passes flat typed buffers in
//! WASM memory (docs/27, rule 1), so there is no generated JavaScript glue to keep in step.

pub mod math;

/// The version of the contract between this module and its JavaScript adapter. A loader checks it
/// before calling anything else, and it changes whenever an export's meaning or layout does.
pub const ADAPTER_VERSION: u32 = 2;

/// Exported to JavaScript as `adapter_version`.
#[unsafe(no_mangle)]
pub extern "C" fn adapter_version() -> u32 {
    ADAPTER_VERSION
}

// The math, exported per scalar for the parity check against shared/math.ts only. The crate's
// math serves Rust callers; JavaScript keeps shared/math.ts (docs/27, "Port order").

#[unsafe(no_mangle)]
pub extern "C" fn math_sin(x: f64) -> f64 {
    math::sin(x)
}

#[unsafe(no_mangle)]
pub extern "C" fn math_cos(x: f64) -> f64 {
    math::cos(x)
}

#[unsafe(no_mangle)]
pub extern "C" fn math_atan(x: f64) -> f64 {
    math::atan(x)
}

#[unsafe(no_mangle)]
pub extern "C" fn math_atan2(y: f64, x: f64) -> f64 {
    math::atan2(y, x)
}

#[unsafe(no_mangle)]
pub extern "C" fn math_hypot(x: f64, y: f64) -> f64 {
    math::hypot(x, y)
}

#[cfg(test)]
mod tests {
    #[test]
    fn exports_the_adapter_version() {
        assert_eq!(super::adapter_version(), super::ADAPTER_VERSION);
    }
}
