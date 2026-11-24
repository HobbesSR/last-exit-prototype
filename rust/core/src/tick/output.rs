//! What a completed tick sends out (27.2 Boundary, R12; 26).
//!
//! - **The change list** Node's mirror applies until #1284 removes it: each changed record
//!   whole, the IDs removed, the committed poses that moved and the tick's events. It is one
//!   list, built once after apply commits, so the mirror needs no per-phase appliers.
//! - **The recording frame:** S1, which is the previous frame with the change list applied, plus
//!   T's inbound queue and apply's discontinuity markers. A keyframe is a [`Snapshot`].
//!
//! The change list's cost follows what changed. Actors, projectiles and hooks are compared with
//! their tick-start records, since they are the active set. Ground items, gates and traps are
//! map-sized, so only the records a fact or lifecycle change names are read. A test build also
//! compares every table and fails when a write reached state without one.

use std::collections::{BTreeMap, BTreeSet};

use super::apply::{Event, Fact, Lifecycle, Synced};
use super::solve::{Bodies, Solved};
use super::{
    Actor, ActorId, BodyId, Entity, Extraction, Gate, GateId, GroundItem, Hook, HookId, ItemId,
    Point, Projectile, ProjectileId, State, Tick, Trap, TrapId,
};

/// A body that moved without the solver, so a viewer must not interpolate across it.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Discontinuity {
    /// Entered the world in this apply: an admission, a respawn, a landing or a drop.
    Placed(BodyId),
    /// Set to a new pose by a warp or a teleport.
    Warped(BodyId),
    /// Left the world: an escape, a departure, an elimination, a stranding or a pickup.
    Removed(BodyId),
    /// A committed developer teleport, identified by its inbound teleport ordinal.
    DevWarped { body: BodyId, request: u32 },
}

/// A dynamic body's committed pose: where it is, its rotation, its motion and whether Rapier
/// has put it to sleep. A viewer draws and corrects from it (26's body presentation).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pose {
    pub at: Point,
    pub angle: f64,
    pub velocity: Point,
    pub spin: f64,
    pub sleeping: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Changes {
    pub actors: BTreeMap<ActorId, Actor>,
    pub items: BTreeMap<ItemId, GroundItem>,
    pub projectiles: BTreeMap<ProjectileId, Projectile>,
    pub hooks: BTreeMap<HookId, Hook>,
    pub gates: BTreeMap<GateId, Gate>,
    pub traps: BTreeMap<TrapId, Trap>,
    /// Present when the remaining slots changed.
    pub extraction: Option<Extraction>,
    /// Present when the wall moved.
    pub hazard_x: Option<f64>,
    /// Ground items, projectiles and hooks that left their tables, in entity order.
    pub removed: Vec<Entity>,
    /// Dynamic bodies' committed poses that changed (position, rotation, motion or sleep) or
    /// entered the world.
    pub poses: BTreeMap<BodyId, Pose>,
    /// T's events in canonical order (A6), published after apply commits.
    pub events: Vec<Event>,
}

/// The whole state at the close of a tick, with every dynamic body's pose: a recording
/// keyframe and a snapshot on request.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub tick: Tick,
    pub state: State,
    pub poses: BTreeMap<BodyId, Pose>,
}

impl Snapshot {
    /// The mirror's one applier: the previous tick's snapshot becomes this tick's.
    pub fn apply(&mut self, tick: Tick, changes: &Changes, discontinuities: &[Discontinuity]) {
        let state = &mut self.state;
        state.actors.extend(changes.actors.clone());
        state.items.extend(changes.items.clone());
        state.projectiles.extend(changes.projectiles.clone());
        state.hooks.extend(changes.hooks.clone());
        state.gates.extend(changes.gates.clone());
        state.traps.extend(changes.traps.clone());
        if changes.extraction.is_some() {
            state.extraction = changes.extraction;
        }
        if let Some(x) = changes.hazard_x {
            state.hazard_x = Some(x);
        }
        for removed in &changes.removed {
            match *removed {
                Entity::Item(id) => {
                    state.items.remove(&id);
                }
                Entity::Projectile(id) => {
                    state.projectiles.remove(&id);
                }
                Entity::Hook(id) => {
                    state.hooks.remove(&id);
                }
                other => unreachable!("{other:?} is never removed"),
            }
        }
        for marker in discontinuities {
            if let Discontinuity::Removed(body) = *marker {
                self.poses.remove(&body);
            }
        }
        self.poses.extend(&changes.poses);
        self.tick = tick;
    }
}

/// What the change list compares against: the tick-start records of the active set. The test
/// build also keeps the whole state.
pub(super) struct Before {
    actors: BTreeMap<ActorId, Actor>,
    projectiles: BTreeMap<ProjectileId, Projectile>,
    hooks: BTreeMap<HookId, Hook>,
    extraction: Option<Extraction>,
    hazard_x: Option<f64>,
    #[cfg(test)]
    whole: State,
}

impl Before {
    pub(super) fn new(state: &State) -> Self {
        Self {
            actors: state.actors.clone(),
            projectiles: state.projectiles.clone(),
            hooks: state.hooks.clone(),
            extraction: state.extraction,
            hazard_x: state.hazard_x,
            #[cfg(test)]
            whole: state.clone(),
        }
    }
}

/// The map-sized records apply wrote, named by its lifecycle changes and facts.
#[derive(Default)]
pub(super) struct Touched {
    items: BTreeSet<ItemId>,
    gates: BTreeSet<GateId>,
    traps: BTreeSet<TrapId>,
}

impl Touched {
    pub(super) fn lifecycle(&mut self, lifecycle: &[Lifecycle]) {
        for change in lifecycle {
            match *change {
                Lifecycle::RemoveItem(id) => {
                    self.items.insert(id);
                }
                Lifecycle::SyncGate(id) => {
                    self.gates.insert(id);
                }
                Lifecycle::UpdateTrap { id, .. } => {
                    self.traps.insert(id);
                }
                _ => {}
            }
        }
    }

    fn facts(&mut self, facts: &[Fact]) {
        for fact in facts {
            match *fact {
                Fact::Pickup { item, .. }
                | Fact::Placed {
                    placed: Entity::Item(item),
                    ..
                } => {
                    self.items.insert(item);
                }
                Fact::GateChanged { gate, .. } => {
                    self.gates.insert(gate);
                }
                _ => {}
            }
        }
    }
}

fn changed<K: Ord + Copy, V: Clone + PartialEq>(
    before: &BTreeMap<K, V>,
    after: &BTreeMap<K, V>,
    removed: &mut Vec<Entity>,
    entity: impl Fn(K) -> Entity,
) -> BTreeMap<K, V> {
    removed.extend(
        before
            .keys()
            .filter(|id| !after.contains_key(id))
            .map(|&id| entity(id)),
    );
    after
        .iter()
        .filter(|&(id, record)| before.get(id) != Some(record))
        .map(|(&id, record)| (id, record.clone()))
        .collect()
}

fn named<K: Ord + Copy, V: Clone>(
    ids: &BTreeSet<K>,
    after: &BTreeMap<K, V>,
    removed: &mut Vec<Entity>,
    entity: impl Fn(K) -> Entity,
) -> BTreeMap<K, V> {
    let mut records = BTreeMap::new();
    for &id in ids {
        match after.get(&id) {
            Some(record) => {
                records.insert(id, record.clone());
            }
            None => removed.push(entity(id)),
        }
    }
    records
}

#[allow(clippy::too_many_arguments)]
pub(super) fn changes(
    before: Before,
    mut touched: Touched,
    state: &State,
    bodies: &mut Bodies,
    solved: &Solved,
    synced: &[Synced],
    facts: &[Fact],
    events: Vec<Event>,
) -> (Changes, Vec<Discontinuity>) {
    touched.facts(facts);
    let mut removed = Vec::new();
    let actors = changed(&before.actors, &state.actors, &mut removed, Entity::Actor);
    let projectiles = changed(
        &before.projectiles,
        &state.projectiles,
        &mut removed,
        Entity::Projectile,
    );
    let hooks = changed(&before.hooks, &state.hooks, &mut removed, Entity::Hook);
    // An item placed in T cannot be claimed until T+1, so a named item missing now was in S0.
    let items = named(&touched.items, &state.items, &mut removed, Entity::Item);
    let gates = named(&touched.gates, &state.gates, &mut removed, Entity::Gate);
    let traps = named(&touched.traps, &state.traps, &mut removed, Entity::Trap);
    removed.sort_unstable();

    let mut discontinuities = Vec::new();
    let mut moved: BTreeSet<BodyId> = solved.bodies().collect();
    for sync in synced {
        for &body in &sync.placed {
            discontinuities.push(Discontinuity::Placed(body));
            moved.insert(body);
        }
        for &body in &sync.warped {
            discontinuities.push(Discontinuity::Warped(body));
            moved.insert(body);
        }
        for &body in &sync.despawned {
            if !matches!(body, BodyId::Gate(_)) {
                discontinuities.push(Discontinuity::Removed(body));
            }
        }
    }
    discontinuities.sort_unstable();
    discontinuities.dedup();
    let mut poses = BTreeMap::new();
    for body in moved {
        if !bodies.is_dynamic(body) {
            continue;
        }
        let Some(after) = bodies.pose(body) else {
            continue;
        };
        let start = solved.start(body);
        let entered = discontinuities.iter().any(|marker| {
            matches!(*marker, Discontinuity::Placed(id) | Discontinuity::Warped(id) if id == body)
        });
        if entered || start != Some(after) {
            poses.insert(body, after);
        }
    }

    let changes = Changes {
        actors,
        items,
        projectiles,
        hooks,
        gates,
        traps,
        extraction: (state.extraction != before.extraction)
            .then_some(state.extraction)
            .flatten(),
        hazard_x: state.hazard_x.filter(|_| state.hazard_x != before.hazard_x),
        removed,
        poses,
        events,
    };
    #[cfg(test)]
    check_complete(&before.whole, state, &changes);
    (changes, discontinuities)
}

/// Test builds only: the change list holds every write to every table.
#[cfg(test)]
fn check_complete(before: &State, after: &State, changes: &Changes) {
    let mut expected = Vec::new();
    let mut full = |name: &str, missing: bool| {
        if missing {
            expected.push(name.to_owned());
        }
    };
    let mut removed = Vec::new();
    full(
        "items",
        changed(&before.items, &after.items, &mut removed, Entity::Item) != changes.items,
    );
    full(
        "gates",
        changed(&before.gates, &after.gates, &mut removed, Entity::Gate) != changes.gates,
    );
    full(
        "traps",
        changed(&before.traps, &after.traps, &mut removed, Entity::Trap) != changes.traps,
    );
    full("stations", before.stations != after.stations);
    full("sensors", before.sensors != after.sensors);
    changed(
        &before.projectiles,
        &after.projectiles,
        &mut removed,
        Entity::Projectile,
    );
    changed(&before.hooks, &after.hooks, &mut removed, Entity::Hook);
    removed.sort_unstable();
    full("removed", removed != changes.removed);
    assert!(
        expected.is_empty(),
        "the change list misses writes to {expected:?}"
    );
}
