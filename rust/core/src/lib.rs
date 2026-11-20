//! The simulation core (docs/27), built natively for `cargo test` and to `wasm32-unknown-unknown`
//! as the one module Node and the browser both load (`shared/core.ts`).
//!
//! The WASM module uses plain exports, not wasm-bindgen: the adapter passes flat typed buffers in
//! WASM memory (docs/27, rule 1), so there is no generated JavaScript glue to keep in step.

pub mod math;
pub mod physics;
pub mod sight;

use std::alloc::{Layout, alloc, dealloc};
use std::slice;

/// The version of the contract between this module and its JavaScript adapter. A loader checks it
/// before calling anything else, and it changes whenever an export's meaning or layout does.
pub const ADAPTER_VERSION: u32 = 3;

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

/// Rapier's probe (`physics::probe`), until the world's adapter replaces it (#1192).
#[unsafe(no_mangle)]
pub extern "C" fn physics_probe(steps: u32) -> f64 {
    physics::probe(steps)
}

#[unsafe(no_mangle)]
pub extern "C" fn math_hypot(x: f64, y: f64) -> f64 {
    math::hypot(x, y)
}

// The flat-buffer adapter (docs/27, rule 1). JavaScript allocates a buffer in WASM memory, writes
// typed arrays into it and passes the pointer; results stay in memory the core owns, which
// JavaScript reads through views. Any call that allocates may grow the memory and detach the old
// `memory.buffer`, so the adapter makes its views after each call, never before.

/// Every buffer is 8-byte aligned, so it can hold `f64`s.
fn buffer_layout(bytes: usize) -> Layout {
    Layout::from_size_align(bytes.max(1), 8).expect("a buffer size within the address space")
}

/// Allocates `bytes` of WASM memory for JavaScript to fill.
#[unsafe(no_mangle)]
pub extern "C" fn core_alloc(bytes: usize) -> *mut u8 {
    // SAFETY: the layout has a nonzero size.
    unsafe { alloc(buffer_layout(bytes)) }
}

/// Frees a buffer `core_alloc` returned.
///
/// # Safety
/// `ptr` came from `core_alloc(bytes)` with the same `bytes`, and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_free(ptr: *mut u8, bytes: usize) {
    // SAFETY: the caller's contract.
    unsafe { dealloc(ptr, buffer_layout(bytes)) }
}

/// Reads `len` items at `ptr`, treating a null or empty buffer as empty.
///
/// # Safety
/// `ptr` points at `len` initialised items, or `len` is zero.
unsafe fn items<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        // SAFETY: the caller's contract.
        unsafe { slice::from_raw_parts(ptr, len) }
    }
}

/// Builds a sight index from `segment_count` edges (`[ax, ay, bx, by]`, `f64`) and a grid of
/// `grid_len` `i32` words (`sight::Grid`). The core copies both; the caller may free them.
///
/// # Safety
/// The pointers hold `segment_count * 4` and `grid_len` items.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sight_index_new(
    segments: *const f64,
    segment_count: usize,
    grid: *const i32,
    grid_len: usize,
) -> *mut sight::SightIndex {
    // SAFETY: the caller's contract.
    let (segments, grid) = unsafe { (items(segments, segment_count * 4), items(grid, grid_len)) };
    Box::into_raw(Box::new(sight::SightIndex::new(segments, grid)))
}

/// # Safety
/// `index` came from `sight_index_new` and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sight_index_free(index: *mut sight::SightIndex) {
    // SAFETY: the caller's contract.
    drop(unsafe { Box::from_raw(index) });
}

/// The last polygon's points, `x, y, angle, length` as `f64`, valid until the next call that
/// allocates.
///
/// # Safety
/// `index` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sight_index_points(index: *const sight::SightIndex) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe { (*index).points().as_ptr() }
}

/// How many ray-edge tests the last polygon made.
///
/// # Safety
/// `index` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sight_index_tests(index: *const sight::SightIndex) -> u32 {
    // SAFETY: the caller's contract.
    unsafe { (*index).tests() }
}

/// Builds a gate set: `edge_count` edges (`f64`), `gate_count + 1` offsets (`u32`) giving each
/// gate's edges, and a grid of gate indices. All gates start closed.
///
/// # Safety
/// The pointers hold `edge_count * 4`, `gate_count + 1` and `grid_len` items.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gate_set_new(
    edges: *const f64,
    edge_count: usize,
    offsets: *const u32,
    gate_count: usize,
    grid: *const i32,
    grid_len: usize,
) -> *mut sight::GateSet {
    // SAFETY: the caller's contract.
    let (edges, offsets, grid) = unsafe {
        (
            items(edges, edge_count * 4),
            items(offsets, gate_count + 1),
            items(grid, grid_len),
        )
    };
    Box::into_raw(Box::new(sight::GateSet::new(edges, offsets, grid)))
}

/// # Safety
/// `gates` came from `gate_set_new` and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gate_set_free(gates: *mut sight::GateSet) {
    // SAFETY: the caller's contract.
    drop(unsafe { Box::from_raw(gates) });
}

/// The open mask, one byte per gate, nonzero where open. JavaScript writes it before each call.
///
/// # Safety
/// `gates` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gate_set_open(gates: *mut sight::GateSet) -> *mut u8 {
    // SAFETY: the caller's contract.
    unsafe { (*gates).open.as_mut_ptr() }
}

/// `visibilityPolygon` from `(x, y)` within `radius`; returns the point count. The points are at
/// `sight_index_points(index)`.
///
/// # Safety
/// `index` and `gates` are live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn visibility_polygon(
    index: *mut sight::SightIndex,
    gates: *mut sight::GateSet,
    x: f64,
    y: f64,
    radius: f64,
) -> usize {
    // SAFETY: the caller's contract.
    unsafe { sight::visibility_polygon(&mut *index, &mut *gates, x, y, radius) }
}

#[cfg(test)]
mod tests {
    #[test]
    fn exports_the_adapter_version() {
        assert_eq!(super::adapter_version(), super::ADAPTER_VERSION);
    }
}
