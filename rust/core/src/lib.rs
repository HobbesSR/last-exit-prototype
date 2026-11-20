//! The simulation core (docs/27), built natively for `cargo test` and to `wasm32-unknown-unknown`
//! as the one module Node and the browser both load (`shared/core.ts`).
//!
//! The WASM module uses plain exports, not wasm-bindgen: the adapter passes flat typed buffers in
//! WASM memory (docs/27, rule 1), so there is no generated JavaScript glue to keep in step.

pub mod collision;
pub mod discovery;
pub mod floor_drag;
pub mod math;
pub mod phase_one;
pub mod physics;
pub mod sight;
pub mod world;

use std::alloc::{Layout, alloc, dealloc};
use std::slice;

/// The version of the contract between this module and its JavaScript adapter. A loader checks it
/// before calling anything else, and it changes whenever an export's meaning or layout does.
pub const ADAPTER_VERSION: u32 = 9;

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
/// `grid_len` `i32` words (`sight::Grid`), with the see-through obstacles' `through_count` edges,
/// `obstacle_count + 1` offsets (`u32`) giving each one's edges, and their grid. The core copies
/// every buffer; the caller may free them.
///
/// # Safety
/// The pointers hold `segment_count * 4`, `grid_len`, `through_count * 4`, `obstacle_count + 1`
/// and `through_grid_len` items.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn sight_index_new(
    segments: *const f64,
    segment_count: usize,
    grid: *const i32,
    grid_len: usize,
    through: *const f64,
    through_count: usize,
    through_offsets: *const u32,
    obstacle_count: usize,
    through_grid: *const i32,
    through_grid_len: usize,
) -> *mut sight::SightIndex {
    // SAFETY: the caller's contract.
    let index = unsafe {
        sight::SightIndex::new(
            items(segments, segment_count * 4),
            items(grid, grid_len),
            items(through, through_count * 4),
            items(through_offsets, obstacle_count + 1),
            items(through_grid, through_grid_len),
        )
    };
    Box::into_raw(Box::new(index))
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
/// gate's edges, each gate's box (`x, y, w, h`, `f64`), and a grid of gate indices. All gates start
/// closed.
///
/// # Safety
/// The pointers hold `edge_count * 4`, `gate_count + 1`, `gate_count * 4` and `grid_len` items.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gate_set_new(
    edges: *const f64,
    edge_count: usize,
    offsets: *const u32,
    gate_count: usize,
    boxes: *const f64,
    grid: *const i32,
    grid_len: usize,
) -> *mut sight::GateSet {
    // SAFETY: the caller's contract.
    let (edges, offsets, boxes, grid) = unsafe {
        (
            items(edges, edge_count * 4),
            items(offsets, gate_count + 1),
            items(boxes, gate_count * 4),
            items(grid, grid_len),
        )
    };
    Box::into_raw(Box::new(sight::GateSet::new(edges, offsets, boxes, grid)))
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

// Collision (`collision::CollisionMap`, #1233): a map's playable cells and colliders, uploaded once,
// queried with the map's sight index and gate set. Answers are scalars, so nothing is left in memory.

/// Builds a collision map (`collision::CollisionMap::new`). The core copies every buffer.
///
/// # Safety
/// The pointers hold 5, `cell_count`, `collider_words`, `collider_count + 1` and `grid_len` items.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn collision_map_new(
    constants: *const f64,
    occupied: *const u8,
    cell_count: usize,
    colliders: *const f64,
    collider_words: usize,
    offsets: *const u32,
    collider_count: usize,
    grid: *const i32,
    grid_len: usize,
) -> *mut collision::CollisionMap {
    // SAFETY: the caller's contract.
    let map = unsafe {
        collision::CollisionMap::new(
            items(constants, 5),
            items(occupied, cell_count),
            items(colliders, collider_words),
            items(offsets, collider_count + 1),
            items(grid, grid_len),
        )
    };
    Box::into_raw(Box::new(map))
}

/// # Safety
/// `map` came from `collision_map_new` and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn collision_map_free(map: *mut collision::CollisionMap) {
    // SAFETY: the caller's contract.
    drop(unsafe { Box::from_raw(map) });
}

/// `canOccupy` (`collision::can_occupy`): 1 when clear. `flags` bit 1 ignores the gates, bit 2 is
/// a projectile's test, which passes see-through obstacles.
///
/// # Safety
/// `map` and `gates` are live, and `gates` is the map's gate set with its open mask written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn can_occupy(
    map: *mut collision::CollisionMap,
    gates: *mut sight::GateSet,
    x: f64,
    y: f64,
    radius: f64,
    flags: u32,
) -> u32 {
    // SAFETY: the caller's contract.
    let (map, gates) = unsafe { (&mut *map, &mut *gates) };
    u32::from(collision::can_occupy(
        map,
        gates,
        x,
        y,
        radius,
        flags & 1 != 0,
        flags & 2 != 0,
    ))
}

/// `insideMap` over the uploaded cells: 1 when the disk lies wholly on playable ground.
///
/// # Safety
/// `map` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn collision_inside(
    map: *const collision::CollisionMap,
    x: f64,
    y: f64,
    radius: f64,
) -> u32 {
    // SAFETY: the caller's contract.
    u32::from(unsafe { (*map).inside(x, y, radius) })
}

/// Collider `i`'s disk test, for the parity check against `diskPenetration`: its depth, or -1.
///
/// # Safety
/// `map` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn collision_depth(
    map: *const collision::CollisionMap,
    i: usize,
    x: f64,
    y: f64,
    radius: f64,
) -> f64 {
    // SAFETY: the caller's contract.
    unsafe { (*map).depth(i, x, y, radius) }
}

/// `lineClear` from `(ax, ay)` to `(bx, by)`: the ray-edge tests made, doubled, plus 1 when clear.
/// A gate the caller ignores is written open in the mask.
///
/// # Safety
/// `index` and `gates` are live, and `gates` has its open mask written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn line_clear(
    index: *const sight::SightIndex,
    gates: *const sight::GateSet,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
) -> u32 {
    // SAFETY: the caller's contract.
    let (clear, tests) = unsafe { collision::line_clear(&*index, &*gates, (ax, ay), (bx, by)) };
    tests << 1 | u32::from(clear)
}

/// `reachClear`, answered as `line_clear` is.
///
/// # Safety
/// As `line_clear`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn reach_clear(
    index: *const sight::SightIndex,
    gates: *const sight::GateSet,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
) -> u32 {
    // SAFETY: the caller's contract.
    let (clear, tests) = unsafe { collision::reach_clear(&*index, &*gates, (ax, ay), (bx, by)) };
    tests << 1 | u32::from(clear)
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

// Physics: the world (`world::World`, #1232), its bookkeeping around Rapier's engine
// (`physics::World`, #1192), driven by `shared/physics/world.ts`. A world is a handle; bodies,
// constraints and pushes are named by interned keys. Rows go in through `physics_input`; results
// are left in the world's output buffer, which JavaScript reads through a view made after the call.
// Negative returns are `world::E_*` refusals.

/// Defines an export that takes a live world first and forwards to its method.
macro_rules! world_export {
    ($(#[$doc:meta])* $name:ident($($arg:ident: $ty:ty),*) -> $ret:ty = |$w:ident| $body:expr) => {
        $(#[$doc])*
        ///
        /// # Safety
        /// `world` came from `physics_world_new` and is live.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(world: *mut world::World, $($arg: $ty),*) -> $ret {
            // SAFETY: the caller's contract.
            let $w = unsafe { &mut *world };
            $body
        }
    };
}

#[unsafe(no_mangle)]
pub extern "C" fn physics_world_new() -> *mut world::World {
    Box::into_raw(Box::new(world::World::new()))
}

/// # Safety
/// `world` came from `physics_world_new` and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_world_free(world: *mut world::World) {
    // SAFETY: the caller's contract.
    drop(unsafe { Box::from_raw(world) });
}

world_export!(
    /// The input buffer, resized to `len` `f64`s, for the call that reads rows.
    physics_input(len: usize) -> *mut f64 = |w| w.input(len).as_mut_ptr()
);
world_export!(
    /// The output buffer, as the last call left it.
    physics_output() -> *const f64 = |w| w.output().as_ptr()
);
world_export!(
    /// Interns the ID whose UTF-16 code units fill the input; returns its key.
    physics_intern() -> u32 = |w| w.intern()
);
world_export!(physics_check_queue() -> i32 = |w| w.check_queue());
world_export!(
    /// Queues the body whose row fills the input (`world::World::queue_add_body`).
    physics_queue_add_body() -> i32 = |w| w.queue_add_body()
);
world_export!(physics_queue_remove_body(key: u32) -> i32 = |w| w.queue_remove_body(key));
world_export!(
    /// Queues the constraint whose row fills the input (`world::World::queue_add_constraint`).
    physics_queue_add_constraint() -> i32 = |w| w.queue_add_constraint()
);
world_export!(physics_queue_remove_constraint(key: u32) -> i32 = |w| w.queue_remove_constraint(key));
world_export!(
    /// Queues a force (`impulse` 0) or an impulse.
    physics_queue_push(impulse: u32, key: u32, x: f64, y: f64) -> i32 =
        |w| w.queue_push(impulse != 0, key, x, y)
);
world_export!(physics_can_add_bodies(count: usize) -> u32 = |w| u32::from(w.can_add_bodies(count)));
world_export!(
    /// Applies the queues: 0 or `E_INVALID_CONVEX`. The output holds the facts' count, then the
    /// `kind, key` facts of whatever was done.
    physics_commit() -> i32 = |w| w.commit()
);
world_export!(physics_has_constraint(key: u32) -> u32 = |w| u32::from(w.has_constraint(key)));
world_export!(
    /// The body's generation, or -1.
    physics_generation(key: u32) -> f64 = |w| w.generation(key)
);
world_export!(
    physics_set_motor(key: u32, x: f64, y: f64, accel: f64) -> i32 = |w| w.set_motor(key, x, y, accel)
);
world_export!(
    /// Returns which damping changed: bit 1 linear, bit 2 angular.
    physics_set_damping(key: u32, linear: f64, angular: f64) -> i32 = |w| w.set_damping(key, linear, angular)
);
world_export!(
    physics_set_transform(key: u32, x: f64, y: f64, angle: f64) -> i32 =
        |w| w.set_transform(key, x, y, angle)
);
world_export!(
    /// The body's pose, seven `f64`s in the output; 0 when it has none.
    physics_transform(key: u32) -> u32 = |w| u32::from(w.transform(key))
);
world_export!(physics_overlaps_prop(r: f64, x: f64, y: f64) -> u32 = |w| u32::from(w.overlaps_prop(r, x, y)));
world_export!(
    physics_overlaps_dynamic_box(hx: f64, hy: f64, x: f64, y: f64) -> u32 =
        |w| u32::from(w.overlaps_dynamic_box(hx, hy, x, y))
);
world_export!(
    /// `actors, dynamic, static, constraints` in the output.
    physics_counts() -> u32 = |w| { w.counts(); 4 }
);
world_export!(physics_prepare_statics() -> i32 = |w| w.prepare_statics());
world_export!(
    /// Takes the floors and damping profiles from the input (`floor_drag::Floor::from_input`).
    physics_set_floor() -> u32 = |w| { w.set_floor(); 0 }
);
world_export!(
    /// Floor drag; returns the count of `key, changed, linear, angular` rows in the output.
    physics_floor_drag() -> usize = |w| w.apply_floor_drag()
);
world_export!(
    /// One tick (`world::World::step`); returns a pointer to its output.
    physics_step(discard_contacts: u32) -> *const f64 = |w| w.step(discard_contacts != 0).as_ptr()
);
world_export!(physics_drain_contacts() -> usize = |w| w.drain_contacts());
world_export!(physics_debug_forces() -> usize = |w| w.debug_forces());
world_export!(physics_debug_contacts() -> usize = |w| w.debug_contacts());
world_export!(
    /// `world::SNAPSHOT_STRIDE` rows in ID order; returns their count.
    physics_snapshot(include_static: u32) -> usize = |w| w.snapshot(include_static != 0)
);
world_export!(physics_solid_props() -> usize = |w| w.solid_props());
world_export!(physics_pending() -> u32 = |w| { w.pending(); 0 });
world_export!(physics_constraint_keys() -> usize = |w| w.constraint_keys());

#[cfg(test)]
mod tests {
    #[test]
    fn exports_the_adapter_version() {
        assert_eq!(super::adapter_version(), super::ADAPTER_VERSION);
    }
}
