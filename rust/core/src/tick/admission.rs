//! Who may receive what (27.2 "The core's projection (#1357 …)"): for one viewer at the last
//! completed tick, the records it may be sent. The rules are those of the TypeScript `projectView`
//! (`visibility.ts`, `physics-presentation.ts`, `ground-items.ts`), which this must equal on every
//! viewer and tick.
//!
//! Everything here is derived from the core's own output. Items, props and traps are map-sized,
//! so they sit in a uniform grid kept from each completed tick's changes, and a viewer reads the
//! cells around it. Actors, hooks, projectiles and effects are the active set and are read as
//! they are.

use std::collections::{BTreeMap, BTreeSet};

use super::output::{Changes, Discontinuity, Pose};
use super::presentation::Presentation;
use super::{
    ActorId, ActorKind, BodyId, BodySpec, Entity, HookId, HookPhase, ItemId, Point, Presence,
    ProjectileId, State, Status, TrapId,
};
use crate::math::hypot;
use crate::physics::{SHAPE_BOX, SHAPE_CIRCLE};

/// A cell's side. Any size answers a query exactly; this one keeps a viewer's reach to a few
/// cells.
const CELL: f64 = 256.0;

/// A loot body's radius when the setup holds no item body to read it from (`placement.rs`).
const LOOT_RADIUS: f64 = 6.0;

type Cell = (i64, i64);

fn cell_of(at: Point) -> Cell {
    ((at[0] / CELL).floor() as i64, (at[1] / CELL).floor() as i64)
}

/// Points by key, and the keys by cell.
pub(super) struct Grid<K: Copy + Ord> {
    at: BTreeMap<K, (Point, Cell)>,
    cells: BTreeMap<Cell, BTreeSet<K>>,
}

impl<K: Copy + Ord> Default for Grid<K> {
    fn default() -> Self {
        Self {
            at: BTreeMap::new(),
            cells: BTreeMap::new(),
        }
    }
}

impl<K: Copy + Ord> Grid<K> {
    pub(super) fn set(&mut self, key: K, at: Point) {
        self.remove(key);
        let cell = cell_of(at);
        self.cells.entry(cell).or_default().insert(key);
        self.at.insert(key, (at, cell));
    }

    pub(super) fn remove(&mut self, key: K) {
        if let Some((_, cell)) = self.at.remove(&key)
            && let Some(keys) = self.cells.get_mut(&cell)
        {
            keys.remove(&key);
            if keys.is_empty() {
                self.cells.remove(&cell);
            }
        }
    }

    pub(super) fn position(&self, key: K) -> Option<Point> {
        self.at.get(&key).map(|&(at, _)| at)
    }

    /// The candidates for a viewer at `from`, if it stands anywhere known.
    fn around(&self, from: Option<Point>, reach: f64, widest: f64) -> Vec<K> {
        from.map_or_else(Vec::new, |from| self.near(from, reach + widest))
    }

    /// Every key whose cell the square of half-side `reach` around `at` touches: a superset of
    /// those within `reach`, in no useful order.
    fn near(&self, at: Point, reach: f64) -> Vec<K> {
        if !reach.is_finite() || !at[0].is_finite() || !at[1].is_finite() {
            return self.at.keys().copied().collect();
        }
        let (x0, y0) = cell_of([at[0] - reach, at[1] - reach]);
        let (x1, y1) = cell_of([at[0] + reach, at[1] + reach]);
        let mut out = Vec::new();
        for x in x0..=x1 {
            for keys in self.cells.range((x, y0)..=(x, y1)).map(|(_, keys)| keys) {
                out.extend(keys.iter().copied());
            }
        }
        out
    }
}

/// How far each kind of drawn body reaches from its centre (`bodyRadius`).
#[derive(Default)]
pub struct Radii {
    loot: Option<f64>,
    props: BTreeMap<u32, f64>,
}

impl Radii {
    /// The radii of a setup's bodies. The frame draws every item with one loot shape, so the
    /// first item body's radius stands for all of them.
    pub fn of<'a>(bodies: impl IntoIterator<Item = &'a (BodyId, BodySpec)>) -> Self {
        let mut radii = Self::default();
        for (id, spec) in bodies {
            match *id {
                BodyId::Item(_) => {
                    radii.loot.get_or_insert_with(|| radius(spec));
                }
                BodyId::Prop(prop) => {
                    radii.props.insert(prop, radius(spec));
                }
                _ => {}
            }
        }
        radii
    }
}

/// `bodyRadius` of a spec's shape: a circle's radius, a box's half-diagonal, a convex shape's
/// farthest vertex.
pub fn radius(spec: &BodySpec) -> f64 {
    let [a, b] = spec.dimensions;
    match spec.shape {
        SHAPE_CIRCLE => a,
        SHAPE_BOX => hypot(a, b),
        _ => spec
            .vertices
            .as_chunks::<2>()
            .0
            .iter()
            .map(|[x, y]| hypot(*x, *y))
            .fold(0.0, f64::max),
    }
}

/// The map-sized records, by where they are.
#[derive(Default)]
pub(super) struct Spatial {
    /// Every drawn body's committed pose: actors, items and props.
    poses: BTreeMap<BodyId, Point>,
    /// Where each ground item is: its body, or where it is stored without one.
    items: Grid<ItemId>,
    props: Grid<u32>,
    traps: Grid<TrapId>,
    loot_radius: f64,
    prop_radius: BTreeMap<u32, f64>,
    widest_prop: f64,
}

impl Spatial {
    pub(super) fn start(state: &State, poses: &BTreeMap<BodyId, Pose>, radii: Radii) -> Self {
        let widest_prop = radii.props.values().copied().fold(0.0, f64::max);
        let mut space = Self {
            loot_radius: radii.loot.unwrap_or(LOOT_RADIUS),
            prop_radius: radii.props,
            widest_prop,
            ..Self::default()
        };
        for (&body, pose) in poses {
            space.pose(body, pose.at);
        }
        for (&id, item) in &state.items {
            let body = poses.get(&BodyId::Item(id)).map(|pose| pose.at);
            if let Some(at) = item.position(body) {
                space.items.set(id, at);
            }
        }
        for (&id, trap) in &state.traps {
            space.traps.set(id, trap.position);
        }
        space
    }

    fn pose(&mut self, body: BodyId, at: Point) {
        match body {
            BodyId::Actor(_) | BodyId::Item(_) => {}
            BodyId::Prop(prop) => self.props.set(prop, at),
            _ => return,
        }
        self.poses.insert(body, at);
    }

    /// A completed tick, as `tick-frame.ts`'s `take` folds it: removals, then each record's
    /// place, then the bodies' own.
    pub(super) fn take(&mut self, changes: &Changes, discontinuities: &[Discontinuity]) {
        for removed in &changes.removed {
            if let Entity::Item(id) = *removed {
                self.items.remove(id);
            }
        }
        for (&id, item) in &changes.items {
            let body = changes.poses.get(&BodyId::Item(id)).map(|pose| pose.at);
            if let Some(at) = item
                .unplaced_at
                .or(body)
                .or_else(|| self.items.position(id))
            {
                self.items.set(id, at);
            }
        }
        for (&body, pose) in &changes.poses {
            if let BodyId::Item(id) = body
                && !changes.items.contains_key(&id)
                && self.items.position(id).is_some()
            {
                self.items.set(id, pose.at);
            }
        }
        for &marker in discontinuities {
            if let Discontinuity::Removed(body) = marker {
                self.poses.remove(&body);
                if let BodyId::Prop(prop) = body {
                    self.props.remove(prop);
                }
            }
        }
        for (&body, pose) in &changes.poses {
            self.pose(body, pose.at);
        }
        for (&id, trap) in &changes.traps {
            self.traps.set(id, trap.position);
        }
    }
}

/// One contestant's discovered cells: in the order they were learned, and as a set to tell new
/// from known. Cells are only ever learned.
#[derive(Default)]
pub(super) struct Learned {
    order: Vec<u32>,
    known: BTreeSet<u32>,
}

impl Learned {
    pub(super) fn learn(&mut self, cells: &BTreeSet<u32>) {
        for &cell in cells {
            if self.known.insert(cell) {
                self.order.push(cell);
            }
        }
    }

    pub(super) fn cells(&self) -> &[u32] {
        &self.order
    }
}

/// The cells from the `held`th on: what a caller holding that many of the learned order lacks.
pub fn since(cells: &[u32], held: usize) -> &[u32] {
    cells.get(held..).unwrap_or(&[])
}

/// What one viewer may receive, each list in the order the wire reads it.
#[derive(Debug, Default, PartialEq)]
pub struct Admitted {
    /// By actor.
    pub players: Vec<ActorId>,
    /// Ground items, ascending.
    pub items: Vec<ItemId>,
    /// In body order.
    pub bodies: Vec<BodyId>,
    /// Hooks pulling, ascending.
    pub tethers: Vec<HookId>,
    /// Hooks flying, ascending.
    pub flights: Vec<HookId>,
    pub traps: Vec<TrapId>,
    pub projectiles: Vec<ProjectileId>,
    /// Indices into the live effects, ascending.
    pub effects: Vec<u32>,
}

impl Presentation {
    /// What `viewer` may receive at the last completed tick, from within `reach`. With `stranded`,
    /// every contestant still active is stranded, so not active.
    pub fn admit(&self, state: &State, viewer: ActorId, reach: f64, stranded: bool) -> Admitted {
        let space = &self.space;
        let from = self.at(viewer);
        // Whether a point is within reach of the viewer, widened by `extra`. Nothing is, when the
        // viewer stands nowhere known.
        let near = |at: Option<Point>, extra: f64| match (from, at) {
            (Some(from), Some(at)) => hypot(from[0] - at[0], from[1] - at[1]) < reach + extra,
            _ => false,
        };
        let players: Vec<ActorId> = state
            .actors
            .iter()
            .filter(|&(&id, actor)| {
                let active = actor.presence == Presence::Active
                    && !(stranded && id.kind == ActorKind::Contestant);
                id == viewer
                    || !active
                    || viewer.kind == ActorKind::Gladiator
                        && actor
                            .statuses
                            .get(&Status::Reveal)
                            .is_some_and(|window| window.expires_at > self.tick)
                    || near(self.at(id), 0.0)
            })
            .map(|(&id, _)| id)
            .collect();
        let admitted: BTreeSet<ActorId> = players.iter().copied().collect();
        let mut items: Vec<ItemId> = space
            .items
            .around(from, reach, 0.0)
            .into_iter()
            .filter(|&id| near(space.items.position(id), 0.0))
            .collect();
        items.sort();
        let mut bodies = BTreeSet::new();
        for &actor in &players {
            if space.poses.contains_key(&BodyId::Actor(actor)) {
                bodies.insert(BodyId::Actor(actor));
            }
        }
        for &id in &items {
            let body = BodyId::Item(id);
            if near(space.poses.get(&body).copied(), space.loot_radius) {
                bodies.insert(body);
            }
        }
        for id in space.props.around(from, reach, space.widest_prop) {
            let radius = space.prop_radius.get(&id).copied().unwrap_or(0.0);
            if near(space.props.position(id), radius) {
                bodies.insert(BodyId::Prop(id));
            }
        }
        let has_body = |actor: ActorId| space.poses.contains_key(&BodyId::Actor(actor));
        let (mut tethers, mut flights) = (Vec::new(), Vec::new());
        for (&id, hook) in &state.hooks {
            if !has_body(hook.owner) {
                continue;
            }
            match hook.phase {
                HookPhase::Pulling { target, .. } => {
                    if has_body(target)
                        && admitted.contains(&hook.owner)
                        && admitted.contains(&target)
                    {
                        tethers.push(id);
                    }
                }
                HookPhase::Flying { position, .. } => {
                    if admitted.contains(&hook.owner) && near(Some(position), 0.0) {
                        flights.push(id);
                    }
                }
            }
        }
        let mut traps: Vec<TrapId> = space
            .traps
            .around(from, reach, 0.0)
            .into_iter()
            .filter(|&id| near(space.traps.position(id), 0.0))
            .collect();
        traps.sort();
        let projectiles = state
            .projectiles
            .iter()
            .filter(|(_, shot)| near(Some(shot.position), 0.0))
            .map(|(&id, _)| id)
            .collect();
        let effects = self
            .effects()
            .iter()
            .enumerate()
            .filter(|(_, effect)| near(Some(effect.at), effect.radius))
            .map(|(index, _)| index as u32)
            .collect();
        Admitted {
            players,
            items,
            bodies: bodies.into_iter().collect(),
            tethers,
            flights,
            traps,
            projectiles,
            effects,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::presentation::Effect;
    use super::super::{Actor, GroundItem, Hook, Loot, Memory, Projectile, Trap, TrapKind, Window};
    use super::*;

    const V: ActorId = ActorId {
        kind: ActorKind::Contestant,
        seat: 0,
    };
    const P: ActorId = ActorId {
        kind: ActorKind::Contestant,
        seat: 1,
    };
    const G: ActorId = ActorId {
        kind: ActorKind::Gladiator,
        seat: 0,
    };
    const REACH: f64 = 100.0;

    fn actor(presence: Presence) -> Actor {
        Actor {
            presence,
            kit: None,
            level: 1,
            kills: 0,
            hp: 100.0,
            max_hp: 100.0,
            shield: 0.0,
            max_shield: 0.0,
            aim: 0.0,
            sneak: false,
            view_lag: 0,
            inventory: Default::default(),
            charging: None,
            respawn_at: None,
            transit: None,
            bot: false,
            aggression: None,
            deadlines: Default::default(),
            statuses: BTreeMap::new(),
        }
    }

    fn pose(at: Point) -> Pose {
        Pose {
            at,
            ..Pose::default()
        }
    }

    fn item(unplaced_at: Option<Point>) -> GroundItem {
        GroundItem {
            building: None,
            loot: Loot::AccessKey,
            lineage: None,
            unplaced_at,
            dropped_by: None,
            pickup_ready_at: 0,
        }
    }

    fn trap(at: Point) -> Trap {
        Trap {
            position: at,
            heading: 0.0,
            ready_at: 0,
            kind: TrapKind::Mine { spent: false },
        }
    }

    fn radii() -> Radii {
        Radii {
            loot: Some(6.0),
            props: BTreeMap::from([(0, 20.0)]),
        }
    }

    /// V at the origin, P at `(x, 0)`, both with bodies.
    fn world(x: f64) -> (State, Presentation) {
        let mut state = State::default();
        state.actors.insert(V, actor(Presence::Active));
        state.actors.insert(P, actor(Presence::Active));
        state.actors.insert(G, actor(Presence::Active));
        let poses = BTreeMap::from([
            (BodyId::Actor(V), pose([0.0, 0.0])),
            (BodyId::Actor(P), pose([x, 0.0])),
            (BodyId::Actor(G), pose([5000.0, 0.0])),
        ]);
        let presented = Presentation::start(&state, &poses, radii());
        (state, presented)
    }

    fn tick(
        presented: &mut Presentation,
        state: &State,
        changes: &Changes,
        gone: &[Discontinuity],
    ) {
        let tick = presented.tick + 1;
        presented.take(tick, changes, gone, state, 0.0);
    }

    #[test]
    fn a_player_is_admitted_by_reach_and_the_viewer_itself() {
        let (state, presented) = world(REACH - 1.0);
        let seen = presented.admit(&state, V, REACH, false);
        assert_eq!(seen.players, vec![V, P]);
        let (state, presented) = world(REACH);
        assert_eq!(presented.admit(&state, V, REACH, false).players, vec![V]);
    }

    #[test]
    fn a_reveal_shows_a_contestant_to_a_gladiator_at_any_range() {
        let (mut state, mut presented) = world(2000.0);
        state.actors.get_mut(&P).unwrap().statuses.insert(
            Status::Reveal,
            Window {
                active_from: 0,
                expires_at: 3,
            },
        );
        assert_eq!(presented.admit(&state, G, REACH, false).players, vec![P, G]);
        let gone = Changes::default();
        tick(&mut presented, &state, &gone, &[]);
        tick(&mut presented, &state, &gone, &[]);
        // Live while `expires_at > T`: the window that ends at 3 shows at 2 and not at 3.
        assert_eq!(presented.admit(&state, G, REACH, false).players, vec![P, G]);
        tick(&mut presented, &state, &gone, &[]);
        assert_eq!(presented.admit(&state, G, REACH, false).players, vec![G]);
        // A contestant never gets the reveal.
        assert_eq!(presented.admit(&state, V, REACH, false).players, vec![V]);
    }

    #[test]
    fn a_player_not_active_is_always_admitted_and_a_strand_makes_contestants_so() {
        let (mut state, presented) = world(5000.0);
        assert_eq!(presented.admit(&state, V, REACH, false).players, vec![V]);
        // Stranded: every active contestant, not the gladiator.
        assert_eq!(presented.admit(&state, V, REACH, true).players, vec![V, P]);
        state.actors.get_mut(&P).unwrap().presence = Presence::Eliminated;
        assert_eq!(presented.admit(&state, V, REACH, false).players, vec![V, P]);
    }

    #[test]
    fn an_actor_body_follows_its_player_and_an_item_body_needs_its_item() {
        let (mut state, mut presented) = world(REACH + 50.0);
        // An item just out of reach whose body reaches it: its item is not admitted, so it is not.
        state.items.insert(ItemId(1), item(None));
        state.items.insert(ItemId(2), item(None));
        let mut changes = Changes::default();
        changes.items.insert(ItemId(1), item(None));
        changes.items.insert(ItemId(2), item(None));
        changes
            .poses
            .insert(BodyId::Item(ItemId(1)), pose([REACH + 3.0, 0.0]));
        changes
            .poses
            .insert(BodyId::Item(ItemId(2)), pose([REACH - 3.0, 0.0]));
        tick(&mut presented, &state, &changes, &[]);
        let seen = presented.admit(&state, V, REACH, false);
        assert_eq!(seen.items, vec![ItemId(2)]);
        assert_eq!(seen.bodies, vec![BodyId::Actor(V), BodyId::Item(ItemId(2))]);
    }

    #[test]
    fn a_prop_body_reaches_by_its_radius() {
        let (state, mut presented) = world(5000.0);
        let mut changes = Changes::default();
        changes
            .poses
            .insert(BodyId::Prop(0), pose([REACH + 19.0, 0.0]));
        changes
            .poses
            .insert(BodyId::Prop(1), pose([REACH + 19.0, 0.0]));
        tick(&mut presented, &state, &changes, &[]);
        // Prop 0 has radius 20; prop 1 has no recorded radius.
        let seen = presented.admit(&state, V, REACH, false);
        assert_eq!(seen.bodies, vec![BodyId::Actor(V), BodyId::Prop(0)]);
        let gone = [Discontinuity::Removed(BodyId::Prop(0))];
        tick(&mut presented, &state, &Changes::default(), &gone);
        let seen = presented.admit(&state, V, REACH, false);
        assert_eq!(seen.bodies, vec![BodyId::Actor(V)]);
    }

    #[test]
    fn a_tether_needs_both_ends_and_a_flight_is_ranged() {
        let (mut state, presented) = world(REACH - 1.0);
        state.actors.get_mut(&G).unwrap().presence = Presence::Eliminated;
        state.hooks.insert(
            HookId(1),
            Hook {
                owner: V,
                phase: HookPhase::Pulling {
                    target: P,
                    length: 10.0,
                },
                expires_at: 99,
            },
        );
        state.hooks.insert(
            HookId(2),
            Hook {
                owner: V,
                phase: HookPhase::Flying {
                    position: [REACH - 1.0, 0.0],
                    direction: [1.0, 0.0],
                    travelled: 0.0,
                },
                expires_at: 99,
            },
        );
        state.hooks.insert(
            HookId(3),
            Hook {
                owner: P,
                phase: HookPhase::Flying {
                    position: [REACH - 2.0, 0.0],
                    direction: [1.0, 0.0],
                    travelled: 0.0,
                },
                expires_at: 99,
            },
        );
        let seen = presented.admit(&state, V, REACH, false);
        assert_eq!(seen.tethers, vec![HookId(1)]);
        assert_eq!(seen.flights, vec![HookId(2), HookId(3)]);
        // Tethered to a target out of reach: the target is no player here, so no tether.
        let (mut far, presented) = world(5000.0);
        far.hooks = state.hooks.clone();
        let seen = presented.admit(&far, V, REACH, false);
        assert_eq!(seen.tethers, Vec::<HookId>::new());
        // A flight needs its owner admitted as well as the hook in reach.
        assert_eq!(seen.flights, vec![HookId(2)]);
    }

    #[test]
    fn traps_projectiles_and_effects_are_ranged() {
        let (mut state, mut presented) = world(5000.0);
        state.traps.insert(TrapId(0), trap([REACH - 1.0, 0.0]));
        state.traps.insert(TrapId(1), trap([REACH, 0.0]));
        let shot = |x: f64| Projectile {
            source: Entity::Actor(P),
            position: [x, 0.0],
            velocity: [0.0; 2],
            damage: 1.0,
            active_from: 0,
            expires_at: 99,
        };
        state.projectiles.insert(ProjectileId(0), shot(REACH));
        state.projectiles.insert(ProjectileId(1), shot(REACH - 1.0));
        let changes = Changes {
            traps: state.traps.clone(),
            ..Changes::default()
        };
        tick(&mut presented, &state, &changes, &[]);
        let seen = presented.admit(&state, V, REACH, false);
        assert_eq!(seen.traps, vec![TrapId(0)]);
        assert_eq!(seen.projectiles, vec![ProjectileId(1)]);
    }

    #[test]
    fn an_effect_reaches_by_its_radius() {
        let (state, mut presented) = world(5000.0);
        let mut events = Changes::default();
        events.events.push(super::super::Event {
            id: 0,
            tick: 1,
            fact: super::super::Fact::WardenPulsed { actor: P },
        });
        // A pulse is drawn where its actor stands, 5000 away; the effect's radius is 130.
        tick(&mut presented, &state, &events, &[]);
        assert_eq!(presented.effects().len(), 1);
        assert!(presented.admit(&state, V, REACH, false).effects.is_empty());
        let (state, mut presented) = world(REACH + 129.0);
        tick(&mut presented, &state, &events, &[]);
        let Effect { radius, .. } = presented.effects()[0];
        assert_eq!(radius, 130.0);
        assert_eq!(presented.admit(&state, V, REACH, false).effects, vec![0]);
        let (state, mut presented) = world(REACH + 130.0);
        tick(&mut presented, &state, &events, &[]);
        assert!(presented.admit(&state, V, REACH, false).effects.is_empty());
    }

    #[test]
    fn the_grid_follows_a_moved_item_and_a_removed_one() {
        let (mut state, mut presented) = world(5000.0);
        state.items.insert(ItemId(1), item(Some([1000.0, 0.0])));
        let mut changes = Changes::default();
        changes.items.insert(ItemId(1), item(Some([1000.0, 0.0])));
        tick(&mut presented, &state, &changes, &[]);
        assert!(presented.admit(&state, V, REACH, false).items.is_empty());
        // It is placed with a body near the viewer.
        state.items.insert(ItemId(1), item(None));
        let mut placed = Changes::default();
        placed.items.insert(ItemId(1), item(None));
        placed
            .poses
            .insert(BodyId::Item(ItemId(1)), pose([10.0, 0.0]));
        tick(&mut presented, &state, &placed, &[]);
        assert_eq!(
            presented.admit(&state, V, REACH, false).items,
            vec![ItemId(1)]
        );
        // The body moves with its record unchanged, across cells, out of reach.
        let mut moved = Changes::default();
        moved
            .poses
            .insert(BodyId::Item(ItemId(1)), pose([-900.0, 400.0]));
        tick(&mut presented, &state, &moved, &[]);
        assert!(presented.admit(&state, V, REACH, false).items.is_empty());
        let mut back = Changes::default();
        back.poses
            .insert(BodyId::Item(ItemId(1)), pose([-60.0, 0.0]));
        tick(&mut presented, &state, &back, &[]);
        assert_eq!(
            presented.admit(&state, V, REACH, false).items,
            vec![ItemId(1)]
        );
        // Picked up: the record and the body are gone.
        let mut gone = Changes::default();
        gone.removed.push(Entity::Item(ItemId(1)));
        state.items.clear();
        tick(
            &mut presented,
            &state,
            &gone,
            &[Discontinuity::Removed(BodyId::Item(ItemId(1)))],
        );
        let seen = presented.admit(&state, V, REACH, false);
        assert!(seen.items.is_empty());
        assert_eq!(seen.bodies, vec![BodyId::Actor(V)]);
    }

    #[test]
    fn cells_are_learned_in_order_across_refreshes() {
        let (_, mut presented) = world(5000.0);
        assert_eq!(presented.learned(V), None);
        let mut memory = Memory::default();
        memory.discovered.extend([9, 3]);
        presented.learn(V, Some(&memory));
        assert_eq!(presented.learned(V), Some(&[3, 9][..]));
        // A later refresh appends what is new, ascending, behind what was learned.
        memory.discovered.extend([1, 5, 12]);
        presented.learn(V, Some(&memory));
        assert_eq!(presented.learned(V), Some(&[3, 9, 1, 5, 12][..]));
        presented.learn(V, Some(&memory));
        assert_eq!(presented.learned(V), Some(&[3, 9, 1, 5, 12][..]));
        // No memory learns nothing.
        presented.learn(G, None);
        assert_eq!(presented.learned(G), None);
    }

    #[test]
    fn held_cells_are_sliced_off_the_front() {
        let cells = [3, 9, 1, 5];
        assert_eq!(since(&cells, 0), &cells);
        assert_eq!(since(&cells, 3), &[5]);
        assert_eq!(since(&cells, 4), &[] as &[u32]);
        assert_eq!(since(&cells, 9), &[] as &[u32]);
    }

    #[test]
    fn a_stand_is_taken_only_when_none_is_known() {
        let (state, mut presented) = world(10.0);
        presented.stand(V, [999.0, 999.0]);
        assert_eq!(presented.at(V), Some([0.0, 0.0]));
        let mut state = state;
        let lone = ActorId {
            kind: ActorKind::Contestant,
            seat: 7,
        };
        state.actors.insert(lone, actor(Presence::Active));
        presented.stand(lone, [30.0, 0.0]);
        presented.stand(lone, [999.0, 999.0]);
        assert_eq!(presented.at(lone), Some([30.0, 0.0]));
        assert!(
            presented
                .admit(&state, V, REACH, false)
                .players
                .contains(&lone)
        );
    }
}
