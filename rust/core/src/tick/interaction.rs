//! Survivor interactions and their deadlines (27.2 R3, R4, R8 and R9).

use std::collections::BTreeMap;

use crate::math::hypot;
use crate::swept::Grid;

use super::placement::rail_landing;
use super::*;

const EXTRACTION_REACH: f64 = 65.0;
const CHARGE_REACH: f64 = 70.0;
const TRANSIT_REACH: f64 = 70.0;
const GATE_REACH: f64 = 85.0;
const SENSOR_REACH: f64 = 180.0;
const CHARGE_JITTER: f64 = 0.05;
const REVEAL_TICKS: Tick = 65;
pub(super) const RAIL_COOLDOWN: Tick = 180;
const TILE: f64 = 40.0;
const TARGET_CONTEST: u64 = 0x696e_7472_0000_0000;
const SLOT_CONTEST: u64 = 0x6578_6974_0000_0000;
const GATE_CONTEST: u64 = 0x6761_7465_0000_0000;
const RAIL_CONTEST: u64 = 0x7261_696c_0000_0000;

/// Immutable lookup tables for authored interactables and sensors.
pub(super) struct Sites {
    targets: Vec<Target>,
    target_grid: Grid,
    sensor_grid: Grid,
}

impl Sites {
    pub(super) fn new(state: &State) -> Self {
        let (targets, bounds): (Vec<_>, Vec<_>) = state
            .gates
            .iter()
            .map(|(&id, gate)| (Target::Gate(id), reach_bounds(gate.position, GATE_REACH)))
            .chain(state.stations.iter().map(|(&id, station)| {
                (
                    Target::Station(id),
                    reach_bounds(station.position, CHARGE_REACH.max(TRANSIT_REACH)),
                )
            }))
            .unzip();
        let target_grid = Grid::for_bounds(bounds);
        let sensor_grid = Grid::for_bounds(
            state
                .sensors
                .iter()
                .map(|&at| reach_bounds(at, SENSOR_REACH)),
        );
        Self {
            targets,
            target_grid,
            sensor_grid,
        }
    }

    fn near(&self, [x, y]: Point) -> impl Iterator<Item = Target> + '_ {
        self.target_grid
            .at(x, y)
            .into_iter()
            .map(|index| self.targets[index as usize])
    }

    fn detects(&self, sensors: &[Point], [x, y]: Point) -> bool {
        self.sensor_grid
            .at(x, y)
            .iter()
            .any(|&index| distance([x, y], sensors[index as usize]) < SENSOR_REACH)
    }
}

fn reach_bounds([x, y]: Point, reach: f64) -> [f64; 4] {
    [x - reach, y - reach, 2.0 * reach, 2.0 * reach]
}

pub struct InteractionRules {
    pub charge_ticks: Tick,
    pub transit_base: f64,
    pub transit_per_unit: f64,
}

impl Default for InteractionRules {
    fn default() -> Self {
        Self {
            charge_ticks: 100,
            transit_base: 0.0,
            transit_per_unit: 0.0,
        }
    }
}

/// One gesture per input. A nominated interaction takes precedence over a selected rail
/// destination, which in turn takes precedence over a targetless interact.
#[derive(Clone, Copy, Debug)]
pub enum InteractionIntent {
    Interact(Option<Target>),
    Rail(StationId),
}

impl InteractionIntent {
    pub(super) fn from_input(input: Input) -> Option<Self> {
        if input.interact && input.target.is_some() {
            Some(Self::Interact(input.target))
        } else if let Some(destination) = input.transit {
            Some(Self::Rail(destination))
        } else {
            input.interact.then_some(Self::Interact(None))
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum InteractionClaim {
    Item(ItemClaim),
    Extract {
        cell: ItemId,
        distance: f64,
    },
    StartCharge(Charging),
    AdvanceCharge {
        charge: Charging,
        allowed: bool,
    },
    Gate {
        id: GateId,
        open: bool,
        can_pay: bool,
    },
    Rail(Transit),
}

impl From<ItemClaim> for InteractionClaim {
    fn from(claim: ItemClaim) -> Self {
        Self::Item(claim)
    }
}

impl InteractionRules {
    pub(super) fn resolve_into(
        &self,
        view: &ResolveView<'_>,
        intents: impl Iterator<Item = (ActorId, InteractionIntent)>,
        items: &ItemRules,
        effects: &mut Effects<InteractionClaim, DropRequest>,
    ) {
        let state = view.start.state;
        for (id, intent) in intents {
            let rewind = view.rewound(id);
            let claim = view
                .solved
                .position(BodyId::Actor(id))
                .and_then(|origin| match intent {
                    InteractionIntent::Interact(target) => {
                        self.select(view, &rewind, id, origin, target, items)
                    }
                    InteractionIntent::Rail(to) => {
                        let (&source, _) = state.stations.iter().find(|(_, station)| {
                            station.kind == StationKind::Transit
                                && distance(origin, station.position) < TRANSIT_REACH
                                && rewind.line_clear(origin, station.position)
                        })?;
                        self.rail(view, id, origin, source, Some(to))
                    }
                });
            if let Some(claim) = claim {
                effects.claims.push((id, claim));
            } else {
                effects.facts.push(Fact::Rejected {
                    actor: id,
                    reason: match intent {
                        InteractionIntent::Interact(Some(Target::Item(item))) => {
                            Rejection::Pickup(item)
                        }
                        InteractionIntent::Interact(target) => Rejection::Interaction(target),
                        InteractionIntent::Rail(to) => Rejection::Transit(to),
                    },
                });
            }
        }

        let current = view.current();
        for (&id, actor) in &state.actors {
            if id.kind != ActorKind::Contestant || actor.presence != Presence::Active {
                continue;
            }
            let body = BodyId::Actor(id);
            let Some(origin) = view.solved.position(body) else {
                continue;
            };
            if let Some(charge) = actor.charging {
                let allowed = view
                    .solved
                    .distance_travelled(body)
                    .is_some_and(|distance| distance <= CHARGE_JITTER)
                    && state.stations.get(&charge.station).is_some_and(|station| {
                        station.kind == StationKind::Charging
                            && distance(origin, station.position) < CHARGE_REACH
                            && current.line_clear(origin, station.position)
                    });
                effects
                    .claims
                    .push((id, InteractionClaim::AdvanceCharge { charge, allowed }));
            }
            if !actor.sneak
                && !actor
                    .statuses
                    .get(&Status::Cloak)
                    .is_some_and(|window| window.contains(view.start.tick))
                && view.start.sites.detects(&state.sensors, origin)
            {
                let active_from = view.start.tick.saturating_add(1);
                effects.statuses.push((
                    id,
                    Status::Reveal,
                    StatusEffect::Extend(Window {
                        active_from,
                        expires_at: active_from.saturating_add(REVEAL_TICKS),
                    }),
                ));
            }
        }
    }

    fn select(
        &self,
        view: &ResolveView<'_>,
        rewind: &Rewound<'_>,
        id: ActorId,
        origin: Point,
        nomination: Option<Target>,
        items: &ItemRules,
    ) -> Option<InteractionClaim> {
        let state = view.start.state;
        let actor = &state.actors[&id];
        let mut candidates = Vec::new();
        let mut consider = |target, tier, range, claim| {
            candidates.push((target, tier, range, claim));
        };
        if nomination.is_none_or(|target| target == Target::Extraction)
            && id.kind == ActorKind::Contestant
            && let Some(exit) = state.extraction.filter(|exit| exit.slots > 0)
            && let Some(cell) = actor.inventory.slots.iter().flatten().find(|item| {
                matches!(item.equipment.kind, EquipmentKind::Cell { charge } if charge >= self.charge_ticks)
            })
        {
            let range = distance(origin, exit.position);
            if range < EXTRACTION_REACH && rewind.line_clear(origin, exit.position) {
                consider(Target::Extraction, 1, range, InteractionClaim::Extract { cell: cell.id, distance: range });
            }
        }

        let nearby: Vec<_> = nomination.map_or_else(
            || view.start.sites.near(origin).collect(),
            |target| vec![target],
        );
        for &target in &nearby {
            let Target::Station(station) = target else {
                continue;
            };
            let Some(record) = state.stations.get(&station) else {
                continue;
            };
            let range = distance(origin, record.position);
            match record.kind {
                StationKind::Charging
                    if id.kind == ActorKind::Contestant && range < CHARGE_REACH =>
                {
                    let cell = actor.inventory.slots.iter().flatten().find(|item| {
                        matches!(item.equipment.kind, EquipmentKind::Cell { charge } if charge < self.charge_ticks)
                    });
                    if let Some(cell) = cell
                        && rewind.line_clear(origin, record.position)
                    {
                        consider(
                            target,
                            1,
                            range,
                            InteractionClaim::StartCharge(Charging {
                                station,
                                cell: cell.id,
                            }),
                        );
                    }
                }
                StationKind::Transit
                    if range < TRANSIT_REACH && rewind.line_clear(origin, record.position) =>
                {
                    if let Some(claim) = self.rail(view, id, origin, station, None) {
                        consider(target, 2, range, claim);
                    }
                }
                _ => {}
            }
        }

        for target in nearby {
            let Target::Gate(gate) = target else { continue };
            let Some(record) = state.gates.get(&gate) else {
                continue;
            };
            let open = !rewind.gate_open(gate.0 as usize);
            let can_pay = !open || !record.locked || actor.inventory.keys > 0;
            let range = distance(origin, record.position);
            if (open || record.door && !actor.bot)
                && (can_pay || nomination.is_some())
                && range < GATE_REACH
                && rewind.line_clear_ignoring(origin, record.position, Some(gate))
            {
                consider(
                    target,
                    2,
                    range,
                    InteractionClaim::Gate {
                        id: gate,
                        open,
                        can_pay,
                    },
                );
            }
        }

        let find_items = match nomination {
            Some(Target::Item(item)) => Some(Some(item)),
            None => Some(None),
            _ => None,
        };
        if let Some(nominated) = find_items {
            for claim in items.explicit_candidates(view, rewind, id, origin, nominated) {
                consider(Target::Item(claim.item), 2, claim.distance, claim.into());
            }
        }
        let hash = |target| {
            let word = match target {
                Target::Extraction => 0,
                Target::Station(id) => (1 << 32) | u64::from(id.0),
                Target::Gate(id) => (2 << 32) | u64::from(id.0),
                Target::Item(id) => (3 << 32) | u64::from(id.0),
            };
            contest_score(
                view.start.seed,
                view.start.tick,
                TARGET_CONTEST ^ actor_word(id),
                word,
            )
        };
        candidates
            .into_iter()
            .min_by(|a, b| {
                a.1.cmp(&b.1)
                    .then_with(|| a.2.total_cmp(&b.2))
                    .then_with(|| (hash(a.0), a.0).cmp(&(hash(b.0), b.0)))
            })
            .map(|(_, _, _, claim)| claim)
    }

    fn rail(
        &self,
        view: &ResolveView<'_>,
        actor: ActorId,
        origin: Point,
        source: StationId,
        nominated: Option<StationId>,
    ) -> Option<InteractionClaim> {
        let state = view.start.state;
        if actor.kind != ActorKind::Gladiator
            || view.start.tick < state.actors[&actor].deadlines.transit_ready_at
        {
            return None;
        }
        let mut ahead = state.stations.iter().filter(|&(&id, station)| {
            id != source
                && station.kind == StationKind::Transit
                && state
                    .hazard_x
                    .is_none_or(|wall| station.position[0] > wall + TILE)
        });
        let (&destination, station) = if let Some(id) = nominated {
            ahead.find(|&(&dest, _)| dest == id)?
        } else {
            ahead
                .clone()
                .find(|(_, station)| station.position[0] > origin[0] + TILE)
                .or_else(|| ahead.next())?
        };
        let ticks = (self.transit_base + self.transit_per_unit * distance(origin, station.position))
            .round() as Tick;
        Some(InteractionClaim::Rail(Transit {
            destination,
            origin,
            arrive_at: view.start.tick.saturating_add(ticks),
        }))
    }

    pub(super) fn settle(
        &self,
        state: &mut State,
        view: ClaimView<'_>,
        claims: Vec<(ActorId, InteractionClaim)>,
        items: &ItemRules,
        placement: &mut Placement<DropRequest>,
        commit: &mut Commit,
    ) -> ChargeChanges {
        let mut extraction = Vec::new();
        let mut gates = BTreeMap::<GateId, Vec<_>>::new();
        let mut rails = Vec::new();
        let mut pickups = Vec::new();
        let mut charging = ChargeChanges::default();
        for (actor, claim) in claims {
            match claim {
                InteractionClaim::Item(item) => pickups.push((actor, item)),
                InteractionClaim::Extract { cell, distance } => {
                    extraction.push((actor, cell, distance))
                }
                InteractionClaim::Gate { id, open, can_pay } => {
                    gates.entry(id).or_default().push((actor, open, can_pay))
                }
                InteractionClaim::Rail(ride) => rails.push((actor, ride)),
                InteractionClaim::StartCharge(charge) => {
                    charging.starts.insert(actor, charge);
                }
                InteractionClaim::AdvanceCharge { charge, allowed } => {
                    charging.progress.insert(actor, (charge, allowed));
                }
            }
        }
        let rank = |key, actor| {
            (
                contest_score(view.seed, view.tick, key, actor_word(actor)),
                actor,
            )
        };
        extraction.sort_unstable_by(|a, b| {
            a.2.total_cmp(&b.2)
                .then_with(|| rank(SLOT_CONTEST, a.0).cmp(&rank(SLOT_CONTEST, b.0)))
        });
        for (actor, cell, _) in extraction {
            let exit = state.extraction.as_mut().expect("extraction claim");
            if exit.slots == 0 {
                reject(
                    commit,
                    actor,
                    Rejection::Interaction(Some(Target::Extraction)),
                );
                continue;
            }
            let record = state.actors.get_mut(&actor).expect("extraction claimant");
            let slot = record
                .inventory
                .slots
                .iter()
                .position(|item| item.is_some_and(|item| item.id == cell))
                .expect("eligible extraction cell");
            exit.slots -= 1;
            record.inventory.remove(slot);
            depart(record, actor, Presence::Escaped, commit);
            commit.facts.push(Fact::Escaped { actor, cell });
        }
        rails.sort_unstable_by_key(|&(actor, ride)| {
            rank(RAIL_CONTEST ^ u64::from(ride.destination.0), actor)
        });
        let (instant, timed): (Vec<_>, Vec<_>) = rails
            .into_iter()
            .partition(|(_, ride)| ride.arrive_at == view.tick);
        for (actor, ride) in timed {
            // Timed trains preflight against T's scene without reserving a future landing.
            if rail_landing(
                state,
                view,
                actor,
                state.stations[&ride.destination].position,
                &placement.reserved,
                commit,
            )
            .is_some()
            {
                let record = state.actors.get_mut(&actor).expect("transit claimant");
                record.transit = Some(ride);
                depart(record, actor, Presence::Transit, commit);
                commit.facts.push(Fact::TransitDeparted {
                    actor,
                    destination: ride.destination,
                });
            } else {
                reject(commit, actor, Rejection::Transit(ride.destination));
            }
        }
        for (gate, mut attempts) in gates {
            attempts.sort_unstable_by_key(|&(actor, _, _)| {
                rank(GATE_CONTEST ^ u64::from(gate.0), actor)
            });
            let winner = attempts.iter().find(|&&(_, _, can_pay)| can_pay);
            let mut blocked = false;
            if let Some(&(actor, open, _)) = winner
                && state.gates[&gate].open != open
            {
                blocked = !open && gate_occupied(state, view, gate);
                if !blocked {
                    let record = state.gates.get_mut(&gate).expect("claimed gate");
                    if open && record.locked {
                        state
                            .actors
                            .get_mut(&actor)
                            .expect("gate claimant")
                            .inventory
                            .keys -= 1;
                        record.locked = false;
                    }
                    record.open = open;
                    commit.lifecycle.push(Lifecycle::SyncGate(gate));
                    commit.facts.push(Fact::GateChanged { actor, gate, open });
                }
            }
            let record = &state.gates[&gate];
            for &(actor, open, can_pay) in &attempts {
                if !can_pay {
                    reject(commit, actor, Rejection::GateLocked(gate));
                } else if winner.is_some_and(|&(_, desired, _)| open != desired) {
                    reject(commit, actor, Rejection::GateContested(gate));
                } else if blocked {
                    reject(commit, actor, Rejection::GateOccupied(gate));
                }
                commit.carried.push(Carried::GateObserved {
                    actor,
                    gate,
                    open: record.open,
                    locked: record.locked,
                });
            }
        }
        pickups.retain(|(actor, _)| state.active(*actor));
        items.settle_claims(state, view, pickups, placement, commit);
        commit.instant_rails = instant;
        charging
    }

    pub(super) fn charge(&self, state: &mut State, changes: ChargeChanges, commit: &mut Commit) {
        let ChargeChanges {
            starts,
            mut progress,
        } = changes;
        for (actor, charge) in starts {
            if !state.active(actor) {
                continue;
            }
            let record = state.actors.get_mut(&actor).expect("charging claimant");
            if record.charging != Some(charge)
                && cell_charge(record, charge.cell)
                    .is_some_and(|amount| *amount < self.charge_ticks)
            {
                record.charging = Some(charge);
                progress.remove(&actor);
                commit.facts.push(Fact::ChargingStarted {
                    actor,
                    station: charge.station,
                });
            }
        }
        for (actor, (charge, allowed)) in progress {
            if !state.active(actor) {
                continue;
            }
            let record = state.actors.get_mut(&actor).expect("charging actor");
            let amount = cell_charge(record, charge.cell);
            if let Some(amount) = amount.filter(|amount| allowed && **amount < self.charge_ticks) {
                *amount += 1;
                if *amount == self.charge_ticks {
                    record.charging = None;
                    commit.facts.push(Fact::CellCharged {
                        actor,
                        station: charge.station,
                    });
                }
            } else {
                record.charging = None;
                commit.facts.push(Fact::ChargingStopped {
                    actor,
                    station: charge.station,
                });
            }
        }
    }
}

#[derive(Default)]
pub(super) struct ChargeChanges {
    starts: BTreeMap<ActorId, Charging>,
    progress: BTreeMap<ActorId, (Charging, bool)>,
}

fn cell_charge(actor: &mut Actor, cell: ItemId) -> Option<&mut u32> {
    let held = actor
        .inventory
        .slots
        .iter_mut()
        .flatten()
        .find(|item| item.id == cell)?;
    match &mut held.equipment.kind {
        EquipmentKind::Cell { charge } => Some(charge),
        _ => None,
    }
}

fn depart(record: &mut Actor, actor: ActorId, presence: Presence, commit: &mut Commit) {
    record.presence = presence;
    record.charging = None;
    commit
        .lifecycle
        .push(Lifecycle::SetPresence { actor, presence });
}

fn gate_occupied(state: &State, view: ClaimView<'_>, gate: GateId) -> bool {
    let Some(bounds @ [x, y, w, h]) = view
        .sight_gates
        .boxes
        .get(gate.0 as usize)
        .copied()
        .or_else(|| view.bodies.gate_box(gate))
    else {
        return false;
    };
    state
        .actors
        .keys()
        .filter(|&&actor| state.active(actor))
        .any(|&actor| {
            let body = BodyId::Actor(actor);
            let Some([px, py]) = view.solved.position(body) else {
                return false;
            };
            hypot(px - px.clamp(x, x + w), py - py.clamp(y, y + h))
                < view.solved.radius(body).expect("solved actor")
        })
        || view.bodies.props_overlap_box(bounds)
}

fn reject(commit: &mut Commit, actor: ActorId, reason: Rejection) {
    commit.facts.push(Fact::Rejected { actor, reason });
}

fn distance(from: Point, to: Point) -> f64 {
    hypot(from[0] - to[0], from[1] - to[1])
}
