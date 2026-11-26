//! The unwired intake → solve → resolve → apply runner (27.2).
//! The WASM adapter still calls the seven-phase tick.

mod admission;
mod apply;
mod bots;
pub mod codec;
mod combat;
mod discovery;
mod hazards;
mod hearing;
mod hook;
mod input;
mod interaction;
mod inventory;
mod items;
mod motor;
mod movement;
mod order;
mod output;
mod placement;
pub mod presentation;
mod projectile;
mod rewind;
mod solve;
mod state;
mod sweep;

pub use apply::{
    ActorArrival, Commit, Effects, Elimination, Event, EventPoint, Fact, HookRelease, Lifecycle,
    Rejection, Spawn, SpawnKey, StatusEffect, VitalEffect,
};
pub use combat::{Combat, CombatIntent, CombatRules, WeaponTuning};
pub use discovery::{
    DISCOVERY_INTERVAL, DISCOVERY_RADIUS, Discovery, DiscoverySample, DoorMemory, GateObservation,
    Memory, RememberedItem,
};
pub use hazards::{FlameTuning, HazardRules, MineTuning, SpiderTuning, TurretTuning};
pub use hearing::{Cue, Hearing};
pub use hook::HookTuning;
pub use input::{
    AmmoFamily, Carried, Command, CommandSource, DropSlot, Inbound, Input, Observation, Target,
};
pub use interaction::{InteractionClaim, InteractionIntent, InteractionRules};
pub use inventory::{
    CarriedItem, Equipment, EquipmentKind, Inventory, Loot, Reload, SLOT_COUNT, Utility,
};
pub use items::{DropRequest, ItemClaim, ItemIntent, ItemRules};
pub use motor::{MotorSurface, MotorTuning};
pub use movement::{Movement, MovementIntent};
pub use order::{actor_from_word, actor_word, contest_score, scatter_score};
pub use output::{Changes, Discontinuity, Pose, Snapshot};
pub use placement::DropTuning;
pub use rewind::{RewindFrame, RewindHistory, Rewound};
pub use solve::{BeforeSolve, BodySpec, Contact, ContactKind, Motor, Path, Solved, Tether};
pub use state::*;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::floor_drag::Floor;
use crate::sight::{GateSet, SightIndex};
use crate::swept::{Shape, SweptMap};
use apply::Ids;
use input::InputState;
use solve::Bodies;

#[derive(Clone, Copy)]
pub struct View<'a> {
    pub tick: Tick,
    pub seed: u64,
    pub state: &'a State,
    pub geometry: &'a SweptMap,
    pub sight: &'a SightIndex,
    pub sight_gates: &'a GateSet,
    bounds: Option<[f64; 4]>,
    hazard_map: &'a hazards::HazardMap,
    sites: &'a interaction::Sites,
}

impl View<'_> {
    pub fn solid_contact(&self, from: Point, to: Point, props: &[Shape]) -> f64 {
        self.geometry
            .contact_with_gates(false, from, to, 0.0, props, |index| {
                self.state
                    .gates
                    .get(&GateId(index as u32))
                    .is_some_and(|gate| gate.open)
            })
    }
}

pub struct IntakeView<'a> {
    pub start: View<'a>,
    pub bodies: &'a BeforeSolve,
}

#[derive(Default)]
pub struct Intake {
    pub aim: BTreeMap<ActorId, f64>,
    pub sneak: BTreeMap<ActorId, bool>,
    pub boosts: BTreeMap<ActorId, Window>,
    pub skill_ready_at: BTreeMap<ActorId, Tick>,
    pub weapon_ready_at: BTreeMap<ActorId, Tick>,
    pub inventories: BTreeMap<ActorId, Inventory>,
    pub projectiles: BTreeMap<(ActorId, u32), Projectile>,
    pub motors: BTreeMap<BodyId, Motor>,
    pub tethers: BTreeMap<HookId, Tether>,
    pub hooks: BTreeMap<HookId, Option<Hook>>,
    pub facts: Vec<Fact>,
}

pub struct ResolveView<'a> {
    pub start: View<'a>,
    pub solved: &'a Solved,
    pub launched_projectiles: &'a BTreeMap<(ActorId, u32), Projectile>,
    history: &'a RewindHistory,
}

impl<'a> ResolveView<'a> {
    pub fn current(&self) -> Rewound<'a> {
        Rewound::new(self.start, self.solved, self.history, 0)
    }

    pub fn rewound(&self, viewer: ActorId) -> Rewound<'a> {
        let lag = self
            .start
            .state
            .actors
            .get(&viewer)
            .map_or(0, |a| a.view_lag);
        Rewound::new(self.start, self.solved, self.history, lag)
    }
}

#[derive(Clone, Copy)]
pub struct ClaimView<'a> {
    pub tick: Tick,
    pub seed: u64,
    pub solved: &'a Solved,
    pub geometry: &'a SweptMap,
    pub bounds: Option<[f64; 4]>,
    sight_gates: &'a GateSet,
    bodies: &'a Bodies,
}

/// One rule set, called at fixed points by the runner. A mechanic contributes through
/// these functions with its typed plans. The runner owns the state and physics writes
/// that establish the stage boundaries.
pub trait Mechanics {
    type Intent;
    type Claim;
    type Placement;

    fn intake(
        &self,
        before: IntakeView<'_>,
        inbound: &[Inbound],
        commands: &[Command],
        writes: &mut Intake,
    ) -> Vec<Self::Intent>;

    fn resolve(
        &self,
        view: ResolveView<'_>,
        intents: &[Self::Intent],
    ) -> Effects<Self::Claim, Self::Placement>;

    fn eliminations(
        &self,
        _state: View<'_>,
        _deaths: &[Elimination],
        _placements: &mut Vec<Self::Placement>,
        _commit: &mut Commit,
    ) {
    }

    fn claims(
        &self,
        state: &mut State,
        view: ClaimView<'_>,
        claims: Vec<(ActorId, Self::Claim)>,
        placement: &mut Placement<Self::Placement>,
        commit: &mut Commit,
    );

    fn place(
        &self,
        state: &mut State,
        view: ClaimView<'_>,
        placement: Placement<Self::Placement>,
        commit: &mut Commit,
    ) -> BTreeMap<SpawnKey, Spawn>;
}

pub struct Placement<P> {
    pub pending: Vec<P>,
    /// Successful swaps already reserved these placements in the claims stage.
    pub reserved: BTreeMap<SpawnKey, Spawn>,
}

/// A completed tick's outputs (27.2 Boundary). The recording frame is `inbound`, the
/// `discontinuities` and S1, which is the previous frame with `changes` applied.
pub struct CompletedTick {
    pub tick: Tick,
    /// T's inbound queue as spent: carried events, then stamped commands and observations.
    pub inbound: Vec<Inbound>,
    pub solved: Solved,
    /// The one list Node's mirror applies, with T's events.
    pub changes: Changes,
    pub discontinuities: Vec<Discontinuity>,
    pub discovery: Discovery,
}

/// Assemble an isolated match using stable IDs, without an adapter or the old tick.
#[derive(Default)]
pub struct Scenario {
    pub state: State,
    pub history: RewindHistory,
    body_specs: BTreeMap<BodyId, BodySpec>,
    geometry: Option<Arc<SweptMap>>,
    bounds: Option<[f64; 4]>,
    sight: Option<(Arc<SightIndex>, Arc<GateSet>)>,
    floor: Option<Floor>,
    hazard_areas: Vec<[f64; 4]>,
    hazard_wall: Option<hazards::Wall>,
    discovery: Option<discovery::Sampler>,
    known: BTreeMap<ActorId, Memory>,
}

impl Scenario {
    /// Arranged knowledge (27.2 "Test API"): what a contestant knows when the match starts, before
    /// the opening discovery adds what it sees. Only surveyed cells and remembered doors, so its
    /// planner may treat that layout as known; nothing is discovered, seen or remembered as loot. A
    /// room never arranges it.
    pub fn know(
        &mut self,
        actor: ActorId,
        surveyed: impl IntoIterator<Item = u32>,
        gates: impl IntoIterator<Item = (GateId, DoorMemory)>,
    ) -> &mut Self {
        let memory = self.known.entry(actor).or_default();
        memory.surveyed.extend(surveyed);
        memory.gates.extend(gates);
        self
    }

    /// The map's discovery tables, with the sight index and gate set its samples cast through.
    pub fn discovery(
        &mut self,
        map: crate::discovery::DiscoveryMap,
        sight: SightIndex,
        gates: GateSet,
    ) -> &mut Self {
        self.discovery = Some(discovery::Sampler::new(map, sight, gates));
        self
    }

    pub fn body(&mut self, id: BodyId, spec: BodySpec) -> &mut Self {
        assert!(
            self.body_specs.insert(id, spec).is_none(),
            "body ID already in use"
        );
        self
    }

    pub fn geometry(&mut self, geometry: Arc<SweptMap>) -> &mut Self {
        self.geometry = Some(geometry);
        self
    }

    pub fn bounds(&mut self, min: Point, max: Point) -> &mut Self {
        self.bounds = Some([min[0], min[1], max[0], max[1]]);
        self
    }

    pub fn floor_drag(&mut self, floor: Floor) -> &mut Self {
        self.floor = Some(floor);
        self
    }

    pub fn sight(&mut self, index: Arc<SightIndex>, gates: Arc<GateSet>) -> &mut Self {
        self.sight = Some((index, gates));
        self
    }

    pub fn hazard_area(&mut self, bounds: [f64; 4]) -> &mut Self {
        self.hazard_areas.push(bounds);
        self
    }

    pub fn hazard_wall(&mut self, map_width: f64, grace_ticks: Tick) -> &mut Self {
        self.hazard_wall = Some(hazards::Wall {
            map_width,
            grace_ticks,
        });
        self
    }

    pub fn start(mut self, seed: u64, time_limit: Tick) -> Match {
        let ids = Ids::from_state(&self.state);
        let sites = interaction::Sites::new(&self.state);
        let mut bodies = Bodies::default();
        for (id, spec) in self.body_specs {
            if let BodyId::Actor(actor) = id {
                bodies.seed_actor(actor, spec, self.state.active(actor));
            } else if let BodyId::Gate(gate) = id
                && let Some(record) = self.state.gates.get(&gate)
            {
                bodies.gate(gate, spec, record.open);
            } else if let BodyId::Item(item) = id
                && self
                    .state
                    .items
                    .get(&item)
                    .is_some_and(|item| item.unplaced_at.is_some())
            {
                continue;
            } else {
                bodies.insert(id, spec);
            }
        }
        if let Some(floor) = self.floor {
            bodies.use_floor(floor);
        }
        let (sight, sight_gates) = self.sight.unwrap_or_else(|| {
            let empty_grid = &[0, 0, 0, 0, 0];
            (
                Arc::new(SightIndex::new(&[], empty_grid, &[], &[0], empty_grid)),
                Arc::new(GateSet::new(&[], &[0], &[], empty_grid)),
            )
        });
        let hazard_map = hazards::HazardMap::new(self.hazard_areas, self.hazard_wall, time_limit);
        let memory = self
            .state
            .actors
            .keys()
            .filter(|id| id.kind == ActorKind::Contestant)
            .map(|&id| (id, self.known.remove(&id).unwrap_or_default()))
            .collect();
        let mut state = self.state;
        state.hazard_x = hazard_map.wall_at(0).or(state.hazard_x);
        let mut game = Match {
            state,
            history: self.history,
            bodies,
            geometry: self
                .geometry
                .unwrap_or_else(|| Arc::new(SweptMap::new(vec![], vec![], vec![]))),
            bounds: self.bounds,
            sight,
            sight_gates,
            sites,
            hazard_map,
            seed,
            time_limit,
            tick: 0,
            ids,
            input: InputState::default(),
            queued: BTreeMap::new(),
            carried: Vec::new(),
            finished: false,
            sampler: self.discovery,
            memory,
            cues: hearing::Cues::default(),
            bots: bots::Planner::default(),
            #[cfg(test)]
            mirror: None,
        };
        game.open_discovery();
        #[cfg(test)]
        {
            game.mirror = Some(game.snapshot());
        }
        game
    }
}

/// How far a teleported body may sit inside static geometry: `canOccupy`'s tolerance
/// (`shared/movement.ts`), so a point exactly one radius from a wall stays legal.
const STATIC_TOLERANCE: f64 = 0.01;

pub struct Match {
    state: State,
    history: RewindHistory,
    bodies: Bodies,
    geometry: Arc<SweptMap>,
    bounds: Option<[f64; 4]>,
    sight: Arc<SightIndex>,
    sight_gates: Arc<GateSet>,
    sites: interaction::Sites,
    hazard_map: hazards::HazardMap,
    seed: u64,
    time_limit: Tick,
    tick: Tick,
    ids: Ids,
    input: InputState,
    queued: BTreeMap<Tick, Vec<Inbound>>,
    carried: Vec<Carried>,
    finished: bool,
    sampler: Option<discovery::Sampler>,
    memory: BTreeMap<ActorId, Memory>,
    cues: hearing::Cues,
    bots: bots::Planner,
    /// Test builds fold every tick's change list into the first snapshot, as Node's mirror
    /// does, and compare the result with the match.
    #[cfg(test)]
    mirror: Option<Snapshot>,
}

impl Match {
    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn position(&mut self, id: BodyId) -> Option<Point> {
        self.bodies.position(id)
    }

    /// The retained rewind frames, captured at the close of each tick (R12).
    pub fn history(&self) -> &RewindHistory {
        &self.history
    }

    /// The whole committed state and every dynamic body's pose: a keyframe for the recording
    /// and a snapshot on request.
    pub fn snapshot(&mut self) -> Snapshot {
        Snapshot {
            tick: self.tick,
            state: self.state.clone(),
            poses: self.bodies.dynamic_poses(),
        }
    }

    /// The cues `listener` hears as of the last completed tick, oldest first. A cue published in T
    /// first reaches a bot's intent for T+1 (R11).
    pub fn heard(&self, listener: ActorId) -> Vec<Cue> {
        self.cues.heard(listener, self.tick)
    }

    /// A contestant's discovery memory as of the last completed tick.
    pub fn memory(&self, actor: ActorId) -> Option<&Memory> {
        self.memory.get(&actor)
    }

    pub fn acknowledged(&self, actor: ActorId) -> Option<u64> {
        self.input.acknowledged(actor)
    }

    /// Queue a record already admitted by the inbound boundary. Records retain arrival order
    /// within their stamped tick. A newer command supersedes an older one at that tick.
    pub fn submit(&mut self, tick: Tick, item: Inbound) -> bool {
        if self.finished || tick <= self.tick || tick > self.time_limit {
            return false;
        }
        match item {
            Inbound::Command(command) if command.tick != tick => return false,
            Inbound::Carried(_) => return false,
            _ => {}
        }
        self.queued.entry(tick).or_default().push(item);
        true
    }

    pub fn step(&mut self, mechanics: &impl Mechanics) -> Option<CompletedTick> {
        self.step_with_bots(mechanics, None)
    }

    fn step_with_bots(
        &mut self,
        mechanics: &impl Mechanics,
        bot_rules: Option<&Combat>,
    ) -> Option<CompletedTick> {
        if self.finished || self.tick == self.time_limit {
            return None;
        }
        let tick = self.tick + 1;
        let mut inbound: Vec<_> = self
            .carried
            .drain(..)
            .map(Inbound::Carried)
            .chain(self.queued.remove(&tick).into_iter().flatten())
            .collect();

        // Plan against T-1. Seat observations decide which controller owns T's input,
        // while teleports and the other observations cannot affect the planner's view.
        let generated =
            bot_rules.map_or_else(Vec::new, |rules| bots::collect(self, rules, tick, &inbound));
        let start = output::Before::new(&self.state);
        let teleported = self.observe(&inbound);
        for &(body, _) in &teleported {
            if let BodyId::Actor(actor) = body {
                self.bots.clear_route(actor);
            }
        }
        inbound.extend(generated.into_iter().map(Inbound::Command));
        let commands = self.commands(tick, &inbound);
        let mut writes = Intake::default();
        let mut intake_facts = Vec::new();
        if !teleported.is_empty() {
            let warped: BTreeSet<_> = teleported.iter().map(|&(body, _)| body).collect();
            self.state.hooks.retain(|_, hook| {
                let owner_warped = warped.contains(&BodyId::Actor(hook.owner));
                let target_warped = matches!(hook.phase, HookPhase::Pulling { target, .. }
                    if warped.contains(&BodyId::Actor(target)));
                if owner_warped || target_warped {
                    intake_facts.push(Fact::HookReleased {
                        owner: hook.owner,
                        reason: HookRelease::Relocated,
                    });
                    false
                } else {
                    true
                }
            });
        }
        apply::reward_kills(&mut self.state, &inbound, &mut intake_facts);
        let bodies = self.bodies.before_solve();
        let before = IntakeView {
            start: self.view(tick),
            bodies: &bodies,
        };
        let intents = mechanics.intake(before, &inbound, &commands, &mut writes);
        for (id, aim) in writes.aim {
            if let Some(actor) = self.state.actors.get_mut(&id) {
                actor.aim = aim;
            }
        }
        for (id, sneak) in writes.sneak {
            if let Some(actor) = self.state.actors.get_mut(&id) {
                actor.sneak = sneak;
            }
        }
        for (id, window) in writes.boosts {
            if let Some(actor) = self.state.actors.get_mut(&id) {
                actor.statuses.insert(Status::Boost, window);
            }
        }
        for (id, ready_at) in writes.skill_ready_at {
            if let Some(actor) = self.state.actors.get_mut(&id) {
                actor.deadlines.skill_ready_at = ready_at;
            }
        }
        for (id, ready_at) in writes.weapon_ready_at {
            self.state
                .actors
                .get_mut(&id)
                .expect("weapon user")
                .deadlines
                .weapon_ready_at = ready_at;
        }
        for (id, inventory) in writes.inventories {
            self.state
                .actors
                .get_mut(&id)
                .expect("inventory owner")
                .inventory = inventory;
        }
        for (id, change) in writes.hooks {
            if let Some(hook) = change {
                self.state.hooks.insert(id, hook);
            } else {
                self.state.hooks.remove(&id);
            }
        }
        if let Some(wall_x) = self.hazard_map.wall_at(tick) {
            self.state.hazard_x = Some(wall_x);
        }
        let impulses = apply::impulses(inbound.iter().filter_map(|entry| match *entry {
            Inbound::Carried(Carried::Impulse { body, impulse }) => Some((body, impulse)),
            _ => None,
        }));
        let solved = self.bodies.step(&writes.motors, &impulses, &writes.tethers);
        let effects = mechanics.resolve(
            ResolveView {
                start: self.view(tick),
                solved: &solved,
                launched_projectiles: &writes.projectiles,
                history: &self.history,
            },
            &intents,
        );
        intake_facts.extend(writes.facts);
        let (mut changes, mut discontinuities) =
            self.apply(tick, mechanics, &solved, effects, intake_facts, start);
        for (body, request) in teleported {
            if let Some(pose) = self.bodies.pose(body) {
                changes.poses.insert(body, pose);
                discontinuities.push(Discontinuity::Warped(body));
            }
            discontinuities.push(Discontinuity::DevWarped { body, request });
        }
        discontinuities.sort_unstable();
        discontinuities.dedup();
        self.cues.publish(&changes.events);
        let discovery = self.discover(tick, &inbound);
        self.remember(&discovery);
        self.tick = tick;
        #[cfg(test)]
        {
            let mut mirror = self.mirror.take().expect("mirror");
            mirror.apply(tick, &changes, &discontinuities);
            assert_eq!(
                mirror,
                self.snapshot(),
                "the mirror diverged at tick {tick}"
            );
            self.mirror = Some(mirror);
        }
        Some(CompletedTick {
            tick,
            inbound,
            solved,
            changes,
            discontinuities,
            discovery,
        })
    }

    /// Observations enter as recorded inbound records, never as writes between ticks (27.2
    /// Boundary). Input lead is the receive boundary's and changes no match state. A dev
    /// teleport moves its body before the solve and returns it as a discontinuity.
    fn observe(&mut self, inbound: &[Inbound]) -> Vec<(BodyId, u32)> {
        let mut teleported = Vec::new();
        let mut request = 0u32;
        for entry in inbound {
            let Inbound::Observation(observation) = *entry else {
                continue;
            };
            match observation {
                Observation::ViewLag { actor, ticks } => {
                    if let Some(record) = self.state.actors.get_mut(&actor) {
                        record.view_lag = ticks;
                    }
                }
                Observation::InputLead { .. } => {}
                Observation::Join { actor, .. } | Observation::Leave { actor } => {
                    if let Some(record) = self.state.actors.get_mut(&actor) {
                        record.bot = matches!(observation, Observation::Leave { .. });
                        if let Observation::Join { kit: Some(kit), .. } = observation {
                            record.kit = Some(kit);
                        }
                        // A bot sees the world directly and is compensated for nothing.
                        record.view_lag = 0;
                        self.input.reset(actor);
                    }
                }
                Observation::Teleport { body, to } => {
                    let ordinal = request;
                    request += 1;
                    if !self.teleport_clear(body, to) {
                        continue;
                    }
                    if let Some(angle) = self.bodies.angle(body) {
                        self.bodies.warp(body, to, angle);
                        teleported.push((body, ordinal));
                    }
                }
            }
        }
        teleported
    }

    /// A dev teleport's destination (24). An actor moves only while active, and only to a point inside
    /// the bounds where it can stand: static geometry within `STATIC_TOLERANCE`, closed gates and
    /// solid props touched but not entered, and clear of every other active actor, as the old dev
    /// operation's occupancy rule refused. Any other body is a scenario's
    /// arrangement and moves unchecked, as before.
    fn teleport_clear(&mut self, body: BodyId, to: Point) -> bool {
        let BodyId::Actor(actor) = body else {
            return true;
        };
        let Some(radius) = self.bodies.dynamic_radius(body) else {
            return false;
        };
        if !self.state.active(actor) || !to[0].is_finite() || !to[1].is_finite() {
            return false;
        }
        let [x, y] = to;
        if self.bounds.is_some_and(|[min_x, min_y, max_x, max_y]| {
            x - radius < min_x || x + radius > max_x || y - radius < min_y || y + radius > max_y
        }) {
            return false;
        }
        let before = self.bodies.before_solve();
        let gates = &self.state.gates;
        if !self
            .geometry
            .disk_clear(to, radius, STATIC_TOLERANCE, &before.solid_props, |index| {
                gates
                    .get(&GateId(index as u32))
                    .is_some_and(|gate| gate.open)
            })
        {
            return false;
        }
        let others: Vec<_> = self
            .state
            .actors
            .keys()
            .filter(|&&other| other != actor && self.state.active(other))
            .map(|&other| BodyId::Actor(other))
            .collect();
        others.into_iter().all(|other| {
            match (before.position(other), self.bodies.dynamic_radius(other)) {
                (Some([ox, oy]), Some(r)) => crate::math::hypot(x - ox, y - oy) >= radius + r,
                _ => true,
            }
        })
    }

    /// R12: discovery samples after the terminal check and rewind capture, so a stranded,
    /// escaped or departed contestant does not sample, and an eye uses its committed pose.
    /// Applies a discovery to the contestants' memory. A line-of-sight sample reads the ground
    /// records (#1301): an item is where its body is, or at its stored spot while it has none.
    fn remember(&mut self, discovery: &Discovery) {
        let (state, bodies) = (&self.state, &mut self.bodies);
        discovery::remember(
            discovery,
            state,
            self.sampler.as_mut(),
            || {
                state
                    .items
                    .iter()
                    .filter_map(|(&id, item)| {
                        let at = item.position(bodies.position(BodyId::Item(id)))?;
                        Some((id, at, *item))
                    })
                    .collect()
            },
            &mut self.memory,
        );
    }

    /// The opening discovery, before the first frame and the first bot intent: every active
    /// contestant samples at its starting pose, as the old game discovers when it creates a
    /// player (`shared/simulation/state.ts`). Tick 0 and T1's intent then agree on what each
    /// contestant already knows.
    fn open_discovery(&mut self) {
        let bodies = &mut self.bodies;
        let samples = self
            .state
            .actors
            .iter()
            .filter(|(id, actor)| {
                id.kind == ActorKind::Contestant && actor.presence == Presence::Active
            })
            .filter_map(|(&actor, _)| {
                let eye = bodies.position(BodyId::Actor(actor))?;
                Some(DiscoverySample { actor, eye })
            })
            .collect();
        self.remember(&Discovery {
            gates: Vec::new(),
            samples,
        });
    }

    fn discover(&mut self, tick: Tick, inbound: &[Inbound]) -> Discovery {
        let contestants: Vec<_> = self
            .state
            .actors
            .iter()
            .filter(|(id, _)| id.kind == ActorKind::Contestant)
            .map(|(&id, actor)| (id, actor.presence == Presence::Active))
            .collect();
        let bodies = &mut self.bodies;
        Discovery {
            gates: discovery::gate_observations(inbound),
            samples: discovery::samples(
                tick,
                contestants.into_iter().map(|(id, active)| {
                    (
                        id,
                        active.then(|| bodies.position(BodyId::Actor(id))).flatten(),
                    )
                }),
            ),
        }
    }

    /// R12 and R3: the committed state after apply, including same-tick admissions, warps
    /// and removals. Items and gates are recorded only where they changed.
    fn capture(&mut self, solved: &Solved, admitted: &[ItemId], facts: &[Fact]) -> RewindFrame {
        let mut frame = RewindFrame::default();
        for (&id, actor) in &self.state.actors {
            if actor.presence == Presence::Active
                && let Some(pose) = self.bodies.position(BodyId::Actor(id))
            {
                frame.poses.insert(id, pose);
            }
        }
        for body in solved.bodies() {
            let BodyId::Item(id) = body else { continue };
            let before = solved.path(body).expect("solved body")[0];
            if let Some(after) = self.bodies.position(body)
                && after != before
            {
                frame.items.insert(id, after);
                frame.items_before.insert(id, before);
            }
        }
        for &id in admitted {
            if let Some(after) = self.bodies.position(BodyId::Item(id)) {
                frame.items.insert(id, after);
            }
        }
        for fact in facts {
            if let Fact::GateChanged { gate, open, .. } = *fact {
                frame.gates_before.entry(gate).or_insert(!open);
                frame.gates.insert(gate, self.state.gates[&gate].open);
            }
        }
        frame
    }

    fn view(&self, tick: Tick) -> View<'_> {
        View {
            tick,
            seed: self.seed,
            state: &self.state,
            geometry: &self.geometry,
            sight: &self.sight,
            sight_gates: &self.sight_gates,
            bounds: self.bounds,
            hazard_map: &self.hazard_map,
            sites: &self.sites,
        }
    }

    fn commands(&mut self, tick: Tick, inbound: &[Inbound]) -> Vec<Command> {
        let mut newest = BTreeMap::<ActorId, Command>::new();
        for entry in inbound {
            let Inbound::Command(command) = *entry else {
                continue;
            };
            if newest
                .get(&command.actor)
                .is_none_or(|old| old.seq < command.seq)
            {
                newest.insert(command.actor, command);
            }
        }
        let mut commands = Vec::new();
        for &id in self.state.actors.keys() {
            if !self.state.active(id) {
                continue;
            }
            if let Some(&command) = newest.get(&id).filter(|command| {
                self.input
                    .acknowledged(id)
                    .is_none_or(|seq| seq < command.seq)
            }) {
                self.input.spend(command);
                commands.push(command);
            } else if let Some(command) = self.input.held(id, tick) {
                commands.push(command);
            }
        }
        commands
    }

    fn apply<M: Mechanics>(
        &mut self,
        tick: Tick,
        mechanics: &M,
        solved: &Solved,
        mut effects: Effects<M::Claim, M::Placement>,
        mut facts: Vec<Fact>,
        start: output::Before,
    ) -> (Changes, Vec<Discontinuity>) {
        // Merge first. Mark eliminations now so none of these actors can win a later claim.
        let deaths = apply::merge(&mut self.state, self.seed, tick, &mut effects);
        let mut commit = Commit {
            lifecycle: effects.lifecycle,
            ..Commit::default()
        };
        for death in &deaths {
            self.state
                .actors
                .get_mut(&death.actor)
                .expect("eliminated actor")
                .presence = Presence::Eliminated;
            facts.push(Fact::Eliminated { actor: death.actor });
        }
        apply::credit_eliminations(&mut self.state, self.seed, tick, &deaths, &mut commit);
        mechanics.eliminations(
            self.view(tick),
            &deaths,
            &mut effects.placements,
            &mut commit,
        );

        effects
            .claims
            .retain(|(actor, _)| self.state.active(*actor));
        let mut placement = Placement {
            pending: effects.placements,
            reserved: BTreeMap::new(),
        };
        let view = ClaimView {
            tick,
            seed: self.seed,
            solved,
            geometry: &self.geometry,
            bounds: self.bounds,
            sight_gates: &self.sight_gates,
            bodies: &self.bodies,
        };
        mechanics.claims(
            &mut self.state,
            view,
            effects.claims,
            &mut placement,
            &mut commit,
        );
        let placed = mechanics.place(&mut self.state, view, placement, &mut commit);
        let hooks = effects.new_hooks.into_iter().filter_map(|(owner, hook)| {
            let lost_target = matches!(hook.phase, HookPhase::Pulling { target, .. } if !self.state.active(target));
            if !self.state.active(owner) || lost_target {
                facts.push(Fact::HookReleased { owner, reason: HookRelease::EndpointGone });
                return None;
            }
            Some((SpawnKey { source: Entity::Actor(owner), ordinal: 0 }, Spawn::Hook(hook)))
        });
        let projectiles = effects
            .new_projectiles
            .into_iter()
            .map(|(key, projectile)| (key, Spawn::Projectile(projectile)));
        let mut placed: Vec<_> = placed.into_iter().chain(projectiles).chain(hooks).collect();
        placed.sort_by_key(|(key, _)| *key);
        let additions = self.ids.spawn(&mut self.state, placed, &mut facts);
        let admitted = additions.admitted_items();
        let mut touched = output::Touched::default();
        touched.lifecycle(&commit.lifecycle);

        let synced = apply::sync(
            &mut self.state,
            &mut self.bodies,
            commit.lifecycle,
            additions,
            &deaths,
            &mut facts,
        );
        let removed = &synced.removed;
        for &body in removed {
            if let BodyId::Actor(actor) = body {
                self.input.reset(actor);
            }
        }
        for (id, deadlines) in commit.deadlines {
            if let Some(actor) = self.state.actors.get_mut(&id) {
                actor.deadlines = deadlines;
            }
        }

        self.carried = commit.carried;
        self.carried.extend(
            apply::impulses(effects.impulses)
                .into_iter()
                .filter(|(body, _)| solved.path(*body).is_some() && !removed.contains(body))
                .map(|(body, impulse)| Carried::Impulse { body, impulse }),
        );
        let mut synced = vec![synced];
        // R12: a started tick completes, then any terminal predicate ends the match.
        let slots_spent = self.state.extraction.is_some_and(|exit| exit.slots == 0);
        let contestant_active = self.state.actors.iter().any(|(id, actor)| {
            id.kind == ActorKind::Contestant && actor.presence == Presence::Active
        });
        self.finished = tick == self.time_limit || slots_spent || !contestant_active;
        if self.finished {
            let stranded = self
                .state
                .actors
                .iter()
                .filter_map(|(&id, actor)| {
                    (id.kind == ActorKind::Contestant && actor.presence == Presence::Active)
                        .then_some(Lifecycle::SetPresence {
                            actor: id,
                            presence: Presence::Stranded,
                        })
                })
                .collect();
            let strand = apply::sync(
                &mut self.state,
                &mut self.bodies,
                stranded,
                apply::Additions::default(),
                &[],
                &mut facts,
            );
            for &body in &strand.removed {
                if let BodyId::Actor(actor) = body {
                    self.input.reset(actor);
                }
            }
            synced.push(strand);
            self.queued.clear();
            facts.push(Fact::Finished);
        }
        facts.extend(effects.facts);
        facts.extend(commit.facts);
        let frame = self.capture(solved, &admitted, &facts);
        self.history.insert(tick, frame);
        facts.retain(|fact| match *fact {
            Fact::HookAttached { owner, target } => self.state.hooks.values().any(|hook| {
                hook.owner == owner
                    && matches!(hook.phase, HookPhase::Pulling { target: to, .. } if to == target)
            }),
            Fact::Placed {
                placed: Entity::Hook(id),
                ..
            } => self.state.hooks.contains_key(&id),
            _ => true,
        });
        let events = self.ids.publish(tick, facts.clone());
        output::changes(
            start,
            touched,
            &self.state,
            &mut self.bodies,
            solved,
            &synced,
            &facts,
            events,
        )
    }
}

#[cfg(test)]
mod tests;
