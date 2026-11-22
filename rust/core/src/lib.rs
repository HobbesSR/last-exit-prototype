//! The simulation core (docs/27), built natively for `cargo test` and to `wasm32-unknown-unknown`
//! as the one module Node and the browser both load (`shared/core.ts`).
//!
//! The WASM module uses plain exports, not wasm-bindgen: the adapter passes flat typed buffers in
//! WASM memory (docs/27, rule 1), so there is no generated JavaScript glue to keep in step.

pub mod action_combat;
pub mod action_equipment;
pub mod action_types;
pub mod boundary;
pub mod collision;
pub mod combat;
pub mod discovery;
pub mod drop_planner;
pub mod floor_drag;
pub mod ground;
pub mod hazards;
pub mod hooks;
pub mod item_allocation;
pub mod math;
pub mod phase_one;
pub mod phase_seven;
pub mod phase_six;
pub mod phase_three;
pub mod physics;
pub mod placement;
pub mod players;
pub mod registry;
pub mod scatter;
pub mod sight;
pub mod swept;
pub mod world;

use std::alloc::{Layout, alloc, dealloc};
use std::slice;

/// The version of the contract between this module and its JavaScript adapter. A loader checks it
/// before calling anything else, and it changes whenever an export's meaning or layout does.
pub const ADAPTER_VERSION: u32 = 35;

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

/// The open mask, one byte per gate, nonzero where open: a game's doors' state (#1214 stage 6a), which JavaScript
/// writes once when the game is made and between ticks; for a map no game owns, before each call.
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

// Swept contact (`swept::SweptMap`, #1229 stage 5d.1): the static and gate shapes a sweep reads,
// uploaded once. Shape rows are `swept::shapes_from_rows`'s.

/// Builds a sweep map (`swept::SweptMap::new`). The core copies every buffer.
///
/// # Safety
/// The pointers hold `statics_len` words, `static_count` bytes and `gates_len` words.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn swept_map_new(
    statics: *const f64,
    statics_len: usize,
    shots: *const u8,
    static_count: usize,
    gates: *const f64,
    gates_len: usize,
) -> *mut swept::SweptMap {
    // SAFETY: the caller's contract.
    let map = unsafe {
        swept::SweptMap::new(
            swept::shapes_from_rows(items(statics, statics_len)),
            items(shots, static_count).iter().map(|&s| s != 0).collect(),
            swept::shapes_from_rows(items(gates, gates_len)),
        )
    };
    Box::into_raw(Box::new(map))
}

/// # Safety
/// `map` came from `swept_map_new` and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn swept_map_free(map: *mut swept::SweptMap) {
    // SAFETY: the caller's contract.
    drop(unsafe { Box::from_raw(map) });
}

/// `geometryContact` (`swept::SweptMap::contact`): the first contact of a sweep, infinity when
/// clear. `pass_see_through` nonzero is the shot policy. `extra_ptr` holds `extra_len` words of shape rows.
///
/// # Safety
/// `map` and `gates` are live, `gates` is the map's gate set with its open mask written, and
/// `extra_ptr` holds `extra_len` words.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn swept_contact(
    map: *const swept::SweptMap,
    gates: *const sight::GateSet,
    pass_see_through: u32,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    radius: f64,
    extra_ptr: *const f64,
    extra_len: usize,
) -> f64 {
    // SAFETY: the caller's contract.
    unsafe {
        let extra = swept::shapes_from_rows(items(extra_ptr, extra_len));
        (*map).contact(
            &*gates,
            pass_see_through != 0,
            [ax, ay],
            [bx, by],
            radius,
            &extra,
        )
    }
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

/// Runs phase 1 (`phase_one::PhaseOne::run`); returns a pointer to its `f64` output, valid until
/// the next call. `world` is the game's physics world, and `map` and `gates` the map's collision
/// upload and gate set, for the station clearance and the landing.
///
/// # Safety
/// `phase` came from `phase_one_new`, its input holds a whole tick, `world`, `map` and `gates` are
/// live, and `gates` is the map's gate set with its open mask written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn phase_one_run(
    phase: *mut phase_one::PhaseOne,
    world: *mut world::World,
    map: *mut collision::CollisionMap,
    gates: *mut sight::GateSet,
) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe { (*phase).run(&mut *world, &mut *map, &mut *gates).as_ptr() }
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

// The tick boundary (`boundary::*`, #1234), driven by `shared/simulation/boundary.ts`: the body sync,
// phase 1's pending admission and the placement search. Each reads the world's boundary input and
// leaves its header and log in the world's boundary output.

world_export!(
    /// The boundary input, resized to `len` `f64`s.
    physics_boundary_input(len: usize) -> *mut f64 = |w| {
        w.boundary_input.resize(len, 0.0);
        w.boundary_input.as_mut_ptr()
    }
);
world_export!(
    /// The boundary output, as the last boundary call left it.
    physics_boundary_output() -> *const f64 = |w| w.boundary_output.as_ptr()
);

/// The whole body sync (`boundary::synchronize`, #1214 stage 6d.6).
///
/// # Safety
/// `world`, `map`, `gates` and `swept` are live, and `gates` is the map's gate set with its open mask written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_sync(
    world: *mut world::World,
    map: *mut collision::CollisionMap,
    gates: *mut sight::GateSet,
    swept: *const swept::SweptMap,
) {
    // SAFETY: the caller's contract.
    unsafe { boundary::synchronize(&mut *world, &mut *map, &mut *gates, &*swept) }
}

/// The sync's match-pinned settings from the boundary input (`World::configure_sync`, #1214 stage 6d.6).
///
/// # Safety
/// `world` is live and its boundary input holds the settings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_sync_configure(world: *mut world::World) {
    // SAFETY: the caller's contract.
    unsafe { (*world).configure_sync() }
}

/// Phase 1's pending admission (`boundary::admit_pending`).
///
/// # Safety
/// `world`, `index` and `gates` are live, and `gates` is the map's gate set with its open mask written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_admit_pending(
    world: *mut world::World,
    index: *const sight::SightIndex,
    gates: *const sight::GateSet,
) {
    // SAFETY: the caller's contract.
    unsafe { boundary::admit_pending(&mut *world, &*index, &*gates) }
}

/// The placement search (`boundary::place`).
///
/// # Safety
/// As `physics_sync`, without the swept map.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_place(
    world: *mut world::World,
    map: *mut collision::CollisionMap,
    gates: *mut sight::GateSet,
) {
    // SAFETY: the caller's contract.
    unsafe { boundary::place(&mut *world, &mut *map, &mut *gates) }
}

/// The drop planner's spiral search (`boundary::scatter`).
///
/// # Safety
/// `world`, `map`, `index` and `gates` are live, and `gates` is the map's gate set with its open mask
/// written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_scatter(
    world: *mut world::World,
    map: *mut collision::CollisionMap,
    index: *const sight::SightIndex,
    gates: *mut sight::GateSet,
) {
    // SAFETY: the caller's contract.
    unsafe { boundary::scatter(&mut *world, &mut *map, &*index, &mut *gates) }
}

/// The hook's rules after launch (`hooks::run`, #1229): `prepareHooks`, `finishHooks` or
/// `reconcileHooks` by the input's mode, over the world's boundary input and output.
///
/// # Safety
/// `world`, `swept` and `gates` are live, and `gates` is the map's gate set with its open mask written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_hooks(
    world: *mut world::World,
    swept: *const swept::SweptMap,
    gates: *const sight::GateSet,
) {
    // SAFETY: the caller's contract.
    unsafe { hooks::run(&mut *world, &*swept, &*gates) }
}

/// `solidContact` (`hooks::solid_contact`) with the world's solid props, for the parity check.
///
/// # Safety
/// As `physics_hooks`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_solid_contact(
    world: *mut world::World,
    swept: *const swept::SweptMap,
    gates: *const sight::GateSet,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    radius: f64,
) -> f64 {
    // SAFETY: the caller's contract.
    unsafe { hooks::solid_contact(&mut *world, &*swept, &*gates, [ax, ay], [bx, by], radius) }
}

/// Phase 3's reusable per-world flat input (27, step 5c.2).
/// # Safety
/// `world` is a live world handle; returned views expire on the next growing core call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn actions_input(world: *mut world::World, len: usize) -> *mut f64 {
    // SAFETY: the caller owns the live world.
    let actions = unsafe { &mut (*world).actions };
    actions.input.resize(len, 0.0);
    actions.input.as_mut_ptr()
}
/// Upload the match-pinned phase 3 rules in the input.
/// # Safety
/// The input holds the complete phase_three configuration layout.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn actions_configure(world: *mut world::World) {
    // SAFETY: the caller owns the live world and complete input.
    unsafe { (*world).actions.configure() }
}
/// Run phase 3, a shared attack, or a transactional drop plan. `swept` may be null unless the loop syncs its drops in
/// the run (#1214 stage 6d.6b).
/// # Safety
/// All handles are live, disjoint, and the input and gate mask are complete.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn actions_run(
    world: *mut world::World,
    map: *mut collision::CollisionMap,
    index: *const sight::SightIndex,
    gates: *mut sight::GateSet,
    swept: *const swept::SweptMap,
) -> *const f64 {
    // SAFETY: these handles are owned by the calling game. Move the buffers out so the
    // phase can mutate the world's bodies without aliasing its own storage.
    unsafe {
        let w = &mut *world;
        let mut actions = std::mem::take(&mut w.actions);
        actions.run(w, &mut *map, &*index, &mut *gates, swept.as_ref());
        w.actions = actions;
        // The player store takes phase 3's writes (#1214 stage 6c.2).
        let mode = w.actions.input.first().copied().unwrap_or(0.0);
        w.players.apply_actions(mode, &w.actions.output);
        // The run applied the hooks' launches and cancels to the world itself (6d.6b), before each sync inside it.
        w.actions.output.as_ptr()
    }
}

/// Phase 5's combat input (27, step 5d.2; `combat::Combat`).
/// # Safety
/// `world` is a live world handle; the returned view expires on the next growing core call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn combat_input(world: *mut world::World, len: usize) -> *mut f64 {
    // SAFETY: the caller owns the live world.
    let combat = unsafe { &mut (*world).combat };
    combat.input.resize(len, 0.0);
    combat.input.as_mut_ptr()
}
/// Run phase 5's projectiles or casters, or one damage (`combat::Combat::run`), after phase 3's
/// rules were configured (`actions_configure`). `swept` may be null except for a fresh projectile call.
/// # Safety
/// All handles are live, the gate mask is written and the input is complete.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn combat_run(
    world: *mut world::World,
    index: *const sight::SightIndex,
    gates: *mut sight::GateSet,
    swept: *const swept::SweptMap,
) -> *const f64 {
    // SAFETY: the caller's contract; the rules and the combat state are disjoint fields.
    unsafe {
        let w = &mut *world;
        let rules = w.actions.rules();
        w.combat.run(
            &mut w.players,
            rules,
            &w.phase_seven.rewind,
            &*index,
            &mut *gates,
            swept.as_ref(),
        );
        w.combat.output.as_ptr()
    }
}

/// How many gates' positions and kinds phase 6's adapter has sent to this gate set (`GateSet::details`).
/// # Safety
/// `gates` is a live gate set.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gate_set_details(gates: *const sight::GateSet) -> usize {
    // SAFETY: the caller's contract.
    unsafe { (*gates).details.len() }
}
/// The lock mask, one byte per gate (`GateSet::locked`), written as the open mask is.
/// # Safety
/// `gates` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gate_set_locked(gates: *mut sight::GateSet) -> *mut u8 {
    // SAFETY: the caller's contract.
    unsafe { (*gates).locked.as_mut_ptr() }
}
/// Phase 6's per-actor loop input (27, step 5e.1; `phase_six::PhaseSix`).
/// # Safety
/// `world` is a live world handle; the returned view expires on the next growing core call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn interactions_input(world: *mut world::World, len: usize) -> *mut f64 {
    // SAFETY: the caller owns the live world.
    let interactions = unsafe { &mut (*world).interactions };
    interactions.input.resize(len, 0.0);
    interactions.input.as_mut_ptr()
}
/// Run phase 6's per-actor loop (`phase_six::PhaseSix::run`) after phase 3's rules were configured
/// (`actions_configure`).
/// # Safety
/// All handles are live, disjoint, and the input and gate mask are complete.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn interactions_run(
    world: *mut world::World,
    map: *mut collision::CollisionMap,
    index: *const sight::SightIndex,
    gates: *mut sight::GateSet,
    swept: *const swept::SweptMap,
) -> *const f64 {
    // SAFETY: these handles are owned by the calling game. The buffers and the rules move out so the
    // run can use the world's bodies without aliasing them.
    unsafe {
        let w = &mut *world;
        let mut interactions = std::mem::take(&mut w.interactions);
        let actions = std::mem::take(&mut w.actions);
        interactions.run(
            actions.rules(),
            w,
            &mut *map,
            &*index,
            &mut *gates,
            swept.as_ref(),
        );
        w.actions = actions;
        w.interactions = interactions;
        // The run applied its writes to the player store itself (6d.6c.2), as each stop inside it needed them.
        w.interactions.output.as_ptr()
    }
}
/// The gates' keys and closed bodies' rows, from the boundary input, once per world (`World::load_gates`, #1214 stage
/// 6d.2).
/// # Safety
/// `world` is live and its boundary input holds `count` gate rows.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_gates_load(world: *mut world::World, count: usize) {
    // SAFETY: the caller's contract.
    unsafe { (*world).load_gates(count) }
}
/// Items launched since the last admission (`world::World::launches`, #1214 stage 6d.3): `count` rows of key, vx, vy
/// from the boundary input. A key launched again takes the later motion.
/// # Safety
/// `world` is live and its boundary input holds `count` rows.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_launch(world: *mut world::World, count: usize) {
    // SAFETY: the caller's contract.
    let w = unsafe { &mut *world };
    for k in 0..count {
        let r = &w.boundary_input[k * 3..k * 3 + 3];
        let (key, vx, vy) = (r[0] as world::Key, r[1], r[2]);
        w.launch(key, vx, vy);
    }
}
/// Replace the world's hooks with `count` records from the boundary input (`World::load_hooks`, #1214 stage 6d.4).
/// # Safety
/// `world` is live and its boundary input holds `count` records.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_hooks_load(world: *mut world::World, count: usize) {
    // SAFETY: the caller's contract.
    unsafe { (*world).load_hooks(count) }
}
/// The world's hooks in the upload's layout, written into the boundary output, for tests; the count is the output's
/// length over `world::HOOK_RECORD`.
/// # Safety
/// `world` is live; the view expires on the next call into the world.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_hooks_dump(world: *mut world::World) -> *const f64 {
    // SAFETY: the caller's contract.
    let w = unsafe { &mut *world };
    let mut out = std::mem::take(&mut w.boundary_output);
    out.clear();
    out.push(w.hooks.len() as f64);
    for h in &w.hooks {
        out.extend_from_slice(&[
            f64::from(h.key),
            h.caster,
            h.x,
            h.y,
            h.dx,
            h.dy,
            h.travelled,
            h.started,
            h.phase,
            h.generation_a,
            h.target,
            h.target_key,
            h.generation_b,
            h.hit_tick,
            h.desired,
        ]);
    }
    w.boundary_output = out;
    w.boundary_output.as_ptr()
}
/// `enqueuePhysicsImpulse` in the core, after JavaScript's validation and sync (`World::enqueue_impulse`, #1214 stage
/// 6d.5); a refusal code, or 0.
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_enqueue_impulse(
    world: *mut world::World,
    key: u32,
    x: f64,
    y: f64,
    limit: f64,
) -> i32 {
    // SAFETY: the caller's contract.
    unsafe { (*world).enqueue_impulse(key, x, y, limit) }
}
/// `enqueuePhysicsAttachment` in the core (`World::enqueue_attachment`); a refusal code, or 0.
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_enqueue_attachment(
    world: *mut world::World,
    key: u32,
    a: u32,
    b: u32,
    max: f64,
) -> i32 {
    // SAFETY: the caller's contract.
    unsafe { (*world).enqueue_attachment(key, a, b, max) }
}
/// The sync's last step: drop pending entries whose bodies changed generation (`World::filter_pending`).
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_filter_pending(world: *mut world::World) {
    // SAFETY: the caller's contract.
    unsafe { (*world).filter_pending() }
}
/// The pending queues, for JavaScript's mirror, written into the boundary output: the impulse and attachment counts,
/// then `key, x, y, generation` per impulse and `key, a, b, max distance, generation a, generation b` per attachment.
/// # Safety
/// `world` is live; the view expires on the next call into the world.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn physics_queues_dump(world: *mut world::World) -> *const f64 {
    // SAFETY: the caller's contract.
    let w = unsafe { &mut *world };
    let mut out = std::mem::take(&mut w.boundary_output);
    out.clear();
    out.extend_from_slice(&[
        w.pending_impulses.len() as f64,
        w.pending_attachments.len() as f64,
    ]);
    for p in &w.pending_impulses {
        out.extend_from_slice(&[f64::from(p.0), p.1, p.2, p.3]);
    }
    for p in &w.pending_attachments {
        out.extend_from_slice(&[
            f64::from(p.key),
            f64::from(p.a),
            f64::from(p.b),
            p.max_distance,
            p.generation_a,
            p.generation_b,
        ]);
    }
    w.boundary_output = out;
    w.boundary_output.as_ptr()
}
/// Node's registrations (`registry::REGISTRATION` words each) from the boundary input into the world's item registry
/// (#1214 stage 6e.1); `replace` starts it afresh. From then on the runs read it.
/// # Safety
/// `world` is live and its boundary input holds `count` registrations.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn item_registry_add(world: *mut world::World, count: usize, replace: u32) {
    // SAFETY: the caller's contract.
    let w = unsafe { &mut *world };
    let rows: Vec<f64> = w.boundary_input[..count * registry::REGISTRATION].to_vec();
    if replace != 0 {
        w.registry = std::rc::Rc::default();
    }
    let registry = std::rc::Rc::make_mut(&mut w.registry);
    for r in rows.chunks(registry::REGISTRATION) {
        registry.insert(r[0], r[1], r[2]);
    }
    w.registry_live = true;
}
/// The world's item registry (`Registry::dump`), written into the boundary output, for tests: the count of IDs, then
/// `id, key` per ID by bits, then the reserved phases' count and phases.
/// # Safety
/// `world` is live; the view expires on the next call into the world.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn item_registry_dump(world: *mut world::World) -> *const f64 {
    // SAFETY: the caller's contract.
    let w = unsafe { &mut *world };
    let mut out = std::mem::take(&mut w.boundary_output);
    out.clear();
    out.push(w.registry.len() as f64);
    w.registry.dump(&mut out);
    w.boundary_output = out;
    w.boundary_output.as_ptr()
}
/// The ground store's input buffer, resized for `count` records (`ground::Ground`, #1214 stage 6d.1).
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ground_input(world: *mut world::World, count: usize) -> *mut f64 {
    // SAFETY: the caller's contract.
    unsafe { (*world).ground.input(count).as_mut_ptr() }
}
/// The ground store's write: 0 replaces the store with the input, 1 appends the input, 2 removes the record at `at`,
/// 3 puts the input's one record at `at` (`ground::Ground`).
/// # Safety
/// `world` is live and the input holds what the write reads.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ground_write(world: *mut world::World, op: u32, at: usize) {
    // SAFETY: the caller's contract.
    let w = unsafe { &mut *world };
    // The keys awaiting a body follow the ground (#1214 stage 6d.3).
    match op {
        0 => {
            w.ground.load();
            w.rebuild_waiting();
        }
        1 => {
            let words = w.ground.input_words().to_vec();
            w.add_ground(&words);
        }
        2 => w.remove_ground(at),
        3 => w.ground.replace(at),
        _ => panic!("unknown ground write {op}"),
    }
}
/// The ground store in the upload's layout (`ground::Ground::dump`), for tests; the count is `ground_count`'s.
/// # Safety
/// `world` is live; the view expires on the next call into the store.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ground_dump(world: *mut world::World) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe { (*world).ground.dump().as_ptr() }
}
/// How many records the ground store holds.
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ground_count(world: *const world::World) -> usize {
    // SAFETY: the caller's contract.
    unsafe { (*world).ground.len() }
}
/// Phase 4's write-back to the player store, from the world's last step output (`players::Players::after_step`, #1214
/// stage 6c.2). Call it right after `physics_step`, before any other call reuses the world's output.
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn players_after_step(world: *mut world::World) {
    // SAFETY: the caller's contract.
    unsafe {
        let w = &mut *world;
        w.players.after_step(&w.output);
    }
}
/// The player store in the upload's layout (`players::Players::dump`), for tests; the count is `players_count`'s.
/// # Safety
/// `world` is live; the view expires on the next call into the store.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn players_dump(world: *mut world::World) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe { (*world).players.dump().as_ptr() }
}
/// How many players the store holds.
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn players_count(world: *const world::World) -> usize {
    // SAFETY: the caller's contract.
    unsafe { (*world).players.len() }
}
/// The player store's upload buffer, resized to `words`: every fixed row, then each equipment (`players::Players`, #1214 stage 6c).
/// # Safety
/// `world` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn players_input(world: *mut world::World, words: usize) -> *mut f64 {
    // SAFETY: the caller's contract.
    unsafe { (*world).players.input(words).as_mut_ptr() }
}
/// Replace the player store with its upload buffer.
/// # Safety
/// `world` is live and its upload buffer holds `count` players.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn players_load(world: *mut world::World, count: usize) {
    // SAFETY: the caller's contract.
    unsafe { (*world).players.load(count) }
}
/// Phase 6's environment and traps input (27, step 5e.2; `hazards::Hazards`).
/// # Safety
/// `world` is a live world handle; the returned view expires on the next growing core call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hazards_input(world: *mut world::World, len: usize) -> *mut f64 {
    // SAFETY: the caller owns the live world.
    let hazards = unsafe { &mut (*world).hazards };
    hazards.input.resize(len, 0.0);
    hazards.input.as_mut_ptr()
}
/// Run phase 6's environment and traps (`hazards::Hazards::run`) after phase 3's rules were configured
/// (`actions_configure`).
/// # Safety
/// All handles are live, disjoint, and the input and gate mask are complete.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hazards_run(
    world: *mut world::World,
    map: *mut collision::CollisionMap,
    index: *const sight::SightIndex,
    gates: *mut sight::GateSet,
    swept: *const swept::SweptMap,
) -> *const f64 {
    // SAFETY: the caller's contract; `swept` may be null unless a mine's explosion is carried out in the run. The
    // hazards move out so the run can use the whole world (6d.6d).
    unsafe {
        let w = &mut *world;
        let hz = w.actions.rules().hz;
        let mut hazards = std::mem::take(&mut w.hazards);
        hazards.run(w, &mut *map, &*index, &mut *gates, hz, swept.as_ref());
        w.hazards = hazards;
        w.hazards.output.as_ptr()
    }
}
/// Phase 7's input (27, step 5e.2; `phase_seven::PhaseSeven`).
/// # Safety
/// `world` is a live world handle; the returned view expires on the next growing core call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn phase_seven_input(world: *mut world::World, len: usize) -> *mut f64 {
    // SAFETY: the caller owns the live world.
    let p = unsafe { &mut (*world).phase_seven };
    p.input.resize(len, 0.0);
    p.input.as_mut_ptr()
}
/// Run phase 7's `finishMatch` or `recordRewind` (`phase_seven::PhaseSeven::run`).
/// # Safety
/// `world` is live and the input is complete.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn phase_seven_run(world: *mut world::World) -> *const f64 {
    // SAFETY: the caller's contract.
    unsafe {
        let w = &mut *world;
        // The rows come from the player store (#1214 stage 6c.3a): role and status to finish, the pose to rewind.
        let p7 = &mut w.phase_seven.input;
        let (mode, players) = (p7[0] as usize, p7[3] as usize);
        assert_eq!(w.players.len(), players, "the store holds the roster");
        p7.truncate(phase_seven::HEADER);
        for r in &w.players.rows {
            p7.extend_from_slice(&if mode == phase_seven::MODE_FINISH {
                [r.role, r.status]
            } else {
                [r.x, r.y]
            });
        }
        w.phase_seven.run();
        // A finished match strands its active contestants, in the player store too (#1214 stage 6c.2).
        let (input, out) = (&w.phase_seven.input, &w.phase_seven.output);
        if input.first() == Some(&(phase_seven::MODE_FINISH as f64)) && out[1] == 1.0 {
            for &i in &out[4..4 + out[3] as usize] {
                if let Some(r) = w.players.rows.get_mut(i as usize) {
                    r.status = 4.0;
                }
            }
        }
        w.phase_seven.output.as_ptr()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn exports_the_adapter_version() {
        assert_eq!(super::adapter_version(), super::ADAPTER_VERSION);
    }
}
