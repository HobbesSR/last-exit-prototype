//! The physics world's bookkeeping (#1232, docs/27 "The state flip", step 5b): what
//! `shared/physics/world.ts` kept beside the engine until now. It holds the body records, their
//! generations, the mutation queues and their commit order, the constraints, the contacts, and
//! every ordering by ID. The engine (`physics.rs`) is Rapier and its slot table. This module
//! calls the engine in the order world.ts called it, so Rapier allocates handles and slots as
//! before and a world built by the same calls steps the same way.
//!
//! JavaScript keeps:
//! - **spec validation**, whose errors it throws;
//! - **an intern table** from ID strings to keys. Each ID crosses once, as UTF-16 code units, so
//!   the core orders IDs exactly as JavaScript's `<` does;
//! - **the frozen spec, motor and lifetime objects** that snapshots share (#655). It updates them
//!   from the facts a commit reports.
//!
//! Refusals come back as negative codes (`E_*`). JavaScript throws the message the old code threw,
//! and the checks run in the old order: JavaScript validates values and refuses an unknown dynamic
//! body from its records before it calls, as world.ts did, and the world still checks.

use crate::physics::{self, BodyParams, HEADER, SUBSTEPS};
use std::cmp::Ordering;

/// An interned ID.
pub type Key = u32;

pub const MAX_DYNAMIC: usize = 128;
pub const MAX_ACTORS: usize = 27;
pub const MAX_STATIC: usize = 100_000;
pub const MAX_PENDING: usize = 1024;
pub const MAX_EVENTS: usize = 8192;
pub const MAX_CONSTRAINTS: usize = 8;

/// Refusals, as world.ts's messages (JavaScript holds the text).
pub const E_QUEUE_FULL: i32 = -1;
pub const E_DUPLICATE_BODY: i32 = -2;
pub const E_BODY_CAPACITY: i32 = -3;
pub const E_UNKNOWN_BODY: i32 = -4;
pub const E_DUPLICATE_REMOVAL: i32 = -5;
pub const E_DUPLICATE_CONSTRAINT: i32 = -6;
pub const E_CONSTRAINT_CAPACITY: i32 = -7;
/// `E_UNKNOWN_ENDPOINT - i` and `E_GEOMETRY_ENDPOINT - i` name endpoint `i` (0 for `a`, 1 for `b`).
pub const E_UNKNOWN_ENDPOINT: i32 = -8;
pub const E_GEOMETRY_ENDPOINT: i32 = -10;
pub const E_UNKNOWN_CONSTRAINT: i32 = -12;
pub const E_DUPLICATE_CONSTRAINT_REMOVAL: i32 = -13;
pub const E_UNKNOWN_DYNAMIC: i32 = -14;
pub const E_INVALID_CONVEX: i32 = -15;
pub const E_NOT_STATIC: i32 = -16;

/// Values in a queued body's input row before its vertices (`queue_add_body`).
pub const BODY_ROW: usize = 22;
/// Values in a queued constraint's input row (`queue_add_constraint`).
pub const CONSTRAINT_ROW: usize = 14;
/// Values per row of `snapshot`'s output: key, generation, then the pose (`physics::World::pose`).
pub const SNAPSHOT_STRIDE: usize = 9;
/// Values per row of `drain_contacts`'s output: substep, key a, key b, started.
pub const CONTACT_STRIDE: usize = 4;
/// Values per row of `debug_contacts`'s output: key a, key b, x, y, nx, ny, distance.
pub const DEBUG_CONTACT_STRIDE: usize = 7;
/// Values per row of `debug_forces`'s output: key, x, y, fx, fy.
pub const FORCE_STRIDE: usize = 5;
/// The step's output header: status, the failing body's key, the dynamic count, contacts dropped.
pub const STEP_HEADER: usize = 4;
/// A commit's facts, as `kind, key` pairs.
pub const FACT_REMOVED: f64 = 0.0;
pub const FACT_ADDED: f64 = 1.0;
pub const FACT_CONSTRAINT_ADDED: f64 = 2.0;

#[derive(Clone, Copy)]
struct Body {
    slot: u32,
    generation: u64,
    kind: u32,
    map_geometry: bool,
    loot: bool,
    /// The speed cap: the spec's `maxSpeed`, bounded by the shape's (`physicsSpeedLimit`).
    limit: f64,
    /// The shape's farthest point from its centre.
    tip: f64,
    motor: Option<[f64; 3]>,
}

struct Pending {
    key: Key,
    params: BodyParams,
    shape: u32,
    a: f64,
    b: f64,
    vertices: Vec<f64>,
    loot: bool,
    limit: f64,
    tip: f64,
}

/// A queued body from its row (`World::queue_add_body`'s layout).
fn pending_from(row: &[f64]) -> Pending {
    let v = |i: usize| row[i];
    let count = v(21) as usize;
    Pending {
        key: v(0) as Key,
        params: BodyParams {
            kind: v(1) as u32,
            map_geometry: v(2) != 0.0,
            pose: [v(6), v(7), v(8), v(9), v(10), v(11)],
            material: [v(12), v(13), v(14)],
            damping: [v(15), v(16)],
            groups: v(17) as u32,
        },
        shape: v(3) as u32,
        a: v(4),
        b: v(5),
        loot: v(18) != 0.0,
        limit: v(19),
        tip: v(20),
        vertices: row[BODY_ROW..BODY_ROW + 2 * count].to_vec(),
    }
}

#[derive(Clone, Copy)]
struct Constraint {
    key: Key,
    a: Key,
    b: Key,
    /// No kind: a native rope (`legacy`), with its rope index once committed.
    legacy: bool,
    rope: Option<u32>,
    /// `rope, max distance, rest length, stiffness, damping, max force, break distance (NaN for
    /// none), anchor a x, y, anchor b x, y`: the step's row after the two slots.
    row: [f64; 11],
}

/// Every one of world.ts's records and queues, around the engine.
pub struct World {
    engine: physics::World,
    ids: Vec<Vec<u16>>,
    /// By key: the live body.
    bodies: Vec<Option<Body>>,
    /// By slot: the live body's key.
    slot_keys: Vec<Option<Key>>,
    /// The live dynamic bodies, in ID order.
    dynamic: Vec<Key>,
    actor_count: usize,
    dynamic_count: usize,
    static_count: usize,
    next_generation: u64,
    /// The live constraints, in insertion order, as world.ts's `Map` kept them.
    constraints: Vec<Constraint>,
    pending_add: Vec<Pending>,
    pending_remove: Vec<Key>,
    pending_add_constraints: Vec<Constraint>,
    pending_remove_constraints: Vec<Key>,
    forces: Vec<(Key, f64, f64)>,
    impulses: Vec<(Key, f64, f64)>,
    /// Retained contacts: substep, key a, key b (a before b by ID), started.
    contacts: Vec<[f64; 4]>,
    pub(crate) output: Vec<f64>,
    /// The boundary's own buffers (`boundary.rs`), apart from the rows and facts above, which its
    /// calls into this world reuse.
    pub(crate) boundary_input: Vec<f64>,
    pub(crate) boundary_output: Vec<f64>,
    pub(crate) actions: crate::phase_three::PhaseThree,
    pub(crate) combat: crate::combat::Combat,
    pub(crate) interactions: crate::phase_six::PhaseSix,
    pub(crate) hazards: crate::hazards::Hazards,
    pub(crate) players: crate::players::Players,
    pub(crate) ground: crate::ground::Ground,
    /// The gates' bodies as the body sync keeps them (#1214 stage 6d.2).
    pub(crate) gate_bodies: GateBodies,
    /// The ground records awaiting a body, by key in ID order (#1214 stage 6d.3): `unadmittedItems`' order.
    pub(crate) waiting: Vec<Key>,
    /// The items launched since the last admission, by key, with their motions: `itemLaunches` (6d.3).
    pub(crate) launches: Vec<(Key, f64, f64)>,
    /// The hooks, in ID order (#1214 stage 6d.4): JavaScript's `r.hooks` is their mirror.
    pub(crate) hooks: Vec<HookRecord>,
    /// The impulses awaiting phase 1's admission, in the order they were first queued: key, x, y and the body's
    /// generation when queued (#1214 stage 6d.5). JavaScript's `pendingImpulses` is their mirror.
    pub(crate) pending_impulses: Vec<(Key, f64, f64, f64)>,
    /// The attachments awaiting admission: id, a, b, max distance and the endpoints' generations (6d.5).
    pub(crate) pending_attachments: Vec<PendingAttachment>,
    /// The discontinuity markers' keys as the last body sync left them (6d.5), for a sync the core runs itself.
    pub(crate) markers: Vec<Key>,
    /// The sync's match-pinned settings (6d.6), once uploaded.
    pub(crate) sync_config: SyncConfig,
    /// How many actor bodies the last body sync left: the runtime's `actors.size` (6d.6b).
    pub(crate) sync_actors: usize,
    pub(crate) phase_seven: crate::phase_seven::PhaseSeven,
    /// By key: a solid prop's shape as its spec gave it (`shape, a, b, vertices`), for the swept
    /// queries' `solidProps` (`hooks.rs`). Loot and every other kind keep none.
    prop_shapes: Vec<Option<PropShape>>,
}

/// The gates' bodies as the body sync keeps them (#1214 stage 6d.2): each gate's key (`gate:<id>`) and closed body's row,
/// uploaded once per world, the legacy admission order (by ID), and what the world last saw of each gate (0 nothing yet,
/// 1 open, 2 closed), which JavaScript's runtime kept as `gates` until then.
#[derive(Default)]
pub(crate) struct GateBodies {
    pub(crate) keys: Vec<Key>,
    pub(crate) rows: Vec<Vec<f64>>,
    pub(crate) order: Vec<usize>,
    pub(crate) seen: Vec<u8>,
}

/// A hook as the world keeps it (#1214 stage 6d.4), the fields `HookState` holds that the rules read: its key
/// (`hook:<id>`), the caster's roster index, the tip and its heading, how far it has flown, when it started, its phase
/// (0 flying, 1 pending, 2 pulling), the caster body's generation, the target's roster index and its actor key when hit
/// (NaN none), the target body's generation, the hit's tick and the rope's desired length (NaN absent).
#[derive(Clone, Copy, Debug)]
pub(crate) struct HookRecord {
    pub(crate) key: Key,
    pub(crate) caster: f64,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) dx: f64,
    pub(crate) dy: f64,
    pub(crate) travelled: f64,
    pub(crate) started: f64,
    pub(crate) phase: f64,
    pub(crate) generation_a: f64,
    pub(crate) target: f64,
    pub(crate) target_key: f64,
    pub(crate) generation_b: f64,
    pub(crate) hit_tick: f64,
    pub(crate) desired: f64,
}

/// The sync's match-pinned settings (#1214 stage 6d.6), uploaded once per world (`World::configure_sync`): the
/// contestant's, gladiator's and loot's body rows (`boundary::TEMPLATE_*` order), the drop reserve, and the hook tuning
/// (`hooks::TUNING_WORDS`), so a sync the core runs needs none of them from its caller.
#[derive(Default)]
pub(crate) struct SyncConfig {
    pub(crate) templates: [Vec<f64>; 3],
    pub(crate) drop_reserve: usize,
    pub(crate) hook: Vec<f64>,
}

/// An attachment awaiting admission (`PendingAttachment` with its generations, #1214 stage 6d.5).
#[derive(Clone, Copy, Debug)]
pub(crate) struct PendingAttachment {
    pub(crate) key: Key,
    pub(crate) a: Key,
    pub(crate) b: Key,
    pub(crate) max_distance: f64,
    pub(crate) generation_a: f64,
    pub(crate) generation_b: f64,
}

/// `enqueuePhysicsImpulse`'s and `enqueuePhysicsAttachment`'s refusals, as the adapter throws them.
pub const E_UNKNOWN_IMPULSE_ACTOR: i32 = -40;
pub const E_IMPULSE_CAPACITY: i32 = -41;
pub const E_UNKNOWN_ATTACHMENT_ACTOR: i32 = -42;
pub const E_ATTACHMENT_CAPACITY: i32 = -43;
/// The pending queues' bounds (29.2, "Bounds").
const MAX_PENDING_IMPULSES: usize = 128;
const MAX_PENDING_ATTACHMENTS: usize = 8;

/// Words per hook uploaded (`HookRecord`, in its field order).
pub const HOOK_RECORD: usize = 15;

/// A solid prop's shape: `physics::SHAPE_*`, its `a`, `b` and convex vertices, as queued.
#[derive(Clone)]
pub(crate) struct PropShape {
    pub(crate) shape: u32,
    pub(crate) a: f64,
    pub(crate) b: f64,
    pub(crate) vertices: Vec<f64>,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    pub fn new() -> Self {
        Self {
            engine: physics::World::new(),
            ids: Vec::new(),
            bodies: Vec::new(),
            slot_keys: Vec::new(),
            dynamic: Vec::new(),
            actor_count: 0,
            dynamic_count: 0,
            static_count: 0,
            next_generation: 0,
            constraints: Vec::new(),
            pending_add: Vec::new(),
            pending_remove: Vec::new(),
            pending_add_constraints: Vec::new(),
            pending_remove_constraints: Vec::new(),
            forces: Vec::new(),
            impulses: Vec::new(),
            contacts: Vec::new(),
            output: Vec::new(),
            boundary_input: Vec::new(),
            boundary_output: Vec::new(),
            actions: crate::phase_three::PhaseThree::default(),
            combat: crate::combat::Combat::default(),
            interactions: crate::phase_six::PhaseSix::default(),
            hazards: crate::hazards::Hazards::default(),
            players: crate::players::Players::default(),
            ground: crate::ground::Ground::default(),
            gate_bodies: GateBodies::default(),
            waiting: Vec::new(),
            launches: Vec::new(),
            hooks: Vec::new(),
            pending_impulses: Vec::new(),
            pending_attachments: Vec::new(),
            markers: Vec::new(),
            sync_config: SyncConfig::default(),
            sync_actors: 0,
            phase_seven: crate::phase_seven::PhaseSeven::default(),
            prop_shapes: Vec::new(),
        }
    }

    /// The input buffer every call that takes rows reads, resized to `len` values.
    pub fn input(&mut self, len: usize) -> &mut [f64] {
        self.engine.input(len)
    }

    pub fn output(&self) -> &[f64] {
        &self.output
    }

    /// Whether the ID of `key` starts with `prefix`.
    pub(crate) fn id_starts_with(&self, key: Key, prefix: &str) -> bool {
        let prefix: Vec<u16> = prefix.encode_utf16().collect();
        self.ids
            .get(key as usize)
            .is_some_and(|id| id.starts_with(&prefix))
    }

    /// The keys of the live bodies whose IDs start with `prefix` (`actor:`, `item:`), in key order.
    pub(crate) fn keys_with_prefix(&self, prefix: &str) -> Vec<Key> {
        let prefix: Vec<u16> = prefix.encode_utf16().collect();
        (0..self.bodies.len())
            .filter(|&k| self.bodies[k].is_some() && self.ids[k].starts_with(&prefix))
            .map(|k| k as Key)
            .collect()
    }

    /// Put a ground record's key among those awaiting a body, in ID order, unless it has one.
    pub(crate) fn await_body(&mut self, key: Key) {
        if self.body(key).is_some() {
            return;
        }
        let at = self
            .waiting
            .binary_search_by(|&k| self.order(k, key))
            .unwrap_or_else(|at| at);
        if self.waiting.get(at) != Some(&key) {
            self.waiting.insert(at, key);
        }
    }

    /// Take a key out of those awaiting a body: its record left the ground, or its body was admitted.
    pub(crate) fn stop_awaiting(&mut self, key: Key) {
        if let Ok(at) = self.waiting.binary_search_by(|&k| self.order(k, key)) {
            self.waiting.remove(at);
        }
    }

    /// Rebuild the keys awaiting a body from the ground store, after a whole upload.
    pub(crate) fn rebuild_waiting(&mut self) {
        let mut waiting: Vec<Key> = self
            .ground
            .keys()
            .map(|k| k as Key)
            .filter(|&k| self.body(k).is_none())
            .collect();
        waiting.sort_by(|&a, &b| self.order(a, b));
        waiting.dedup();
        self.waiting = waiting;
    }

    /// `enqueuePhysicsImpulse` after its validation and sync: the impulse scaled to `limit`, merged into an earlier one
    /// for the same body and generation (the sum clamped to `limit`), else queued after the others.
    pub fn enqueue_impulse(&mut self, key: Key, x: f64, y: f64, limit: f64) -> i32 {
        if self.body(key).is_none() {
            return E_UNKNOWN_IMPULSE_ACTOR;
        }
        let generation = self.generation(key);
        let magnitude = crate::math::hypot(x, y);
        let scale = if magnitude > limit {
            limit / magnitude
        } else {
            1.0
        };
        if let Some(p) = self
            .pending_impulses
            .iter_mut()
            .find(|p| p.0 == key && p.3 == generation)
        {
            let (sx, sy) = (p.1 + x * scale, p.2 + y * scale);
            let total = crate::math::hypot(sx, sy);
            let factor = if total > limit { limit / total } else { 1.0 };
            (p.1, p.2) = (sx * factor, sy * factor);
            return 0;
        }
        if self.pending_impulses.len() >= MAX_PENDING_IMPULSES {
            return E_IMPULSE_CAPACITY;
        }
        self.pending_impulses
            .push((key, x * scale, y * scale, generation));
        0
    }

    /// `enqueuePhysicsAttachment` after its validation and sync: queued with both endpoints' generations.
    pub fn enqueue_attachment(&mut self, key: Key, a: Key, b: Key, max_distance: f64) -> i32 {
        if self.pending_attachments.len() >= MAX_PENDING_ATTACHMENTS {
            return E_ATTACHMENT_CAPACITY;
        }
        if self.body(a).is_none() || self.body(b).is_none() {
            return E_UNKNOWN_ATTACHMENT_ACTOR;
        }
        let (generation_a, generation_b) = (self.generation(a), self.generation(b));
        self.pending_attachments.push(PendingAttachment {
            key,
            a,
            b,
            max_distance,
            generation_a,
            generation_b,
        });
        0
    }

    /// The sync's last step: an impulse or attachment whose body changed generation since it was queued is dropped.
    pub fn filter_pending(&mut self) {
        let impulses = std::mem::take(&mut self.pending_impulses);
        self.pending_impulses = impulses
            .into_iter()
            .filter(|p| self.generation(p.0) == p.3)
            .collect();
        let attachments = std::mem::take(&mut self.pending_attachments);
        self.pending_attachments = attachments
            .into_iter()
            .filter(|p| {
                self.generation(p.a) == p.generation_a && self.generation(p.b) == p.generation_b
            })
            .collect();
    }

    /// Phase 3's hook launch (`hookSkill`): a flying hook from the caster's pose, kept in ID order.
    pub(crate) fn launch_hook(
        &mut self,
        caster: usize,
        generation: f64,
        dx: f64,
        dy: f64,
        tick: f64,
    ) {
        let (r, e) = (&self.players.rows[caster], &self.players.extra[caster]);
        let hook = HookRecord {
            key: e.hook_key as Key,
            caster: caster as f64,
            x: r.x,
            y: r.y,
            dx,
            dy,
            travelled: 0.0,
            started: tick,
            phase: 0.0,
            generation_a: generation,
            target: f64::NAN,
            target_key: f64::NAN,
            generation_b: f64::NAN,
            hit_tick: f64::NAN,
            desired: f64::NAN,
        };
        let at = self
            .hooks
            .partition_point(|h| self.order(h.key, hook.key) == Ordering::Less);
        self.hooks.insert(at, hook);
    }

    /// Phase 3's hook cancel: the caster's own hook leaves.
    /// An item launched since the last admission, by body key (`itemLaunches`, 6d.3): a key launched again takes the
    /// later motion and keeps its place.
    pub(crate) fn launch(&mut self, key: Key, vx: f64, vy: f64) {
        match self.launches.iter_mut().find(|l| l.0 == key) {
            Some(l) => (l.1, l.2) = (vx, vy),
            None => self.launches.push((key, vx, vy)),
        }
    }

    /// The live bodies that are not static, in ID order: the world's snapshot without its statics.
    pub(crate) fn dynamic_keys(&self) -> Vec<Key> {
        self.dynamic.clone()
    }

    /// Take the ground record at `at` off, as `removeItem` writes it through: its key stops awaiting a body (6d.3).
    pub(crate) fn remove_ground(&mut self, at: usize) {
        if let Some(key) = self.ground.key_at(at) {
            self.stop_awaiting(key as Key);
        }
        self.ground.remove(at);
    }

    /// Put `words` where the ground record at `at` is, as `replaceItem` writes it through.
    pub(crate) fn replace_ground(&mut self, at: usize, words: &[f64]) {
        self.ground.input(1).copy_from_slice(words);
        self.ground.replace(at);
    }

    /// Append records to the ground store, as `addItems` writes them through: each awaits a body (#1214 stage 6d.3).
    pub(crate) fn add_ground(&mut self, words: &[f64]) {
        let before = self.ground.len();
        self.ground
            .input(words.len() / crate::ground::RECORD)
            .copy_from_slice(words);
        self.ground.add();
        let added: Vec<u64> = self.ground.keys_from(before).collect();
        for key in added {
            self.await_body(key as Key);
        }
    }

    pub(crate) fn cancel_hook(&mut self, caster: usize) {
        let key = self.players.extra[caster].hook_key as Key;
        self.hooks
            .retain(|h| !(h.caster == caster as f64 && h.key == key));
    }

    /// Replace the hooks with `count` uploaded records (`HOOK_RECORD` words each) from the boundary input.
    pub fn load_hooks(&mut self, count: usize) {
        self.hooks = self.boundary_input[..count * HOOK_RECORD]
            .chunks(HOOK_RECORD)
            .map(|r| HookRecord {
                key: r[0] as Key,
                caster: r[1],
                x: r[2],
                y: r[3],
                dx: r[4],
                dy: r[5],
                travelled: r[6],
                started: r[7],
                phase: r[8],
                generation_a: r[9],
                target: r[10],
                target_key: r[11],
                generation_b: r[12],
                hit_tick: r[13],
                desired: r[14],
            })
            .collect();
    }

    /// Take the gates' keys and closed rows (`count` rows of a key then `BODY_ROW` words) from the boundary input, once
    /// per world.
    /// Takes the sync's settings from the boundary input (#1214 stage 6d.6): three body rows, the drop reserve, then the
    /// hook tuning.
    pub fn configure_sync(&mut self) {
        let input = &self.boundary_input;
        let row = |k: usize| input[k * BODY_ROW..(k + 1) * BODY_ROW].to_vec();
        let at = 3 * BODY_ROW;
        self.sync_config = SyncConfig {
            templates: [row(0), row(1), row(2)],
            drop_reserve: input[at] as usize,
            hook: input[at + 1..at + 1 + crate::hooks::TUNING_WORDS].to_vec(),
        };
    }

    pub fn load_gates(&mut self, count: usize) {
        let rows: Vec<(Key, Vec<f64>)> = self.boundary_input[..count * (1 + BODY_ROW)]
            .chunks(1 + BODY_ROW)
            .map(|r| (r[0] as Key, r[1..].to_vec()))
            .collect();
        let mut order: Vec<usize> = (0..count).collect();
        order.sort_by(|&a, &b| self.order(rows[a].0, rows[b].0));
        self.gate_bodies = GateBodies {
            keys: rows.iter().map(|r| r.0).collect(),
            rows: rows.into_iter().map(|r| r.1).collect(),
            order,
            seen: vec![0; count],
        };
    }

    /// JavaScript's `<` on the two IDs: UTF-16 code units, compared in order.
    fn order(&self, a: Key, b: Key) -> Ordering {
        self.ids[a as usize].cmp(&self.ids[b as usize])
    }

    fn body(&self, key: Key) -> Option<&Body> {
        self.bodies.get(key as usize).and_then(Option::as_ref)
    }

    fn dynamic_body(&self, key: Key) -> Option<Body> {
        self.body(key)
            .copied()
            .filter(|b| b.kind != physics::KIND_STATIC)
    }

    /// Interns the ID whose UTF-16 code units fill the input; returns its key.
    pub fn intern(&mut self) -> Key {
        let id = self
            .engine
            .input_values()
            .iter()
            .map(|&u| u as u16)
            .collect();
        self.ids.push(id);
        self.bodies.push(None);
        (self.ids.len() - 1) as Key
    }

    fn queued(&self) -> usize {
        self.pending_add.len()
            + self.pending_remove.len()
            + self.pending_add_constraints.len()
            + self.pending_remove_constraints.len()
            + self.forces.len()
            + self.impulses.len()
    }

    /// world.ts's `checkQueue`.
    pub fn check_queue(&self) -> i32 {
        if self.queued() >= MAX_PENDING {
            E_QUEUE_FULL
        } else {
            0
        }
    }

    /// world.ts's `roomCount`: live bodies of the kind, plus queued additions, less queued removals
    /// of live ones.
    fn room_count(&self, kind: u32) -> usize {
        let live = match kind {
            physics::KIND_ACTOR => self.actor_count,
            physics::KIND_STATIC => self.static_count,
            _ => self.dynamic_count - self.actor_count,
        };
        let added = self
            .pending_add
            .iter()
            .filter(|p| p.params.kind == kind)
            .count();
        let removed = self
            .pending_remove
            .iter()
            .filter(|&&key| self.body(key).is_some_and(|b| b.kind == kind))
            .count();
        live + added - removed
    }

    pub fn can_add_bodies(&self, count: usize) -> bool {
        count
            <= MAX_DYNAMIC
                .saturating_sub(self.room_count(physics::KIND_ACTOR))
                .saturating_sub(self.room_count(physics::KIND_PROP))
            && count <= MAX_PENDING.saturating_sub(self.queued())
    }

    /// Queues the body whose row fills the input: `key, kind, map geometry, shape, a, b, x, y,
    /// angle, vx, vy, omega, mass, friction, restitution, linear damping, angular damping (NaN
    /// unset), groups, loot, speed limit, tip radius, vertex count`, then the vertices' `x, y`.
    pub fn queue_add_body(&mut self) -> i32 {
        let pending = pending_from(self.engine.input_values());
        self.queue_pending(pending)
    }

    /// Queues the body `row` describes, laid out as `queue_add_body`'s input, for the core's own
    /// callers (`boundary.rs`).
    pub(crate) fn queue_add_row(&mut self, row: &[f64]) -> i32 {
        self.queue_pending(pending_from(row))
    }

    fn queue_pending(&mut self, pending: Pending) -> i32 {
        let key = pending.key;
        if self.queued() >= MAX_PENDING {
            return E_QUEUE_FULL;
        }
        if self.body(key).is_some() && !self.pending_remove.contains(&key)
            || self.pending_add.iter().any(|p| p.key == key)
        {
            return E_DUPLICATE_BODY;
        }
        let kind = pending.params.kind;
        let dynamic = self.room_count(physics::KIND_ACTOR) + self.room_count(physics::KIND_PROP);
        if kind == physics::KIND_ACTOR && self.room_count(physics::KIND_ACTOR) >= MAX_ACTORS
            || kind != physics::KIND_STATIC && dynamic >= MAX_DYNAMIC
            || kind == physics::KIND_STATIC && self.room_count(physics::KIND_STATIC) >= MAX_STATIC
        {
            return E_BODY_CAPACITY;
        }
        self.pending_add.push(pending);
        0
    }

    /// How many commands are queued: nonzero when a commit has something to do.
    pub(crate) fn queued_count(&self) -> usize {
        self.queued()
    }

    /// Whether the key names a live body.
    pub(crate) fn has_body(&self, key: Key) -> bool {
        self.body(key).is_some()
    }

    /// The body's position, without touching the output buffer.
    pub(crate) fn position(&mut self, key: Key) -> Option<(f64, f64)> {
        let slot = self.body(key)?.slot;
        let pose = self.engine.pose(slot);
        Some((pose[0], pose[1]))
    }

    /// JavaScript's `<` on two interned IDs, for the core's own callers.
    pub(crate) fn id_order(&self, a: Key, b: Key) -> Ordering {
        self.order(a, b)
    }

    pub fn queue_remove_body(&mut self, key: Key) -> i32 {
        if self.queued() >= MAX_PENDING {
            return E_QUEUE_FULL;
        }
        if self.body(key).is_none() && !self.pending_add.iter().any(|p| p.key == key) {
            return E_UNKNOWN_BODY;
        }
        if self.pending_remove.contains(&key) {
            return E_DUPLICATE_REMOVAL;
        }
        self.pending_remove.push(key);
        0
    }

    /// Queues the constraint whose row fills the input: `key, a, b, legacy`, then `row`'s values.
    pub fn queue_add_constraint(&mut self) -> i32 {
        let input = self.engine.input_values().to_vec();
        self.queue_constraint_row(&input)
    }

    /// Queues the constraint `input` describes, laid out as `queue_add_constraint`'s input, for the
    /// core's own callers (`hooks.rs`).
    pub(crate) fn queue_constraint_row(&mut self, input: &[f64]) -> i32 {
        let mut row = [0.0; 11];
        row.copy_from_slice(&input[3..CONSTRAINT_ROW]);
        let (key, a, b) = (input[0] as Key, input[1] as Key, input[2] as Key);
        let legacy = row[0].is_nan();
        if legacy {
            row[0] = 0.0;
        }
        if self.queued() >= MAX_PENDING {
            return E_QUEUE_FULL;
        }
        let live = self.constraints.iter().any(|c| c.key == key);
        if live && !self.pending_remove_constraints.contains(&key)
            || self.pending_add_constraints.iter().any(|c| c.key == key)
        {
            return E_DUPLICATE_CONSTRAINT;
        }
        if self.constraints.len() - self.pending_remove_constraints.len()
            + self.pending_add_constraints.len()
            >= MAX_CONSTRAINTS
        {
            return E_CONSTRAINT_CAPACITY;
        }
        for (i, id) in [a, b].into_iter().enumerate() {
            let pending = self.pending_add.iter().find(|p| p.key == id);
            if (self.body(id).is_none() || self.pending_remove.contains(&id)) && pending.is_none() {
                return E_UNKNOWN_ENDPOINT - i as i32;
            }
            let geometry = match self.body(id) {
                Some(body) => body.map_geometry,
                None => pending.is_some_and(|p| p.params.map_geometry),
            };
            if geometry {
                return E_GEOMETRY_ENDPOINT - i as i32;
            }
        }
        self.pending_add_constraints.push(Constraint {
            key,
            a,
            b,
            legacy,
            rope: None,
            row,
        });
        0
    }

    pub fn queue_remove_constraint(&mut self, key: Key) -> i32 {
        if self.queued() >= MAX_PENDING {
            return E_QUEUE_FULL;
        }
        if !self.constraints.iter().any(|c| c.key == key)
            && !self.pending_add_constraints.iter().any(|c| c.key == key)
        {
            return E_UNKNOWN_CONSTRAINT;
        }
        if self.pending_remove_constraints.contains(&key) {
            return E_DUPLICATE_CONSTRAINT_REMOVAL;
        }
        self.pending_remove_constraints.push(key);
        0
    }

    /// Queues a force or an impulse, refused as world.ts refused it.
    pub fn queue_push(&mut self, impulse: bool, key: Key, x: f64, y: f64) -> i32 {
        if self.queued() >= MAX_PENDING {
            return E_QUEUE_FULL;
        }
        if self.dynamic_body(key).is_none() {
            return E_UNKNOWN_DYNAMIC;
        }
        if impulse {
            self.impulses.push((key, x, y));
        } else {
            self.forces.push((key, x, y));
        }
        0
    }

    fn wake_endpoints(&mut self, c: &Constraint) {
        for id in [c.a, c.b] {
            if let Some(body) = self.dynamic_body(id) {
                self.engine.wake(body.slot);
            }
        }
    }

    /// Drops the live constraint at `index`: a native rope leaves the engine, waking its bodies;
    /// a bounded one wakes them here.
    fn drop_constraint(&mut self, index: usize) {
        let c = self.constraints.remove(index);
        match c.rope {
            Some(rope) => self.engine.remove_rope(rope),
            None => self.wake_endpoints(&c),
        }
    }

    fn add(&mut self, p: &Pending) -> bool {
        let Some(slot) = self
            .engine
            .add_body(&p.params, p.shape, p.a, p.b, &p.vertices)
        else {
            return false;
        };
        self.next_generation += 1;
        self.bodies[p.key as usize] = Some(Body {
            slot,
            generation: self.next_generation,
            kind: p.params.kind,
            map_geometry: p.params.map_geometry,
            loot: p.loot,
            limit: p.limit,
            tip: p.tip,
            motor: None,
        });
        if p.params.kind == physics::KIND_PROP && !p.loot {
            let key = p.key as usize;
            if key >= self.prop_shapes.len() {
                self.prop_shapes.resize(key + 1, None);
            }
            self.prop_shapes[key] = Some(PropShape {
                shape: p.shape,
                a: p.a,
                b: p.b,
                vertices: p.vertices.clone(),
            });
        }
        if p.params.kind == physics::KIND_STATIC {
            self.static_count += 1;
        } else {
            self.dynamic_count += 1;
            if p.params.kind == physics::KIND_ACTOR {
                self.actor_count += 1;
            }
        }
        let slot = slot as usize;
        if slot >= self.slot_keys.len() {
            self.slot_keys.resize(slot + 1, None);
        }
        self.slot_keys[slot] = Some(p.key);
        true
    }

    /// Applies the queues in world.ts's order: constraint removals, body removals, body additions,
    /// constraint additions, each by ID. The output holds the count of facts, then the facts as
    /// `kind, key` pairs (`FACT_*`) for JavaScript's records. Returns 0, or `E_INVALID_CONVEX` when
    /// Rapier cannot hull a body: the facts are then those of the mutations done before it, which
    /// stay done, as world.ts's mid-commit throw left them, and the rest stay queued.
    pub fn commit(&mut self) -> i32 {
        let mut facts = std::mem::take(&mut self.output);
        facts.clear();
        facts.push(0.0);
        let bodies_changed = !self.pending_add.is_empty() || !self.pending_remove.is_empty();
        let removed = std::mem::take(&mut self.pending_remove);
        let existed: Vec<Key> = removed
            .iter()
            .copied()
            .filter(|&k| self.body(k).is_some())
            .collect();
        let mut remove_constraints = std::mem::take(&mut self.pending_remove_constraints);
        remove_constraints.sort_by(|&a, &b| self.order(a, b));
        for &key in &remove_constraints {
            if let Some(index) = self.constraints.iter().position(|c| c.key == key) {
                self.drop_constraint(index);
            }
        }
        let mut sorted_removed = removed.clone();
        sorted_removed.sort_by(|&a, &b| self.order(a, b));
        for &key in &sorted_removed {
            let Some(body) = self.body(key).copied() else {
                continue;
            };
            let mut i = 0;
            while i < self.constraints.len() {
                let c = self.constraints[i];
                if c.a == key || c.b == key {
                    // Rapier removes a body's joints with it; a rope's index is not released.
                    if c.rope.is_none() {
                        self.wake_endpoints(&c);
                    }
                    self.constraints.remove(i);
                } else {
                    i += 1;
                }
            }
            self.engine.remove_body(body.slot);
            self.slot_keys[body.slot as usize] = None;
            self.bodies[key as usize] = None;
            if let Some(shape) = self.prop_shapes.get_mut(key as usize) {
                *shape = None;
            }
            if body.kind == physics::KIND_STATIC {
                self.static_count -= 1;
            } else {
                self.dynamic_count -= 1;
                if body.kind == physics::KIND_ACTOR {
                    self.actor_count -= 1;
                }
            }
            facts.extend_from_slice(&[FACT_REMOVED, f64::from(key)]);
        }
        let mut add = std::mem::take(&mut self.pending_add);
        add.sort_by(|a, b| self.order(a.key, b.key));
        let mut added = Vec::new();
        for index in 0..add.len() {
            let p = &add[index];
            // A create/remove pair cancels before admission. Removing an existing ID and re-adding
            // it is a replacement with a new engine handle.
            if !removed.contains(&p.key) || existed.contains(&p.key) {
                if !self.add(p) {
                    self.pending_add = add.split_off(index);
                    self.settle_bodies(&removed, added);
                    facts[0] = ((facts.len() - 1) / 2) as f64;
                    self.output = facts;
                    return E_INVALID_CONVEX;
                }
                facts.extend_from_slice(&[FACT_ADDED, f64::from(p.key)]);
                if p.params.kind != physics::KIND_STATIC {
                    added.push(p.key);
                }
            }
        }
        let mut add_constraints = std::mem::take(&mut self.pending_add_constraints);
        add_constraints.sort_by(|a, b| self.order(a.key, b.key));
        for mut c in add_constraints {
            if remove_constraints.contains(&c.key)
                || removed.contains(&c.a)
                || removed.contains(&c.b)
            {
                continue;
            }
            let (Some(a), Some(b)) = (self.body(c.a).copied(), self.body(c.b).copied()) else {
                continue;
            };
            if c.legacy {
                c.rope = Some(self.engine.add_rope(a.slot, b.slot, c.row[1]));
            } else {
                self.engine.wake(a.slot);
                self.engine.wake(b.slot);
            }
            self.constraints.push(c);
            facts.extend_from_slice(&[FACT_CONSTRAINT_ADDED, f64::from(c.key)]);
        }
        if bodies_changed {
            self.settle_bodies(&removed, added);
        }
        facts[0] = ((facts.len() - 1) / 2) as f64;
        self.output = facts;
        0
    }

    /// After a commit's body mutations: the dynamic list drops the removed bodies and takes the added
    /// ones, in ID order, and queued pushes on removed bodies go.
    fn settle_bodies(&mut self, removed: &[Key], added: Vec<Key>) {
        self.dynamic.retain(|k| !removed.contains(k));
        self.dynamic.extend(added);
        let mut dynamic = std::mem::take(&mut self.dynamic);
        dynamic.sort_by(|&a, &b| self.order(a, b));
        self.dynamic = dynamic;
        self.forces.retain(|f| !removed.contains(&f.0));
        self.impulses.retain(|f| !removed.contains(&f.0));
    }

    /// The live constraints' count (`counts().constraints`).
    pub(crate) fn constraint_count(&self) -> usize {
        self.constraints.len()
    }

    pub fn has_constraint(&self, key: Key) -> bool {
        self.constraints.iter().any(|c| c.key == key)
    }

    /// The body's generation, or -1 when it has none.
    pub fn generation(&self, key: Key) -> f64 {
        self.body(key).map_or(-1.0, |b| b.generation as f64)
    }

    /// Sets a dynamic body's motor and wakes it.
    pub fn set_motor(&mut self, key: Key, x: f64, y: f64, accel: f64) -> i32 {
        let Some(body) = self.dynamic_body(key) else {
            return E_UNKNOWN_DYNAMIC;
        };
        self.bodies[key as usize].as_mut().expect("live").motor = Some([x, y, accel]);
        self.engine.wake(body.slot);
        0
    }

    /// Sets a dynamic body's damping where it differs; returns which changed (bit 1 linear, bit 2
    /// angular) for JavaScript's spec.
    pub fn set_damping(&mut self, key: Key, linear: f64, angular: f64) -> i32 {
        let Some(body) = self.dynamic_body(key) else {
            return E_UNKNOWN_DYNAMIC;
        };
        let current = self.engine.damping(body.slot);
        let mut changed = 0;
        if current[0] != linear {
            self.engine.set_damping(body.slot, false, linear);
            changed |= 1;
        }
        if current[1] != angular {
            self.engine.set_damping(body.slot, true, angular);
            changed |= 2;
        }
        changed
    }

    /// An explicit teleport: drops the body's constraints and queued pushes, clears its motor and
    /// gives it a new generation.
    pub fn set_transform(&mut self, key: Key, x: f64, y: f64, angle: f64) -> i32 {
        let Some(body) = self.dynamic_body(key) else {
            return E_UNKNOWN_DYNAMIC;
        };
        let mut i = 0;
        while i < self.constraints.len() {
            let c = self.constraints[i];
            if c.a == key || c.b == key {
                self.drop_constraint(i);
            } else {
                i += 1;
            }
        }
        self.pending_add_constraints
            .retain(|c| c.a != key && c.b != key);
        let (live, pending) = (&self.constraints, &self.pending_add_constraints);
        self.pending_remove_constraints
            .retain(|&id| live.iter().any(|c| c.key == id) || pending.iter().any(|c| c.key == id));
        self.forces.retain(|f| f.0 != key);
        self.impulses.retain(|f| f.0 != key);
        self.next_generation += 1;
        let entry = self.bodies[key as usize].as_mut().expect("live");
        entry.motor = None;
        entry.generation = self.next_generation;
        self.engine.set_pose(body.slot, x, y, angle);
        0
    }

    /// The body's pose (`physics::World::pose`) in the output; false when it has none.
    pub fn transform(&mut self, key: Key) -> bool {
        let Some(body) = self.body(key).copied() else {
            return false;
        };
        self.output.clear();
        self.output.extend_from_slice(self.engine.pose(body.slot));
        true
    }

    /// Whether a solid prop (not loot) meets a ball of radius `r` at `(x, y)`.
    pub fn overlaps_prop(&mut self, r: f64, x: f64, y: f64) -> bool {
        self.engine.propagate();
        self.dynamic.iter().any(|&key| {
            let body = self.body(key).expect("live");
            body.kind == physics::KIND_PROP
                && !body.loot
                && self
                    .engine
                    .intersects(body.slot, physics::SHAPE_CIRCLE, r, 0.0, x, y)
        })
    }

    /// Whether a dynamic body other than loot meets the axis-aligned box.
    pub fn overlaps_dynamic_box(&mut self, hx: f64, hy: f64, x: f64, y: f64) -> bool {
        self.engine.propagate();
        self.dynamic.iter().any(|&key| {
            let body = self.body(key).expect("live");
            !body.loot
                && self
                    .engine
                    .intersects(body.slot, physics::SHAPE_BOX, hx, hy, x, y)
        })
    }

    /// `actors, dynamic, static, constraints` in the output.
    pub fn counts(&mut self) {
        self.output.clear();
        self.output.extend_from_slice(&[
            self.actor_count as f64,
            self.dynamic_count as f64,
            self.static_count as f64,
            self.constraints.len() as f64,
        ]);
    }

    /// One engine step over a world of committed statics; returns the events it made, or
    /// `E_NOT_STATIC`.
    pub fn prepare_statics(&mut self) -> i32 {
        if self.dynamic_count != 0 || !self.constraints.is_empty() || self.queued() != 0 {
            return E_NOT_STATIC;
        }
        self.engine.prepare() as i32
    }

    /// The floors and profiles from the input (`floor_drag::Floor::from_input`).
    pub fn set_floor(&mut self) {
        self.engine.set_floor();
    }

    /// Floor drag; the output holds `key, changed, linear, angular` rows. Returns their count.
    pub fn apply_floor_drag(&mut self) -> usize {
        let rows = self.engine.apply_floor_drag();
        let mut output = std::mem::take(&mut self.output);
        output.clear();
        for row in rows.as_chunks::<{ physics::DRAG_STRIDE }>().0 {
            let key = self.slot_keys[row[0] as usize].expect("a live slot");
            output.extend_from_slice(&[f64::from(key), row[1], row[2], row[3]]);
        }
        self.output = output;
        self.output.len() / physics::DRAG_STRIDE
    }

    /// One tick, after `commit`. The output: `STEP_HEADER` (status, the failing body's key, the
    /// dynamic count `n`, contacts dropped), the `n` dynamic keys in ID order, then their positions
    /// before the first substep and after each, as the engine's step gives them. A nonzero status
    /// or a dropped contact is an error JavaScript throws, as world.ts did; a nonzero status's
    /// output is the header alone.
    pub fn step(&mut self, discard_contacts: bool) -> &[f64] {
        let mut forces = std::mem::take(&mut self.forces);
        forces.sort_by(|a, b| self.order(a.0, b.0));
        forces.retain(|f| self.body(f.0).is_some());
        let mut impulses = std::mem::take(&mut self.impulses);
        impulses.sort_by(|a, b| self.order(a.0, b.0));
        impulses.retain(|f| self.body(f.0).is_some());
        let mut sorted: Vec<Key> = self.constraints.iter().map(|c| c.key).collect();
        sorted.sort_by(|&a, &b| self.order(a, b));
        let mut bounded: Vec<Constraint> = Vec::new();
        for key in sorted {
            let index = self
                .constraints
                .iter()
                .position(|c| c.key == key)
                .expect("live");
            let c = self.constraints[index];
            if c.legacy {
                continue;
            }
            if self.body(c.a).is_none() || self.body(c.b).is_none() {
                self.constraints.remove(index);
                continue;
            }
            bounded.push(c);
        }

        let n = self.dynamic.len();
        let length = n * physics::DYNAMIC_STRIDE
            + (forces.len() + impulses.len()) * physics::PUSH_STRIDE
            + bounded.len() * physics::CONSTRAINT_STRIDE;
        let mut input = std::mem::take(self.engine.input_vec());
        input.clear();
        input.reserve(length);
        for &key in &self.dynamic {
            let body = self.body(key).expect("live");
            let motor = body.motor;
            input.extend_from_slice(&[
                f64::from(body.slot),
                if motor.is_some() { 1.0 } else { 0.0 },
                motor.map_or(0.0, |m| m[0]),
                motor.map_or(0.0, |m| m[1]),
                motor.map_or(0.0, |m| m[2]),
                body.limit,
                body.tip,
            ]);
        }
        for &(key, x, y) in forces.iter().chain(&impulses) {
            input.extend_from_slice(&[f64::from(self.body(key).expect("live").slot), x, y]);
        }
        for c in &bounded {
            input.push(f64::from(self.body(c.a).expect("live").slot));
            input.push(f64::from(self.body(c.b).expect("live").slot));
            input.extend_from_slice(&c.row);
        }
        *self.engine.input_vec() = input;

        let result = self
            .engine
            .step(n, forces.len(), impulses.len(), bounded.len())
            .to_vec();
        let (status, failed) = (result[0], result[1]);
        let (events, broken) = (result[2] as usize, result[3] as usize);
        let positions = (SUBSTEPS + 1) * n * 2;
        let mut output = std::mem::take(&mut self.output);
        output.clear();
        output.extend_from_slice(&[status, 0.0, n as f64, 0.0]);
        if status != 0.0 {
            // The engine stopped mid-step, so its paths are partial: only the header crosses.
            output[1] = f64::from(self.dynamic[failed as usize]);
            self.output = output;
            return &self.output;
        }
        output.extend(self.dynamic.iter().map(|&k| f64::from(k)));
        output.extend_from_slice(&result[HEADER..HEADER + positions]);
        let event_rows =
            &result[HEADER + positions..HEADER + positions + events * physics::EVENT_STRIDE];
        let broken_rows = &result[HEADER + positions + events * physics::EVENT_STRIDE..][..broken];
        let name = |slot: f64| self.slot_keys.get(slot as usize).copied().flatten();
        let mut dropped = 0usize;
        if discard_contacts {
            let named = event_rows
                .as_chunks::<{ physics::EVENT_STRIDE }>()
                .0
                .iter()
                .filter(|e| name(e[1]).is_some() && name(e[2]).is_some())
                .count();
            dropped = (self.contacts.len() + named).saturating_sub(MAX_EVENTS);
            self.contacts.clear();
        } else {
            let mut contacts = std::mem::take(&mut self.contacts);
            for e in event_rows.as_chunks::<{ physics::EVENT_STRIDE }>().0 {
                let (Some(first), Some(second)) = (name(e[1]), name(e[2])) else {
                    continue;
                };
                if contacts.len() >= MAX_EVENTS {
                    dropped += 1;
                    continue;
                }
                let (a, b) = if self.order(first, second) != Ordering::Greater {
                    (first, second)
                } else {
                    (second, first)
                };
                contacts.push([e[0], f64::from(a), f64::from(b), e[3]]);
            }
            self.contacts = contacts;
        }
        for &index in broken_rows {
            let key = bounded[index as usize].key;
            self.constraints.retain(|c| c.key != key);
        }
        output[3] = dropped as f64;
        if dropped == 0 {
            let mut contacts = std::mem::take(&mut self.contacts);
            // By substep, then IDs, then 'start' before 'stop', as world.ts sorted them.
            contacts.sort_by(|x, y| {
                x[0].total_cmp(&y[0])
                    .then_with(|| self.order(x[1] as Key, y[1] as Key))
                    .then_with(|| self.order(x[2] as Key, y[2] as Key))
                    .then_with(|| y[3].total_cmp(&x[3]))
            });
            self.contacts = contacts;
        }
        self.output = output;
        &self.output
    }

    /// Takes the retained contacts into the output, `CONTACT_STRIDE` values each; returns their
    /// count.
    pub fn drain_contacts(&mut self) -> usize {
        self.output.clear();
        for c in self.contacts.drain(..) {
            self.output.extend_from_slice(&c);
        }
        self.output.len() / CONTACT_STRIDE
    }

    /// Each dynamic body's position and external force, in ID order; returns the row count.
    pub fn debug_forces(&mut self) -> usize {
        let mut output = std::mem::take(&mut self.output);
        output.clear();
        for &key in &self.dynamic {
            let slot = self.body(key).expect("live").slot;
            output.push(f64::from(key));
            output.extend_from_slice(self.engine.user_force(slot));
        }
        self.output = output;
        self.dynamic.len()
    }

    /// The touching pairs' manifold points, named and ordered as world.ts ordered them, at most 256.
    pub fn debug_contacts(&mut self) -> usize {
        let raw = self.engine.debug_contacts().to_vec();
        let mut rows: Vec<[f64; DEBUG_CONTACT_STRIDE]> = Vec::new();
        for r in raw.as_chunks::<DEBUG_CONTACT_STRIDE>().0 {
            let name = |slot: f64| self.slot_keys.get(slot as usize).copied().flatten();
            let (Some(first), Some(second)) = (name(r[0]), name(r[1])) else {
                continue;
            };
            let forward = self.order(first, second) != Ordering::Greater;
            let sign = if forward { 1.0 } else { -1.0 };
            let (a, b) = if forward {
                (first, second)
            } else {
                (second, first)
            };
            rows.push([
                f64::from(a),
                f64::from(b),
                r[2],
                r[3],
                r[4] * sign,
                r[5] * sign,
                r[6],
            ]);
        }
        // `a.point.x - b.point.x || a.point.y - b.point.y`: a zero or NaN difference falls through.
        let difference = |d: f64| {
            if d == 0.0 || d.is_nan() {
                None
            } else if d < 0.0 {
                Some(Ordering::Less)
            } else {
                Some(Ordering::Greater)
            }
        };
        rows.sort_by(|x, y| {
            self.order(x[0] as Key, y[0] as Key)
                .then_with(|| self.order(x[1] as Key, y[1] as Key))
                .then_with(|| {
                    difference(x[2] - y[2])
                        .or_else(|| difference(x[3] - y[3]))
                        .unwrap_or(Ordering::Equal)
                })
        });
        rows.truncate(256);
        self.output.clear();
        for r in &rows {
            self.output.extend_from_slice(r);
        }
        rows.len()
    }

    /// `SNAPSHOT_STRIDE` rows in ID order: the dynamic bodies, or every body with `include_static`.
    pub fn snapshot(&mut self, include_static: bool) -> usize {
        let keys: Vec<Key> = if include_static {
            let mut all: Vec<Key> = (0..self.bodies.len() as Key)
                .filter(|&k| self.body(k).is_some())
                .collect();
            all.sort_by(|&a, &b| self.order(a, b));
            all
        } else {
            self.dynamic.clone()
        };
        self.rows(&keys)
    }

    /// The solid props (no loot) in ID order, each with its shape and pose `x, y, angle`, as
    /// `solidProps` in `swept.ts` reads them from the world's snapshot.
    pub(crate) fn solid_prop_poses(&mut self) -> Vec<(PropShape, f64, f64, f64)> {
        let keys: Vec<Key> = self
            .dynamic
            .iter()
            .copied()
            .filter(|&k| {
                let b = self.body(k).expect("live");
                b.kind == physics::KIND_PROP && !b.loot
            })
            .collect();
        keys.into_iter()
            .map(|key| {
                let slot = self.body(key).expect("live").slot;
                let shape = self.prop_shapes[key as usize].clone().expect("solid prop");
                let pose = self.engine.pose(slot);
                (shape, pose[0], pose[1], pose[2])
            })
            .collect()
    }

    /// The solid props (no loot), as `snapshot` rows.
    pub fn solid_props(&mut self) -> usize {
        let keys: Vec<Key> = self
            .dynamic
            .iter()
            .copied()
            .filter(|&k| {
                let b = self.body(k).expect("live");
                b.kind == physics::KIND_PROP && !b.loot
            })
            .collect();
        self.rows(&keys)
    }

    fn rows(&mut self, keys: &[Key]) -> usize {
        let mut output = std::mem::take(&mut self.output);
        output.clear();
        for &key in keys {
            let body = self.body(key).copied().expect("live");
            output.push(f64::from(key));
            output.push(body.generation as f64);
            output.extend_from_slice(self.engine.pose(body.slot));
        }
        self.output = output;
        keys.len()
    }

    /// The queues, for a snapshot's `pending`: the counts of body additions, removals, constraint
    /// additions, removals, forces and impulses, then their keys in queue order, then the forces'
    /// and impulses' `key, x, y` rows.
    pub fn pending(&mut self) {
        let mut out = std::mem::take(&mut self.output);
        out.clear();
        out.extend_from_slice(&[
            self.pending_add.len() as f64,
            self.pending_remove.len() as f64,
            self.pending_add_constraints.len() as f64,
            self.pending_remove_constraints.len() as f64,
            self.forces.len() as f64,
            self.impulses.len() as f64,
        ]);
        out.extend(self.pending_add.iter().map(|p| f64::from(p.key)));
        out.extend(self.pending_remove.iter().map(|&k| f64::from(k)));
        out.extend(
            self.pending_add_constraints
                .iter()
                .map(|c| f64::from(c.key)),
        );
        out.extend(
            self.pending_remove_constraints
                .iter()
                .map(|&k| f64::from(k)),
        );
        for &(key, x, y) in self.forces.iter().chain(&self.impulses) {
            out.extend_from_slice(&[f64::from(key), x, y]);
        }
        self.output = out;
    }

    /// The live constraints' keys in ID order; returns their count.
    pub fn constraint_keys(&mut self) -> usize {
        let mut keys: Vec<Key> = self.constraints.iter().map(|c| c.key).collect();
        keys.sort_by(|&a, &b| self.order(a, b));
        self.output.clear();
        self.output.extend(keys.iter().map(|&k| f64::from(k)));
        keys.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intern(world: &mut World, id: &str) -> Key {
        let units: Vec<f64> = id.encode_utf16().map(f64::from).collect();
        world.input(units.len()).copy_from_slice(&units);
        world.intern()
    }

    fn queue_ball(world: &mut World, key: Key, kind: u32, x: f64) -> i32 {
        let groups = (0x0004 << 16) | 0x0007;
        let row = [
            f64::from(key),
            f64::from(kind),
            0.0,
            f64::from(physics::SHAPE_CIRCLE),
            12.0,
            0.0,
            x,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.5,
            0.0,
            f64::NAN,
            f64::NAN,
            f64::from(groups),
            0.0,
            768.0,
            0.0,
            0.0,
        ];
        world.input(BODY_ROW).copy_from_slice(&row);
        world.queue_add_body()
    }

    #[test]
    fn ids_order_as_javascript_strings_do() {
        let mut world = World::new();
        // UTF-16 order puts a surrogate pair (U+1F600) before U+FF5E, which UTF-8 would not.
        let (high, low) = (
            intern(&mut world, "\u{1F600}"),
            intern(&mut world, "\u{FF5E}"),
        );
        assert_eq!(world.order(high, low), Ordering::Less);
        let (short, long) = (intern(&mut world, "item:1"), intern(&mut world, "item:10"));
        assert_eq!(world.order(short, long), Ordering::Less);
    }

    #[test]
    fn commits_in_id_order_and_reports_facts() {
        let mut world = World::new();
        let (b, a) = (intern(&mut world, "prop:b"), intern(&mut world, "prop:a"));
        assert_eq!(queue_ball(&mut world, b, physics::KIND_PROP, 40.0), 0);
        assert_eq!(queue_ball(&mut world, a, physics::KIND_PROP, -40.0), 0);
        assert_eq!(
            queue_ball(&mut world, a, physics::KIND_PROP, 0.0),
            E_DUPLICATE_BODY
        );
        assert_eq!(world.commit(), 0);
        assert_eq!(
            world.output(),
            [2.0, FACT_ADDED, f64::from(a), FACT_ADDED, f64::from(b)]
        );
        assert_eq!((world.generation(a), world.generation(b)), (1.0, 2.0));
        assert_eq!(world.dynamic, [a, b]);
        // A queued add and remove of a new ID cancel; a remove and re-add of a live one replaces it.
        let c = intern(&mut world, "prop:c");
        queue_ball(&mut world, c, physics::KIND_PROP, 80.0);
        assert_eq!(world.queue_remove_body(c), 0);
        assert_eq!(world.queue_remove_body(a), 0);
        assert_eq!(queue_ball(&mut world, a, physics::KIND_PROP, -40.0), 0);
        assert_eq!(world.commit(), 0);
        assert_eq!(
            world.output(),
            [2.0, FACT_REMOVED, f64::from(a), FACT_ADDED, f64::from(a)]
        );
        assert_eq!(world.generation(a), 3.0);
        assert_eq!(world.generation(c), -1.0);
    }

    #[test]
    fn a_hull_rejected_mid_commit_reports_what_was_done() {
        let mut world = World::new();
        let (a, z) = (intern(&mut world, "prop:a"), intern(&mut world, "z"));
        queue_ball(&mut world, a, physics::KIND_PROP, 0.0);
        world.commit();
        assert_eq!(world.queue_remove_body(a), 0);
        // Valid in f64, but collinear once rounded to Rapier's f32 (review 972).
        let vertices = [-1e8, -1e8, 1e8, 1e8 - 1.0, 1e8, 1e8 + 1.0];
        let mut row = vec![0.0; BODY_ROW];
        row[0] = f64::from(z);
        row[1] = f64::from(physics::KIND_STATIC);
        row[3] = 2.0;
        row[12] = 1.0;
        row[15] = f64::NAN;
        row[16] = f64::NAN;
        row[17] = f64::from((0x0001 << 16) | 0x000f);
        row[21] = 3.0;
        row.extend_from_slice(&vertices);
        world.input(row.len()).copy_from_slice(&row);
        assert_eq!(world.queue_add_body(), 0);
        assert_eq!(world.commit(), E_INVALID_CONVEX);
        assert_eq!(world.output(), [1.0, FACT_REMOVED, f64::from(a)]);
        assert!(world.dynamic.is_empty());
        assert_eq!(world.generation(a), -1.0);
        // The rejected body stays queued, and the next commit refuses it again.
        assert_eq!(world.commit(), E_INVALID_CONVEX);
        assert_eq!(world.output(), [0.0]);
    }

    #[test]
    fn a_nonfinite_speed_stops_the_step_with_only_its_header() {
        let mut world = World::new();
        let a = intern(&mut world, "prop:a");
        queue_ball(&mut world, a, physics::KIND_PROP, 0.0);
        world.commit();
        let slot = world.body(a).expect("live").slot;
        world.engine.set_velocity_for_test(slot, f64::NAN);
        let output = world.step(true);
        assert_eq!(output.len(), STEP_HEADER);
        assert_eq!(output[0], 1.0);
        assert_eq!(output[1], f64::from(a));
    }

    #[test]
    fn a_teleport_drops_pushes_and_renews_the_generation() {
        let mut world = World::new();
        let a = intern(&mut world, "actor:a");
        queue_ball(&mut world, a, physics::KIND_ACTOR, 0.0);
        world.commit();
        assert_eq!(world.queue_push(true, a, 1.0, 0.0), 0);
        assert_eq!(world.set_motor(a, 10.0, 0.0, 100.0), 0);
        assert_eq!(world.set_transform(a, 5.0, 0.0, 0.0), 0);
        assert!(world.impulses.is_empty());
        assert!(world.body(a).expect("live").motor.is_none());
        assert_eq!(world.generation(a), 2.0);
        let unknown = intern(&mut world, "actor:none");
        assert_eq!(world.set_motor(unknown, 0.0, 0.0, 0.0), E_UNKNOWN_DYNAMIC);
    }
}
