//! Rapier compiled into the core (docs/27 "Physics", #1192), behind `shared/physics/world.ts`.
//!
//! `world.rs` keeps everything that is not the engine: the records, the command queues, the
//! commit order, generations and every ordering by ID (#1232). This module holds Rapier's sets and
//! does what rapier.js did for it, with the same parameters and in the same order, so a world built
//! by the same calls steps the same way. Bodies are addressed by *slot*, a small index `world.rs`
//! maps to its keys; a collider's `user_data` is its slot, so events name slots, never handles.
//!
//! One `step` is one call: all four substeps, with the motors, queued forces and impulses, the
//! bounded constraints and the speed caps world.ts used to apply between rapier.js calls, run here
//! from one flat input buffer. Values are converted exactly as the adapter converted them: world
//! units are divided by `SCALE` in `f64` and rounded once to Rapier's `f32`, and what comes back is
//! widened to `f64` before it is scaled.

use crate::floor_drag::{self, Floor};
use crate::math;
use rapier2d::parry::query;
use rapier2d::prelude::*;
use std::sync::Mutex;

/// World units per Rapier metre (`shared/physics/units.ts`).
pub const SCALE: f64 = 40.0;
/// Substeps per game tick and their length (`shared/physics/motion-limits.ts`).
pub const SUBSTEPS: usize = 4;
pub const DT: f64 = 0.0125;

/// Values per entry of each section of the step's input (`world.rs` writes them).
pub const DYNAMIC_STRIDE: usize = 7;
pub const PUSH_STRIDE: usize = 3;
pub const CONSTRAINT_STRIDE: usize = 13;
/// Values per output event.
pub const EVENT_STRIDE: usize = 4;
/// The step's output header: status, failing dynamic index, event count, broken constraint count.
pub const HEADER: usize = 4;

/// `step`'s status: ok, or a nonfinite speed found by the cap (as world.ts's `capSpeeds` threw).
pub const STEP_NONFINITE_SPEED: u32 = 1;
pub const STEP_NONFINITE_ANGULAR: u32 = 2;

/// Body kinds, as world.ts encodes them.
pub const KIND_STATIC: u32 = 0;
pub const KIND_ACTOR: u32 = 1;
pub const KIND_PROP: u32 = 2;
/// The loot collision group's membership bit (world.ts's `LOOT_GROUP`): a prop in it is loot.
pub const LOOT_GROUP: u32 = 0x0008;
/// Values per row of `apply_floor_drag`'s output: `slot, changed, linear, angular`, where
/// `changed` has bit 1 for linear and bit 2 for angular.
pub const DRAG_STRIDE: usize = 4;
/// Shapes, as world.ts encodes them.
pub const SHAPE_CIRCLE: u32 = 0;
pub const SHAPE_BOX: u32 = 1;

#[derive(Clone, Copy)]
struct Slot {
    body: RigidBodyHandle,
    collider: ColliderHandle,
    map_geometry: bool,
    /// Which damping profile floor drag applies to the body.
    drag: floor_drag::Class,
    /// The damping last set, `[linear, angular]`, unset read as 0 as world.ts's spec did.
    damping: [f64; 2],
}

type Event = (ColliderHandle, ColliderHandle, bool);

/// Collision events in the order Rapier reports them, as rapier.js's event queue kept them.
#[derive(Default)]
struct Events(Mutex<Vec<Event>>);

impl Events {
    fn take(&self) -> Vec<Event> {
        std::mem::take(&mut *self.0.lock().expect("one thread"))
    }
}

impl EventHandler for Events {
    fn handle_collision_event(
        &self,
        _bodies: &RigidBodySet,
        _colliders: &ColliderSet,
        event: CollisionEvent,
        _pair: Option<&ContactPair>,
    ) {
        self.0.lock().expect("one thread").push((
            event.collider1(),
            event.collider2(),
            event.started(),
        ));
    }

    fn handle_contact_force_event(
        &self,
        _dt: Real,
        _bodies: &RigidBodySet,
        _colliders: &ColliderSet,
        _pair: &ContactPair,
        _total_force_magnitude: Real,
    ) {
        // No collider asks for contact force events; one would still be counted by `prepare`.
        self.0.lock().expect("one thread").push((
            ColliderHandle::invalid(),
            ColliderHandle::invalid(),
            false,
        ));
    }

    fn handle_soft_body_tear_event(&self, _soft_bodies: &SoftBodySet, _event: &SoftBodyTearEvent) {}
}

/// One room's physics: Rapier's sets plus the slot table `world.rs` addresses them by.
pub struct World {
    parameters: IntegrationParameters,
    pipeline: PhysicsPipeline,
    islands: IslandManager,
    broad_phase: DefaultBroadPhase,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    joints: ImpulseJointSet,
    multibody: MultibodyJointSet,
    soft: SoftBodySet,
    ccd: CCDSolver,
    events: Events,
    /// The one fixed body every map-geometry collider hangs off, made with the first.
    geometry: Option<RigidBodyHandle>,
    slots: Vec<Option<Slot>>,
    free_slots: Vec<u32>,
    ropes: Vec<Option<ImpulseJointHandle>>,
    free_ropes: Vec<u32>,
    /// The floors and damping profiles floor drag reads, once world.ts has sent them.
    floor: Option<Floor>,
    /// The live slots floor drag applies to, in slot order: at most the dynamic bodies, never the
    /// map's thousands of colliders.
    dragged: Vec<u32>,
    /// The input: rows JavaScript writes through `input`, or a step's, written by `world.rs`.
    input: Vec<f64>,
    /// The last result: a step's, a pose's or the debug contacts'.
    output: Vec<f64>,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

/// World units to Rapier's metres, rounded once to `f32` as rapier.js's arguments were.
fn metres(value: f64) -> Real {
    (value / SCALE) as Real
}

fn vector(x: f64, y: f64) -> Vector {
    Vector::new(metres(x), metres(y))
}

/// Whether a body of this shape can be added: a hull needs a non-degenerate point set.
pub(crate) fn shape_valid(kind: u32, a: f64, b: f64, vertices: &[f64]) -> bool {
    // The hull routine asserts on fewer than two points, and a hull needs three to enclose area.
    let hull = kind != SHAPE_CIRCLE && kind != SHAPE_BOX;
    if (hull && vertices.len() < 6) || a < 0.0 || b < 0.0 {
        return false;
    }
    shape(kind, a, b, vertices).is_some()
}

fn shape(kind: u32, a: f64, b: f64, vertices: &[f64]) -> Option<ColliderBuilder> {
    match kind {
        SHAPE_CIRCLE => Some(ColliderBuilder::ball(metres(a))),
        SHAPE_BOX => Some(ColliderBuilder::cuboid(metres(a), metres(b))),
        _ => {
            let points: Vec<Vector> = vertices
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| vector(p[0], p[1]))
                .collect();
            ColliderBuilder::convex_hull(&points)
        }
    }
}

/// An anchor's position and velocity in world units: `x, y, vx, vy`.
type Anchor = (f64, f64, f64, f64);

/// `constraintForce` (`shared/physics/constraints.ts`) for one constraint row of the step's input:
/// the bounded force on the first body, in world units, and the distance between the anchors.
fn constraint_force(row: &[f64], a: Anchor, b: Anchor) -> (f64, f64, f64) {
    let (rope, max_distance, rest_length, stiffness, damping, max_force) =
        (row[2] == 1.0, row[3], row[4], row[5], row[6], row[7]);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let distance = math::hypot(dx, dy);
    if distance == 0.0 {
        return (0.0, 0.0, distance);
    }
    let (nx, ny) = (dx / distance, dy / distance);
    let length = if rope { max_distance } else { rest_length };
    let stretch = distance - length;
    if rope && stretch <= 0.0 {
        return (0.0, 0.0, distance);
    }
    let relative_speed = (b.2 - a.2) * nx + (b.3 - a.3) * ny;
    let raw = stiffness * stretch + damping * relative_speed;
    let magnitude = if rope {
        0f64.max(max_force.min(raw))
    } else {
        (-max_force).max(max_force.min(raw))
    };
    (nx * magnitude, ny * magnitude, distance)
}

/// What `add_body` needs beyond the shape, in world units: pose, velocity, material, damping
/// (`NaN` for unset) and the packed collision groups (membership << 16 | filter).
#[derive(Clone)]
pub struct BodyParams {
    pub kind: u32,
    pub map_geometry: bool,
    pub pose: [f64; 6],
    pub material: [f64; 3],
    /// `[linear, angular]`; none leaves Rapier's default.
    pub damping: [Option<f64>; 2],
    pub groups: u32,
}

impl World {
    pub fn new() -> Self {
        let mut parameters = IntegrationParameters {
            dt: DT as Real,
            length_unit: 1.0,
            normalized_allowed_linear_error: 0.0001,
            normalized_prediction_distance: 0.6,
            max_ccd_substeps: 4,
            ..IntegrationParameters::default()
        };
        parameters.num_solver_iterations = 8;
        parameters.num_internal_pgs_iterations = 2;
        Self {
            parameters,
            pipeline: PhysicsPipeline::new(),
            islands: IslandManager::new(),
            broad_phase: DefaultBroadPhase::default(),
            narrow_phase: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            joints: ImpulseJointSet::new(),
            multibody: MultibodyJointSet::new(),
            soft: SoftBodySet::new(),
            ccd: CCDSolver::new(),
            events: Events::default(),
            geometry: None,
            slots: Vec::new(),
            free_slots: Vec::new(),
            ropes: Vec::new(),
            free_ropes: Vec::new(),
            floor: None,
            dragged: Vec::new(),
            input: Vec::new(),
            output: Vec::new(),
        }
    }

    fn slot(&self, slot: u32) -> Slot {
        self.slots[slot as usize].expect("a live physics slot")
    }

    fn body_mut(&mut self, slot: u32) -> &mut RigidBody {
        let handle = self.slot(slot).body;
        &mut self.bodies[handle]
    }

    /// Adds a body and its collider, as world.ts's `add` did through rapier.js; returns its slot,
    /// or `None` for a convex shape Rapier cannot hull. `a` is a circle's radius or a box's half
    /// width, `b` a box's half height; `vertices` a convex shape's `x, y` pairs.
    pub fn add_body(
        &mut self,
        params: &BodyParams,
        shape_kind: u32,
        a: f64,
        b: f64,
        vertices: &[f64],
    ) -> Option<u32> {
        let [x, y, angle, vx, vy, omega] = params.pose;
        let [mass, friction, restitution] = params.material;
        let mut collider = shape(shape_kind, a, b, vertices)?;
        let body = if params.map_geometry {
            *self
                .geometry
                .get_or_insert_with(|| self.bodies.insert(RigidBodyBuilder::fixed()))
        } else {
            let builder = if params.kind == KIND_STATIC {
                RigidBodyBuilder::fixed()
            } else {
                RigidBodyBuilder::dynamic()
            };
            let mut builder = builder
                .translation(vector(x, y))
                .rotation(angle as Real)
                .linvel(vector(vx, vy))
                .angvel(omega as Real);
            if let Some(linear) = params.damping[0] {
                builder = builder.linear_damping(linear as Real);
            }
            if let Some(angular) = params.damping[1] {
                builder = builder.angular_damping(angular as Real);
            }
            if params.kind != KIND_STATIC {
                builder = builder.ccd_enabled(true);
            }
            if params.kind == KIND_ACTOR {
                builder = builder.lock_rotations();
            }
            self.bodies.insert(builder)
        };
        if params.map_geometry {
            collider = collider.translation(vector(x, y)).rotation(angle as Real);
        }
        let slot = self.free_slots.pop().unwrap_or(self.slots.len() as u32);
        let collider = collider
            .mass(mass as Real)
            .friction(friction as Real)
            .restitution(restitution as Real)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            .collision_groups(InteractionGroups::new(
                Group::from_bits_retain(params.groups >> 16),
                Group::from_bits_retain(params.groups & 0xffff),
                InteractionTestMode::And,
            ))
            .user_data(u128::from(slot));
        let collider = self
            .colliders
            .insert_with_parent(collider, body, &mut self.bodies);
        let drag = if params.kind != KIND_PROP {
            floor_drag::Class::None
        } else if params.groups >> 16 == LOOT_GROUP {
            floor_drag::Class::Loot
        } else {
            floor_drag::Class::Prop
        };
        let entry = Some(Slot {
            body,
            collider,
            map_geometry: params.map_geometry,
            drag,
            damping: params.damping.map(|value| value.unwrap_or(0.0)),
        });
        if slot as usize == self.slots.len() {
            self.slots.push(entry);
        } else {
            self.slots[slot as usize] = entry;
        }
        if drag != floor_drag::Class::None {
            let at = self.dragged.partition_point(|&other| other < slot);
            self.dragged.insert(at, slot);
        }
        Some(slot)
    }

    /// Removes a body: a map-geometry collider alone, without waking anything, or a body with its
    /// collider and joints.
    pub fn remove_body(&mut self, slot: u32) {
        let entry = self.slot(slot);
        if entry.map_geometry {
            self.colliders.remove(
                entry.collider,
                &mut self.islands,
                &mut self.bodies,
                &mut self.soft,
                false,
            );
        } else {
            self.bodies.remove(
                entry.body,
                &mut self.islands,
                &mut self.colliders,
                &mut self.joints,
                &mut self.multibody,
                &mut self.soft,
                true,
            );
        }
        self.slots[slot as usize] = None;
        self.free_slots.push(slot);
        self.dragged.retain(|&other| other != slot);
    }

    pub fn wake(&mut self, slot: u32) {
        self.body_mut(slot).wake_up(true);
    }

    /// A native centre rope between two bodies (world.ts's legacy constraint); returns its index.
    pub fn add_rope(&mut self, a: u32, b: u32, max_distance: f64) -> u32 {
        let joint = RopeJointBuilder::new(metres(max_distance))
            .local_anchor1(Vector::ZERO)
            .local_anchor2(Vector::ZERO);
        let handle = self
            .joints
            .insert(self.slot(a).body, self.slot(b).body, joint, true);
        let index = self.free_ropes.pop().unwrap_or(self.ropes.len() as u32);
        if index as usize == self.ropes.len() {
            self.ropes.push(Some(handle));
        } else {
            self.ropes[index as usize] = Some(handle);
        }
        index
    }

    /// Removes a rope, waking its bodies. A rope whose body was removed is already gone.
    pub fn remove_rope(&mut self, index: u32) {
        if let Some(handle) = self.ropes[index as usize].take() {
            self.joints.remove(handle, true);
        }
        self.free_ropes.push(index);
    }

    pub fn set_damping(&mut self, slot: u32, angular: bool, value: f64) {
        if let Some(entry) = self.slots[slot as usize].as_mut() {
            entry.damping[usize::from(angular)] = value;
        }
        let body = self.body_mut(slot);
        if angular {
            body.set_angular_damping(value as Real);
        } else {
            body.set_linear_damping(value as Real);
        }
    }

    /// Takes the floors and damping profiles from the input buffer (`Floor::from_input`'s layout).
    pub fn set_floor(&mut self) {
        self.use_floor(Floor::from_input(&self.input));
    }

    pub(crate) fn use_floor(&mut self, floor: Floor) {
        self.floor = Some(floor);
    }

    /// Floor drag over every dynamic prop, before the solve (`floor_drag`). A damping is set only
    /// when it changes, which never wakes a sleeper. Returns the changes as `DRAG_STRIDE` rows in
    /// slot order, for `world.rs` to name; nothing when no floor was sent.
    pub fn apply_floor_drag(&mut self) -> &[f64] {
        let mut output = std::mem::take(&mut self.output);
        output.clear();
        if let Some(floor) = &self.floor {
            for &slot in &self.dragged {
                let Some(entry) = self.slots[slot as usize].as_mut() else {
                    continue;
                };
                let p = self.bodies[entry.body].translation();
                let (x, y) = (f64::from(p.x) * SCALE, f64::from(p.y) * SCALE);
                let Some(next) = floor.damping(entry.drag, x, y) else {
                    continue;
                };
                let body = &mut self.bodies[entry.body];
                let mut changed = 0u8;
                if entry.damping[0] != next[0] {
                    body.set_linear_damping(next[0] as Real);
                    changed |= 1;
                }
                if entry.damping[1] != next[1] {
                    body.set_angular_damping(next[1] as Real);
                    changed |= 2;
                }
                if changed != 0 {
                    entry.damping = next;
                    output.extend_from_slice(&[
                        f64::from(slot),
                        f64::from(changed),
                        next[0],
                        next[1],
                    ]);
                }
            }
        }
        self.output = output;
        &self.output
    }

    /// An explicit teleport: the pose, at rest, awake.
    pub fn set_pose(&mut self, slot: u32, x: f64, y: f64, angle: f64) {
        let body = self.body_mut(slot);
        body.set_translation(vector(x, y), true);
        body.set_rotation(Rotation::new(angle as Real), true);
        body.set_linvel(Vector::ZERO, true);
        body.set_angvel(0.0, true);
    }

    /// `x, y, angle, vx, vy, omega, sleeping` in world units, in the output.
    pub fn pose(&mut self, slot: u32) -> &[f64] {
        let entry = self.slot(slot);
        let body = &self.bodies[entry.body];
        let sleeping = f64::from(u8::from(body.is_sleeping()));
        let values = if entry.map_geometry {
            let collider = &self.colliders[entry.collider];
            let p = collider.translation();
            [
                f64::from(p.x) * SCALE,
                f64::from(p.y) * SCALE,
                f64::from(collider.rotation().angle()),
                0.0,
                0.0,
                0.0,
                sleeping,
            ]
        } else {
            let (p, v) = (body.translation(), body.linvel());
            [
                f64::from(p.x) * SCALE,
                f64::from(p.y) * SCALE,
                f64::from(body.rotation().angle()),
                f64::from(v.x) * SCALE,
                f64::from(v.y) * SCALE,
                f64::from(body.angvel()),
                sleeping,
            ]
        };
        self.output.clear();
        self.output.extend_from_slice(&values);
        &self.output
    }

    /// Sets a body's linear velocity directly, for tests that need a speed no spec admits.
    #[cfg(test)]
    pub fn set_velocity_for_test(&mut self, slot: u32, vx: f64) {
        self.body_mut(slot)
            .set_linvel(Vector::new(vx as Real, 0.0), true);
    }

    /// The body's position and its external force accumulator, in world units.
    pub fn user_force(&mut self, slot: u32) -> &[f64] {
        let body = &self.bodies[self.slot(slot).body];
        let (p, f) = (body.translation(), body.user_force());
        let values = [
            f64::from(p.x) * SCALE,
            f64::from(p.y) * SCALE,
            f64::from(f.x) * SCALE,
            f64::from(f.y) * SCALE,
        ];
        self.output.clear();
        self.output.extend_from_slice(&values);
        &self.output
    }

    /// Moves colliders to their bodies' current poses, before shape queries.
    pub fn propagate(&mut self) {
        self.bodies
            .propagate_modified_body_positions_to_colliders(&mut self.colliders);
    }

    /// Whether the slot's collider meets a ball (`shape_kind` circle, radius `a`) or an axis-aligned
    /// box (half-extents `a`, `b`) centred at `(x, y)`, all in world units.
    pub fn intersects(&self, slot: u32, shape_kind: u32, a: f64, b: f64, x: f64, y: f64) -> bool {
        let collider = &self.colliders[self.slot(slot).collider];
        let at = Pose::from_translation(vector(x, y));
        let hit = if shape_kind == SHAPE_CIRCLE {
            query::intersection_test(
                collider.position(),
                collider.shape(),
                &at,
                &Ball::new(metres(a)),
            )
        } else {
            query::intersection_test(
                collider.position(),
                collider.shape(),
                &at,
                &Cuboid::new(vector(a, b)),
            )
        };
        hit.is_ok_and(|hit| hit.intersecting)
    }

    fn native_step(&mut self) {
        self.pipeline.step(
            Vector::ZERO,
            &self.parameters,
            &mut self.islands,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.joints,
            &mut self.multibody,
            &mut self.soft,
            &mut self.ccd,
            &(),
            &self.events,
        );
    }

    /// One native step over a world of static bodies only, to build the broad phase; returns the
    /// events it produced, which world.ts refuses.
    pub fn prepare(&mut self) -> usize {
        self.native_step();
        self.events.take().len()
    }

    /// Resizes the input buffer to `len` values and returns it, for world.ts to fill.
    pub fn input(&mut self, len: usize) -> &mut [f64] {
        self.input.clear();
        self.input.resize(len, 0.0);
        &mut self.input
    }

    /// The input as JavaScript last filled it.
    pub fn input_values(&self) -> &[f64] {
        &self.input
    }

    /// The input buffer itself, for `world.rs` to fill a step's rows.
    pub fn input_vec(&mut self) -> &mut Vec<f64> {
        &mut self.input
    }

    /// The damping last set, `[linear, angular]`, unset read as 0.
    pub fn damping(&self, slot: u32) -> [f64; 2] {
        self.slot(slot).damping
    }

    fn cap_speeds(&mut self, dynamics: &[f64]) -> Result<(), (u32, usize)> {
        for (index, entry) in dynamics.as_chunks::<DYNAMIC_STRIDE>().0.iter().enumerate() {
            let (limit, tip) = (entry[5], entry[6]);
            let body = self.body_mut(entry[0] as u32);
            let v = body.linvel();
            let (vx, vy) = (f64::from(v.x), f64::from(v.y));
            let speed = math::hypot(vx, vy) * SCALE;
            if !speed.is_finite() {
                return Err((STEP_NONFINITE_SPEED, index));
            }
            let omega = f64::from(body.angvel());
            if !omega.is_finite() {
                return Err((STEP_NONFINITE_ANGULAR, index));
            }
            let angular_speed = omega.abs() * tip;
            if angular_speed > limit {
                body.set_angvel((omega * limit / angular_speed) as Real, true);
            }
            let budget = 0f64.max(limit - limit.min(angular_speed));
            if speed > budget {
                body.set_linvel(
                    Vector::new((vx * budget / speed) as Real, (vy * budget / speed) as Real),
                    true,
                );
            }
        }
        Ok(())
    }

    /// A body's anchor in world units and its velocity there, as world.ts's `at` and `velocity`.
    fn anchor(&self, slot: u32, lx: f64, ly: f64) -> Anchor {
        let body = &self.bodies[self.slot(slot).body];
        let angle = f64::from(body.rotation().angle());
        let (c, s, p) = (math::cos(angle), math::sin(angle), body.translation());
        let x = f64::from(p.x) * SCALE + lx * c - ly * s;
        let y = f64::from(p.y) * SCALE + lx * s + ly * c;
        let v = body.velocity_at_point(vector(x, y));
        (x, y, f64::from(v.x) * SCALE, f64::from(v.y) * SCALE)
    }

    fn bounded_constraints(&mut self, constraints: &[f64], broken: &mut [bool]) {
        for (index, row) in constraints
            .as_chunks::<CONSTRAINT_STRIDE>()
            .0
            .iter()
            .enumerate()
        {
            if broken[index] {
                continue;
            }
            let (a, b) = (row[0] as u32, row[1] as u32);
            let pa = self.anchor(a, row[9], row[10]);
            let pb = self.anchor(b, row[11], row[12]);
            let (fx, fy, distance) = constraint_force(row, pa, pb);
            if !row[8].is_nan() && distance > row[8] {
                broken[index] = true;
                self.wake(a);
                self.wake(b);
                continue;
            }
            let (fx, fy) = (fx / SCALE, fy / SCALE);
            if fx == 0.0 && fy == 0.0 {
                continue;
            }
            let force = Vector::new(fx as Real, fy as Real);
            let at_a = Vector::new((pa.0 / SCALE) as Real, (pa.1 / SCALE) as Real);
            let at_b = Vector::new((pb.0 / SCALE) as Real, (pb.1 / SCALE) as Real);
            self.body_mut(a).add_force_at_point(force, at_a, true);
            self.body_mut(b).add_force_at_point(
                Vector::new((-fx) as Real, (-fy) as Real),
                at_b,
                true,
            );
        }
    }

    fn push_positions(&self, dynamics: &[f64], output: &mut Vec<f64>) {
        for entry in dynamics.as_chunks::<DYNAMIC_STRIDE>().0 {
            let p = self.bodies[self.slot(entry[0] as u32).body].translation();
            output.push(f64::from(p.x) * SCALE);
            output.push(f64::from(p.y) * SCALE);
        }
    }

    fn motors(&mut self, dynamics: &[f64]) {
        for entry in dynamics.as_chunks::<DYNAMIC_STRIDE>().0 {
            let body = self.body_mut(entry[0] as u32);
            body.reset_forces(false);
            if entry[1] != 0.0 {
                let (mx, my, accel) = (entry[2], entry[3], entry[4]);
                let v = body.linvel();
                let (vx, vy) = (f64::from(v.x), f64::from(v.y));
                let (dx, dy) = (mx - vx * SCALE, my - vy * SCALE);
                let magnitude = math::hypot(dx, dy);
                let fraction = if magnitude != 0.0 {
                    1f64.min(accel * DT / magnitude)
                } else {
                    0.0
                };
                body.set_linvel(
                    Vector::new(
                        (vx + dx * fraction / SCALE) as Real,
                        (vy + dy * fraction / SCALE) as Real,
                    ),
                    true,
                );
            }
        }
    }

    /// One game tick: `SUBSTEPS` native steps with the input's motors, forces, impulses and
    /// bounded constraints. The input holds, in order: `dynamic_count` rows of `slot, has motor,
    /// motor x, motor y, accel, speed limit, tip radius`; `force_count` and `impulse_count` rows of
    /// `slot, x, y`; `constraint_count` rows of `slot a, slot b, rope, max distance, rest length,
    /// stiffness, damping, max force, break distance (NaN for none), anchor a x, y, anchor b x, y`.
    ///
    /// Returns the output: the header, each dynamic body's position before the first substep and
    /// after each one, then the events (`substep, slot a, slot b, started`), then the indices of the
    /// constraints that broke. A nonfinite speed stops the step, as world.ts's throw did.
    pub fn step(
        &mut self,
        dynamic_count: usize,
        force_count: usize,
        impulse_count: usize,
        constraint_count: usize,
    ) -> &[f64] {
        let input = std::mem::take(&mut self.input);
        let (dynamics, rest) = input.split_at(dynamic_count * DYNAMIC_STRIDE);
        let (forces, rest) = rest.split_at(force_count * PUSH_STRIDE);
        let (impulses, rest) = rest.split_at(impulse_count * PUSH_STRIDE);
        let constraints = &rest[..constraint_count * CONSTRAINT_STRIDE];
        let mut broken = vec![false; constraint_count];
        let mut output = std::mem::take(&mut self.output);
        output.clear();
        output.resize(HEADER, 0.0);
        let mut events = Vec::new();
        self.push_positions(dynamics, &mut output);
        let mut status = Ok(());
        for substep in 0..SUBSTEPS {
            self.motors(dynamics);
            for entry in forces.as_chunks::<PUSH_STRIDE>().0 {
                self.body_mut(entry[0] as u32)
                    .add_force(vector(entry[1], entry[2]), true);
            }
            if substep == 0 {
                for entry in impulses.as_chunks::<PUSH_STRIDE>().0 {
                    self.body_mut(entry[0] as u32)
                        .apply_impulse(vector(entry[1], entry[2]), true);
                }
            }
            self.bounded_constraints(constraints, &mut broken);
            status = self.cap_speeds(dynamics);
            if status.is_ok() {
                self.native_step();
                status = self.cap_speeds(dynamics);
            }
            if status.is_err() {
                break;
            }
            for (first, second, started) in self.events.take() {
                let slot = |handle| self.colliders.get(handle).map(|c| c.user_data as u32);
                if let (Some(a), Some(b)) = (slot(first), slot(second)) {
                    events.extend_from_slice(&[
                        substep as f64,
                        f64::from(a),
                        f64::from(b),
                        f64::from(u8::from(started)),
                    ]);
                }
            }
            self.push_positions(dynamics, &mut output);
        }
        if let Err((code, index)) = status {
            output[0] = f64::from(code);
            output[1] = index as f64;
        }
        output[2] = (events.len() / EVENT_STRIDE) as f64;
        output.extend_from_slice(&events);
        let broken: Vec<f64> = broken
            .iter()
            .enumerate()
            .filter(|(_, b)| **b)
            .map(|(i, _)| i as f64)
            .collect();
        output[3] = broken.len() as f64;
        output.extend_from_slice(&broken);
        self.input = input;
        self.output = output;
        &self.output
    }

    /// Every touching pair's manifold points: `slot 1, slot 2, x, y, nx, ny, distance`, the normal
    /// pointing from the first collider to the second, in world units. `world.rs` names, orders and caps them.
    pub fn debug_contacts(&mut self) -> &[f64] {
        self.output.clear();
        for pair in self.narrow_phase.contact_pairs() {
            let (Some(first), Some(second)) = (
                self.colliders.get(pair.collider1),
                self.colliders.get(pair.collider2),
            ) else {
                continue;
            };
            let (a, b) = (first.user_data as u32, second.user_data as u32);
            for manifold in pair.manifolds() {
                let normal = manifold.data.normal;
                for point in &manifold.points {
                    let p = first.position() * point.local_p1;
                    self.output.extend_from_slice(&[
                        f64::from(a),
                        f64::from(b),
                        f64::from(p.x) * SCALE,
                        f64::from(p.y) * SCALE,
                        f64::from(normal.x),
                        f64::from(normal.y),
                        f64::from(point.dist) * SCALE,
                    ]);
                }
            }
        }
        &self.output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prop(world: &mut World, x: f64, vx: f64) -> u32 {
        let params = BodyParams {
            kind: 2,
            map_geometry: false,
            pose: [x, 0.0, 0.0, vx, 0.0, 0.0],
            material: [1.0, 0.5, 0.0],
            damping: [None; 2],
            groups: (0x0004 << 16) | 0x0007,
        };
        world
            .add_body(&params, SHAPE_CIRCLE, 12.0, 0.0, &[])
            .expect("a ball")
    }

    fn run() -> Vec<u64> {
        let mut world = World::new();
        let (a, b) = (
            prop(&mut world, -40.0, 400.0),
            prop(&mut world, 40.0, -400.0),
        );
        let mut all = Vec::new();
        for _ in 0..30 {
            let input = world.input(2 * DYNAMIC_STRIDE);
            for (i, slot) in [a, b].into_iter().enumerate() {
                input[i * DYNAMIC_STRIDE..(i + 1) * DYNAMIC_STRIDE].copy_from_slice(&[
                    f64::from(slot),
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    768.0,
                    0.0,
                ]);
            }
            all.extend(world.step(2, 0, 0, 0).iter().map(|v| v.to_bits()));
        }
        all
    }

    #[test]
    fn two_props_meet_report_contacts_and_repeat_exactly() {
        let first = run();
        assert!(first.iter().all(|v| f64::from_bits(*v).is_finite()));
        assert_eq!(first, run());
    }

    #[test]
    fn a_bounded_spring_pulls_and_a_slack_rope_does_not() {
        let at = |x| (x, 0.0, 0.0, 0.0);
        let spring = [0.0, 1.0, 0.0, 10.0, 10.0, 2000.0, 60.0, 500.0];
        assert_eq!(
            constraint_force(&spring, at(0.0), at(30.0)),
            (500.0, 0.0, 30.0)
        );
        let rope = [0.0, 1.0, 1.0, 40.0, 0.0, 2000.0, 60.0, 500.0];
        assert_eq!(constraint_force(&rope, at(0.0), at(30.0)), (0.0, 0.0, 30.0));
    }

    #[test]
    fn an_impossible_hull_is_refused() {
        let mut world = World::new();
        let params = BodyParams {
            kind: 2,
            map_geometry: false,
            pose: [0.0; 6],
            material: [1.0, 0.5, 0.0],
            damping: [None; 2],
            groups: 0,
        };
        assert!(
            world
                .add_body(&params, 2, 0.0, 0.0, &[0.0, 0.0, 1.0, 0.0, 2.0, 0.0])
                .is_none()
        );
    }
}
