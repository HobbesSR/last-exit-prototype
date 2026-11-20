//! The simulation core (docs/27), built natively for `cargo test` and to `wasm32-unknown-unknown`
//! as the one module Node and the browser both load (`shared/core.ts`).
//!
//! The WASM module uses plain exports, not wasm-bindgen: the adapter passes flat typed buffers in
//! WASM memory (docs/27, rule 1), so there is no generated JavaScript glue to keep in step.

pub mod discovery;
pub mod floor_drag;
pub mod math;
pub mod phase_one;
pub mod physics;
pub mod sight;

use std::alloc::{Layout, alloc, dealloc};
use std::slice;

/// The version of the contract between this module and its JavaScript adapter. A loader checks it
/// before calling anything else, and it changes whenever an export's meaning or layout does.
pub const ADAPTER_VERSION: u32 = 7;

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

// Discovery (`discovery::DiscoveryMap`), driven by `shared/discovery.ts` (#1210). A map is a
// handle, uploaded once; each sample is one call over the map's input buffer, and its result is
// left in the map's output buffer.

/// Builds a discovery map (`discovery::DiscoveryMap::new`). The core copies every buffer.
///
/// # Safety
/// The pointers hold 6, `cell_count`, `landmark_count * 3`, `roof_words` and
/// `building_count * 5` items.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn discovery_map_new(
    constants: *const f64,
    inside: *const u8,
    cell_count: usize,
    landmarks: *const f64,
    landmark_count: usize,
    roofs: *const f64,
    roof_words: usize,
    buildings: *const f64,
    building_count: usize,
) -> *mut discovery::DiscoveryMap {
    // SAFETY: the caller's contract.
    let map = unsafe {
        discovery::DiscoveryMap::new(
            items(constants, 6),
            items(inside, cell_count),
            items(landmarks, landmark_count * 3),
            items(roofs, roof_words),
            items(buildings, building_count * 5),
        )
    };
    Box::into_raw(Box::new(map))
}

/// # Safety
/// `map` came from `discovery_map_new` and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn discovery_map_free(map: *mut discovery::DiscoveryMap) {
    // SAFETY: the caller's contract.
    drop(unsafe { Box::from_raw(map) });
}

/// The sample's input buffer, resized to `len` `f64`s (`discovery::DiscoveryMap::input`).
///
/// # Safety
/// `map` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn discovery_input(
    map: *mut discovery::DiscoveryMap,
    len: usize,
) -> *mut f64 {
    // SAFETY: the caller's contract.
    unsafe { (*map).input(len).as_mut_ptr() }
}

/// One sample (`discovery::DiscoveryMap::sample`); returns a pointer to its `u32` output, valid
/// until the next call. `index` and `gates` are the map's sight handles, or null for a sample
/// without line of sight.
///
/// # Safety
/// `map` is live, its input holds a whole sample, and `index` and `gates` are live or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn discovery_sample(
    map: *mut discovery::DiscoveryMap,
    index: *mut sight::SightIndex,
    gates: *mut sight::GateSet,
) -> *const u32 {
    // SAFETY: the caller's contract.
    unsafe {
        let sight = if index.is_null() || gates.is_null() {
            None
        } else {
            Some((&mut *index, &mut *gates))
        };
        (*map).sample(sight).as_ptr()
    }
}

/// Tick phase 1's buffers (`phase_one::PhaseOne`), made once per core by `shared/simulation/phase-one.ts`.
#[unsafe(no_mangle)]
pub extern "C" fn phase_one_new() -> *mut phase_one::PhaseOne {
    Box::into_raw(Box::default())
}

/// Phase 1's input, resized to `len` words (`phase_one::PhaseOne::input`).
///
/// # Safety
/// `phase` came from `phase_one_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn phase_one_input(phase: *mut phase_one::PhaseOne, len: usize) -> *mut f64 {
    // SAFETY: the caller's contract.
    unsafe { (*phase).input(len).as_mut_ptr() }
}

/// Runs phase 1 from player `from` (`phase_one::PhaseOne::run`); returns a pointer to its `f64`
/// output, valid until the next call.
///
/// # Safety
/// `phase` came from `phase_one_new`, and its input holds a whole tick.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn phase_one_run(phase: *mut phase_one::PhaseOne, from: usize) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe { (*phase).run(from).as_ptr() }
}

/// `roofAt`'s interned id at `(x, y)`, or -1: for the parity check against `shared/view.ts`
/// (`tests/discovery-core.test.js`), since `roofAt` keeps JavaScript callers.
///
/// # Safety
/// `map` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn discovery_roof_at(
    map: *const discovery::DiscoveryMap,
    x: f64,
    y: f64,
) -> i32 {
    // SAFETY: the caller's contract.
    unsafe { (*map).roof_at(x, y).map_or(-1, |id| id as i32) }
}

// Physics: Rapier's world (`physics::World`), driven by `shared/physics/world.ts` (#1192). A world
// is a handle; bodies are slots. Results are left in the world's output buffer, which JavaScript
// reads through a view made after the call.

#[unsafe(no_mangle)]
pub extern "C" fn physics_world_new() -> *mut physics::World {
    Box::into_raw(Box::new(physics::World::new()))
}

/// # Safety
/// `world` came from `physics_world_new` and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_world_free(world: *mut physics::World) {
    // SAFETY: the caller's contract.
    drop(unsafe { Box::from_raw(world) });
}

/// Adds a body (`physics::World::add_body`); returns its slot, or -1 when a convex shape cannot be
/// hulled. `vertices` holds `vertex_count` `x, y` pairs for a convex shape. Damping is `NaN` when
/// unset.
///
/// # Safety
/// `world` is live and `vertices` holds `vertex_count * 2` items.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn physics_add_body(
    world: *mut physics::World,
    kind: u32,
    map_geometry: u32,
    shape: u32,
    a: f64,
    b: f64,
    vertices: *const f64,
    vertex_count: usize,
    x: f64,
    y: f64,
    angle: f64,
    vx: f64,
    vy: f64,
    omega: f64,
    mass: f64,
    friction: f64,
    restitution: f64,
    linear_damping: f64,
    angular_damping: f64,
    groups: u32,
) -> i32 {
    let params = physics::BodyParams {
        kind,
        map_geometry: map_geometry != 0,
        pose: [x, y, angle, vx, vy, omega],
        material: [mass, friction, restitution],
        damping: [linear_damping, angular_damping],
        groups,
    };
    // SAFETY: the caller's contract.
    let (world, vertices) = unsafe { (&mut *world, items(vertices, vertex_count * 2)) };
    world
        .add_body(&params, shape, a, b, vertices)
        .map_or(-1, |slot| slot as i32)
}

/// # Safety
/// `world` is live and `slot` is a live body.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_remove_body(world: *mut physics::World, slot: u32) {
    // SAFETY: the caller's contract.
    unsafe { (*world).remove_body(slot) }
}

/// # Safety
/// `world` is live and `slot` is a live body.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_wake(world: *mut physics::World, slot: u32) {
    // SAFETY: the caller's contract.
    unsafe { (*world).wake(slot) }
}

/// # Safety
/// `world` is live and `a`, `b` are live bodies.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_add_rope(
    world: *mut physics::World,
    a: u32,
    b: u32,
    max_distance: f64,
) -> u32 {
    // SAFETY: the caller's contract.
    unsafe { (*world).add_rope(a, b, max_distance) }
}

/// # Safety
/// `world` is live and `rope` came from `physics_add_rope` and is removed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_remove_rope(world: *mut physics::World, rope: u32) {
    // SAFETY: the caller's contract.
    unsafe { (*world).remove_rope(rope) }
}

/// Sets linear (`angular` 0) or angular damping.
///
/// # Safety
/// `world` is live and `slot` is a live dynamic body.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_set_damping(
    world: *mut physics::World,
    slot: u32,
    angular: u32,
    value: f64,
) {
    // SAFETY: the caller's contract.
    unsafe { (*world).set_damping(slot, angular != 0, value) }
}

/// # Safety
/// `world` is live and `slot` is a live dynamic body.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_set_pose(
    world: *mut physics::World,
    slot: u32,
    x: f64,
    y: f64,
    angle: f64,
) {
    // SAFETY: the caller's contract.
    unsafe { (*world).set_pose(slot, x, y, angle) }
}

/// The body's pose: seven `f64`s at the returned pointer, valid until the next call.
///
/// # Safety
/// `world` is live and `slot` is a live body.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_pose(world: *mut physics::World, slot: u32) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe { (*world).pose(slot).as_ptr() }
}

/// The body's position and external force: four `f64`s, valid until the next call.
///
/// # Safety
/// `world` is live and `slot` is a live body.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_user_force(world: *mut physics::World, slot: u32) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe { (*world).user_force(slot).as_ptr() }
}

/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_propagate(world: *mut physics::World) {
    // SAFETY: the caller's contract.
    unsafe { (*world).propagate() }
}

/// Whether the body meets a ball (`shape` 0, radius `a`) or box (`shape` 1, half-extents `a`, `b`)
/// at `(x, y)`; 1 or 0.
///
/// # Safety
/// `world` is live and `slot` is a live body.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_intersects(
    world: *const physics::World,
    slot: u32,
    shape: u32,
    a: f64,
    b: f64,
    x: f64,
    y: f64,
) -> u32 {
    // SAFETY: the caller's contract.
    u32::from(unsafe { (*world).intersects(slot, shape, a, b, x, y) })
}

/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_prepare(world: *mut physics::World) -> usize {
    // SAFETY: the caller's contract.
    unsafe { (*world).prepare() }
}

/// The step's input buffer, resized to `len` `f64`s, for JavaScript to fill before `physics_step`.
///
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_input(world: *mut physics::World, len: usize) -> *mut f64 {
    // SAFETY: the caller's contract.
    unsafe { (*world).input(len).as_mut_ptr() }
}

/// One tick (`physics::World::step`); returns a pointer to its output, whose length follows from
/// the header. Valid until the next call.
///
/// # Safety
/// `world` is live and its input holds the counts' rows, naming live bodies.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_step(
    world: *mut physics::World,
    dynamic_count: usize,
    force_count: usize,
    impulse_count: usize,
    constraint_count: usize,
) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe {
        (*world)
            .step(dynamic_count, force_count, impulse_count, constraint_count)
            .as_ptr()
    }
}

/// Takes the floors and damping profiles floor drag reads from the input buffer
/// (`floor_drag::Floor::from_input`).
///
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_set_floor(world: *mut physics::World) {
    // SAFETY: the caller's contract.
    unsafe { (*world).set_floor() }
}

/// Floor drag (`physics::World::apply_floor_drag`); returns how many rows of
/// `physics::DRAG_STRIDE` `f64`s are at `physics_output`.
///
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_floor_drag(world: *mut physics::World) -> usize {
    // SAFETY: the caller's contract.
    unsafe { (*world).apply_floor_drag().len() / physics::DRAG_STRIDE }
}

/// The debug contacts (`physics::World::debug_contacts`); returns how many rows of seven `f64`s
/// are at `physics_output`.
///
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_debug_contacts(world: *mut physics::World) -> usize {
    // SAFETY: the caller's contract.
    unsafe { (*world).debug_contacts().len() / 7 }
}

/// The world's output buffer, as the last call left it.
///
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_output(world: *const physics::World) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe { (*world).output().as_ptr() }
}

#[cfg(test)]
mod tests {
    #[test]
    fn exports_the_adapter_version() {
        assert_eq!(super::adapter_version(), super::ADAPTER_VERSION);
    }
}
