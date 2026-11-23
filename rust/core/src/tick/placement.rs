use std::collections::BTreeMap;

use crate::math::{cos, hypot, sin};
use crate::physics::{BodyParams, KIND_PROP, LOOT_GROUP, SHAPE_CIRCLE};
use crate::world::MAX_DYNAMIC;

use super::interaction::RAIL_COOLDOWN;
use super::*;

const LOOT_RADIUS: f64 = 6.0;
const DROP_CLEARANCE: f64 = 16.0;
const RESPAWN_CLEARANCE: f64 = 25.0;
const RESPAWN_WALL_MARGIN: f64 = 400.0;
const RESPAWN_CONTESTANT_DISTANCE: f64 = 1000.0;
const PLACEMENT_CONTEST: u64 = 0x706c_6163_6500_0000;

enum Request {
    Drop(DropRequest),
    Activate(ActorId, ActorArrival),
    InstantRail(ActorId, Transit),
    PendingItem(ItemId, Point),
}

impl Request {
    fn key(&self) -> SpawnKey {
        let (source, ordinal) = match *self {
            Self::Drop(drop) => (Entity::Actor(drop.owner), u64::from(drop.ordinal())),
            Self::Activate(id, _) | Self::InstantRail(id, _) => (Entity::Actor(id), u64::MAX),
            Self::PendingItem(id, _) => (Entity::Item(id), 0),
        };
        SpawnKey { source, ordinal }
    }

    fn rank(&self, view: ClaimView<'_>) -> (u64, SpawnKey) {
        let key = self.key();
        let (domain, id) = match key.source {
            Entity::Actor(actor) => (0, actor_word(actor)),
            Entity::Item(id) => (1, u64::from(id.0)),
            _ => unreachable!("placement request source"),
        };
        (
            contest_score(
                view.seed,
                view.tick,
                PLACEMENT_CONTEST ^ key.ordinal.rotate_left(16) ^ domain,
                id,
            ),
            key,
        )
    }
}

/// One permutation for body placement after claims. Swap reservations are already in the field.
pub(super) fn place(
    state: &mut State,
    view: ClaimView<'_>,
    items: &ItemRules,
    placement: Placement<DropRequest>,
    commit: &mut Commit,
) -> BTreeMap<SpawnKey, Spawn> {
    let mut reserved = placement.reserved;
    let mut requests: Vec<_> = placement.pending.into_iter().map(Request::Drop).collect();
    requests.extend(state.actors.iter().filter_map(|(&id, actor)| {
        match actor.presence {
            Presence::Pending
                if id.kind == ActorKind::Gladiator
                    && actor.respawn_at.is_some_and(|due| due <= view.tick) =>
            {
                Some(Request::Activate(id, ActorArrival::Respawn))
            }
            Presence::Transit => actor
                .transit
                .filter(|ride| ride.arrive_at <= view.tick)
                .map(|ride| Request::Activate(id, ActorArrival::Transit(ride.destination))),
            _ => None,
        }
    }));
    let mut awaiting = state
        .items
        .iter()
        .filter_map(|(&id, item)| item.unplaced_at.map(|at| Request::PendingItem(id, at)))
        .peekable();
    // Claims have finished freeing slots. Placement can only fill them or move a body. Pending
    // item bodies stop short of the drop reserve and a slot for every actor that may return, so
    // map loot never takes the room drops and arrivals need (#523).
    let item_limit = items.drops.item_limit(state);
    let mut items_full = awaiting.peek().is_some()
        && Field::new(state, view, &reserved, commit, None).dynamic_count >= item_limit;
    if !items_full {
        requests.extend(awaiting);
    }
    let mut full = false;
    requests.extend(
        std::mem::take(&mut commit.instant_rails)
            .into_iter()
            .map(|(actor, ride)| Request::InstantRail(actor, ride)),
    );
    requests.sort_unstable_by_key(|request| request.rank(view));
    for request in requests {
        let key = request.key();
        match request {
            Request::Drop(request) => items.place_drop(state, view, request, &mut reserved, commit),
            Request::Activate(_, _) if full => (),
            Request::PendingItem(_, _) if full || items_full => (),
            Request::Activate(id, arrival) => {
                let field = Field::new(state, view, &reserved, commit, None);
                full = field.dynamic_count >= items.drops.body_limit();
                if full {
                    continue;
                }
                let Some(mut body) = view.bodies.actor_spec(id).cloned() else {
                    continue;
                };
                let radius = body.radius();
                let to = match arrival {
                    ActorArrival::Respawn => respawn_position(&field, radius),
                    ActorArrival::Transit(destination) => {
                        let origin = state.stations.get(&destination).map_or_else(
                            || state.actors[&id].transit.expect("due arrival").origin,
                            |station| station.position,
                        );
                        nearest_position(origin, |point| field.clear(point, radius))
                    }
                };
                let Some(to) = to else {
                    continue;
                };
                body.params.pose = resting_pose(to, state.actors[&id].aim);
                reserved.insert(key, Spawn::Actor { id, body, arrival });
                match arrival {
                    ActorArrival::Respawn => {
                        commit.deadlines.insert(id, Deadlines::default());
                    }
                    ActorArrival::Transit(_) => set_rail_cooldown(state, view.tick, commit, id),
                }
            }
            Request::InstantRail(id, ride) => {
                let destination = ride.destination;
                let Some(to) = rail_landing(
                    state,
                    view,
                    id,
                    state.stations[&destination].position,
                    &reserved,
                    commit,
                ) else {
                    commit.facts.push(Fact::Rejected {
                        actor: id,
                        reason: Rejection::Transit(destination),
                    });
                    continue;
                };
                let actor = state.actors.get_mut(&id).expect("rail claimant");
                actor.charging = None;
                commit.lifecycle.push(Lifecycle::Warp {
                    body: BodyId::Actor(id),
                    to,
                    angle: actor.aim,
                });
                set_rail_cooldown(state, view.tick, commit, id);
                commit.facts.push(Fact::TransitDeparted {
                    actor: id,
                    destination,
                });
                commit.facts.push(Fact::TransitLanded {
                    actor: id,
                    destination,
                });
            }
            Request::PendingItem(id, at) => {
                let field = Field::new(state, view, &reserved, commit, None);
                items_full = field.dynamic_count >= item_limit;
                if !items_full && field.clear(at, LOOT_RADIUS) {
                    reserved.insert(
                        key,
                        Spawn::AdmitItem {
                            id,
                            body: loot_body(at, [0.0; 2]),
                        },
                    );
                }
            }
        }
    }
    reserved
}

fn set_rail_cooldown(state: &State, tick: Tick, commit: &mut Commit, id: ActorId) {
    commit
        .deadlines
        .entry(id)
        .or_insert(state.actors[&id].deadlines)
        .transit_ready_at = tick.saturating_add(RAIL_COOLDOWN);
}

fn resting_pose([x, y]: Point, angle: f64) -> [f64; 6] {
    [x, y, angle, 0.0, 0.0, 0.0]
}

fn respawn_position(field: &Field<'_>, radius: f64) -> Option<Point> {
    let safe = |point: Point| {
        field
            .state
            .hazard_x
            .is_none_or(|wall| point[0] > wall + RESPAWN_WALL_MARGIN)
            && field
                .contestants
                .iter()
                .all(|&at| distance(point, at) > RESPAWN_CONTESTANT_DISTANCE)
    };
    let mut origins: Vec<_> = field
        .state
        .stations
        .iter()
        .filter(|(_, station)| {
            station.kind == StationKind::Transit
                && safe(station.position)
                && field.geometry_clear(station.position, RESPAWN_CLEARANCE)
        })
        .collect();
    origins.sort_unstable_by(|(id_a, a), (id_b, b)| {
        a.position[0]
            .total_cmp(&b.position[0])
            .then_with(|| id_a.cmp(id_b))
    });
    origins.into_iter().find_map(|(_, station)| {
        nearest_position(station.position, |point| {
            safe(point) && field.clear(point, radius)
        })
    })
}

pub(super) fn rail_landing(
    state: &State,
    view: ClaimView<'_>,
    actor: ActorId,
    destination: Point,
    reserved: &BTreeMap<SpawnKey, Spawn>,
    commit: &Commit,
) -> Option<Point> {
    let body = BodyId::Actor(actor);
    let radius = view.solved.radius(body)?;
    let field = Field::new(state, view, reserved, commit, Some(body));
    nearest_position(destination, |point| field.clear(point, radius))
}

fn nearest_position(origin: Point, clear: impl Fn(Point) -> bool) -> Option<Point> {
    if clear(origin) {
        return Some(origin);
    }
    (1..=24).find_map(|ring| {
        (0..32).find_map(|sample| {
            let angle = f64::from(sample) * std::f64::consts::PI / 16.0;
            let distance = f64::from(ring) * 4.0;
            let point = [
                origin[0] + cos(angle) * distance,
                origin[1] + sin(angle) * distance,
            ];
            clear(point).then_some(point)
        })
    })
}

struct Field<'a> {
    state: &'a State,
    view: ClaimView<'a>,
    actors: Vec<(Point, f64)>,
    contestants: Vec<Point>,
    loot: Vec<(Point, f64)>,
    dynamic_count: usize,
}

impl<'a> Field<'a> {
    fn new(
        state: &'a State,
        view: ClaimView<'a>,
        reserved: &BTreeMap<SpawnKey, Spawn>,
        commit: &Commit,
        ignore: Option<BodyId>,
    ) -> Self {
        let mut field = Self {
            state,
            view,
            actors: Vec::new(),
            contestants: Vec::new(),
            loot: Vec::new(),
            dynamic_count: 0,
        };
        for id in view.solved.bodies().filter(|&id| Some(id) != ignore) {
            match id {
                BodyId::Actor(actor) => {
                    if !state.active(actor) {
                        continue;
                    }
                    let at = applied_position(view, commit, id).expect("solved actor pose");
                    if actor.kind == ActorKind::Contestant {
                        field.contestants.push(at);
                    }
                    field
                        .actors
                        .push((at, view.solved.radius(id).expect("solved actor radius")));
                }
                BodyId::Item(item) => {
                    if !state.items.contains_key(&item) {
                        continue;
                    }
                    field.loot.push((
                        view.solved.position(id).expect("solved item pose"),
                        view.solved.radius(id).expect("solved item radius"),
                    ));
                }
                _ => {}
            }
            field.dynamic_count += 1;
        }
        for spawn in reserved.values() {
            let (body, disks) = match spawn {
                Spawn::Actor { body, .. } => (body, &mut field.actors),
                Spawn::Item {
                    body: Some(body), ..
                }
                | Spawn::AdmitItem { body, .. } => (body, &mut field.loot),
                _ => continue,
            };
            disks.push(([body.params.pose[0], body.params.pose[1]], body.radius()));
            field.dynamic_count += 1;
        }
        field
    }

    fn gate_open(&self, index: usize) -> bool {
        self.state
            .gates
            .get(&GateId(index as u32))
            .is_some_and(|gate| gate.open)
    }

    fn geometry_clear(&self, point: Point, radius: f64) -> bool {
        let [x, y] = point;
        self.view.bounds.is_none_or(|[min_x, min_y, max_x, max_y]| {
            x - radius >= min_x && x + radius <= max_x && y - radius >= min_y && y + radius <= max_y
        }) && !self
            .view
            .geometry
            .contact_with_gates(
                false,
                point,
                point,
                radius,
                &self.view.solved.solid_props,
                |index| self.gate_open(index),
            )
            .is_finite()
    }

    fn clear(&self, point: Point, radius: f64) -> bool {
        self.geometry_clear(point, radius)
            && self
                .actors
                .iter()
                .chain(&self.loot)
                .all(|&(at, other)| distance(point, at) >= radius + other)
    }

    fn drop_clear(&self, origin: Point, point: Point) -> bool {
        self.geometry_clear(point, DROP_CLEARANCE)
            && !self
                .view
                .geometry
                .contact_with_gates(false, origin, point, 0.0, &[], |index| {
                    self.gate_open(index)
                })
                .is_finite()
            && self
                .actors
                .iter()
                .all(|&(at, radius)| distance(point, at) > radius + LOOT_RADIUS)
            && self
                .loot
                .iter()
                .all(|&(at, radius)| distance(point, at) > 32.0_f64.max(radius + LOOT_RADIUS))
    }
}

fn applied_position(view: ClaimView<'_>, commit: &Commit, body: BodyId) -> Option<Point> {
    commit
        .lifecycle
        .iter()
        .find_map(|effect| match *effect {
            Lifecycle::Warp { body: id, to, .. } if id == body => Some(to),
            _ => None,
        })
        .or_else(|| view.solved.position(body))
}

fn distance(a: Point, b: Point) -> f64 {
    hypot(a[0] - b[0], a[1] - b[1])
}

/// Limits for logical ground items, optional loot bodies and all dynamic bodies.
pub struct DropTuning {
    pub ground_capacity: usize,
    pub optional_body_capacity: usize,
    pub body_capacity: usize,
    /// Body slots a pending item's admission leaves free for drops (`worldPhysics.dropReserve`).
    pub drop_reserve: usize,
}

impl Default for DropTuning {
    fn default() -> Self {
        Self {
            ground_capacity: 65_536,
            optional_body_capacity: MAX_DYNAMIC,
            body_capacity: MAX_DYNAMIC,
            drop_reserve: 0,
        }
    }
}

pub(super) struct DropPlan<'a> {
    pub state: &'a State,
    pub view: ClaimView<'a>,
    pub reserved: &'a BTreeMap<SpawnKey, Spawn>,
    pub commit: &'a Commit,
    pub replacing: Option<ItemId>,
    pub owner: ActorId,
    pub ordinal: u32,
    pub copies: usize,
    pub mandatory: bool,
}

pub(super) struct DropSpot {
    pub position: Point,
    pub body: Option<BodySpec>,
}

impl DropTuning {
    fn body_limit(&self) -> usize {
        self.body_capacity.min(MAX_DYNAMIC)
    }

    /// The dynamic body count at which pending items stop being admitted: the body limit less
    /// the drop reserve and one slot for each actor awaiting a respawn or an arrival.
    fn item_limit(&self, state: &State) -> usize {
        let returning = state
            .actors
            .values()
            .filter(|actor| matches!(actor.presence, Presence::Pending | Presence::Transit))
            .count();
        self.body_limit()
            .saturating_sub(self.drop_reserve)
            .saturating_sub(returning)
    }

    pub(super) fn plan(&self, plan: DropPlan<'_>) -> Option<Vec<DropSpot>> {
        let DropPlan {
            state,
            view,
            reserved,
            commit,
            replacing,
            owner,
            ordinal,
            copies,
            mandatory,
        } = plan;
        let origin = view.solved.position(BodyId::Actor(owner))?;
        let mut field = Field::new(state, view, reserved, commit, replacing.map(BodyId::Item));
        let logical = state.items.len().saturating_sub(usize::from(
            replacing.is_some_and(|id| state.items.contains_key(&id)),
        )) + reserved
            .values()
            .filter(|spawn| matches!(spawn, Spawn::Item { .. }))
            .count();
        if !mandatory
            && (logical.saturating_add(copies) > self.ground_capacity
                || field.loot.len().saturating_add(copies) > self.optional_body_capacity
                || field.dynamic_count.saturating_add(copies) > self.body_limit())
        {
            return None;
        }
        let mut spots = Vec::with_capacity(copies);
        for copy in 0..copies {
            let phase =
                (scatter_score(view.seed, view.tick, owner, u64::from(ordinal), copy as u32) >> 11)
                    as f64
                    * (std::f64::consts::TAU / ((1_u64 << 53) as f64));
            let clear = (0..180).find_map(|j| {
                let angle = phase + f64::from(j) * 2.39996;
                let radius = 36.0 + f64::from(j / 12) * 24.0;
                let p = [
                    origin[0] + cos(angle) * radius,
                    origin[1] + sin(angle) * radius,
                ];
                field.drop_clear(origin, p).then_some(p)
            });
            let position = match clear {
                Some(point) => point,
                None if mandatory => origin,
                None => return None,
            };
            // A mandatory fallback is a logical item only. It must pass admission on a later tick.
            let body = clear
                .filter(|_| field.dynamic_count < self.body_limit())
                .map(|point| {
                    field.dynamic_count += 1;
                    field.loot.push((point, LOOT_RADIUS));
                    let magnitude = distance(origin, point);
                    let velocity = [
                        (point[0] - origin[0]) / magnitude * 60.0,
                        (point[1] - origin[1]) / magnitude * 60.0,
                    ];
                    loot_body(point, velocity)
                });
            spots.push(DropSpot { position, body });
        }
        Some(spots)
    }
}

fn loot_body([x, y]: Point, [vx, vy]: Point) -> BodySpec {
    BodySpec {
        params: BodyParams {
            kind: KIND_PROP,
            map_geometry: false,
            pose: [x, y, 0.0, vx, vy, 0.0],
            material: [0.2, 0.0, 0.0],
            damping: [Some(5.0); 2],
            groups: (LOOT_GROUP << 16) | 1,
        },
        shape: SHAPE_CIRCLE,
        dimensions: [LOOT_RADIUS, 0.0],
        vertices: Vec::new(),
        speed_limit: 384.0,
        tip_radius: 0.0,
    }
}
