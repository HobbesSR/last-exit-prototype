//! The unwired intake → solve → resolve → apply runner (27.2).
//! The WASM adapter still calls the seven-phase tick.

mod apply;
mod hook;
mod input;
mod motor;
mod movement;
mod order;
mod solve;
mod state;
mod sweep;

pub use apply::{
    Commit, Effects, Elimination, Event, Fact, HookRelease, Lifecycle, Rejection, Spawn, SpawnKey,
    StatusEffect, VitalEffect,
};
pub use hook::HookTuning;
pub use input::{
    AmmoFamily, Carried, Command, CommandSource, DropSlot, Inbound, Input, Observation, Target,
};
pub use motor::{MotorSurface, MotorTuning};
pub use movement::{Movement, MovementIntent};
pub use order::{actor_word, contest_score, scatter_score};
pub use solve::{BeforeSolve, BodySpec, Contact, ContactKind, Motor, Path, Solved, Tether};
pub use state::*;

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::floor_drag::Floor;
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
    pub motors: BTreeMap<BodyId, Motor>,
    pub tethers: BTreeMap<HookId, Tether>,
    pub hooks: BTreeMap<HookId, Option<Hook>>,
    pub rejections: Vec<Fact>,
}

pub struct ResolveView<'a> {
    pub start: View<'a>,
    pub solved: &'a Solved,
}

pub struct ClaimView<'a> {
    pub tick: Tick,
    pub seed: u64,
    pub solved: &'a Solved,
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
        after_claims: ResolveView<'_>,
        placement: Placement<Self::Placement>,
        commit: &mut Commit,
    ) -> BTreeMap<SpawnKey, Spawn>;

    fn terminal(&self, _state: View<'_>) -> bool {
        false
    }
}

pub struct Placement<P> {
    pub pending: Vec<P>,
    /// Successful swaps already reserved these placements in the claims stage.
    pub reserved: BTreeMap<SpawnKey, Spawn>,
}

pub struct CompletedTick {
    pub tick: Tick,
    pub inbound: Vec<Inbound>,
    pub solved: Solved,
    pub events: Vec<Event>,
}

/// Assemble an isolated match using stable IDs, without an adapter or the old tick.
#[derive(Default)]
pub struct Scenario {
    pub state: State,
    body_specs: BTreeMap<BodyId, BodySpec>,
    geometry: Option<Arc<SweptMap>>,
    floor: Option<Floor>,
}

impl Scenario {
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

    pub fn floor_drag(&mut self, floor: Floor) -> &mut Self {
        self.floor = Some(floor);
        self
    }

    pub fn start(self, seed: u64, time_limit: Tick) -> Match {
        let ids = Ids::from_state(&self.state);
        let mut bodies = Bodies::default();
        for (id, spec) in self.body_specs {
            bodies.insert(id, spec);
        }
        if let Some(floor) = self.floor {
            bodies.use_floor(floor);
        }
        Match {
            state: self.state,
            bodies,
            geometry: self
                .geometry
                .unwrap_or_else(|| Arc::new(SweptMap::new(vec![], vec![], vec![]))),
            seed,
            time_limit,
            tick: 0,
            ids,
            input: InputState::default(),
            queued: BTreeMap::new(),
            carried: Vec::new(),
            finished: false,
        }
    }
}

pub struct Match {
    state: State,
    bodies: Bodies,
    geometry: Arc<SweptMap>,
    seed: u64,
    time_limit: Tick,
    tick: Tick,
    ids: Ids,
    input: InputState,
    queued: BTreeMap<Tick, Vec<Inbound>>,
    carried: Vec<Carried>,
    finished: bool,
}

impl Match {
    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn position(&mut self, id: BodyId) -> Option<Point> {
        self.bodies.position(id)
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
        if self.finished || self.tick == self.time_limit {
            return None;
        }
        let tick = self.tick + 1;
        let inbound: Vec<_> = self
            .carried
            .drain(..)
            .map(Inbound::Carried)
            .chain(self.queued.remove(&tick).into_iter().flatten())
            .collect();

        let commands = self.commands(tick, &inbound);
        let mut writes = Intake::default();
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
        for (id, change) in writes.hooks {
            if let Some(hook) = change {
                self.state.hooks.insert(id, hook);
            } else {
                self.state.hooks.remove(&id);
            }
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
            },
            &intents,
        );
        let events = self.apply(tick, mechanics, &solved, effects, writes.rejections);
        self.tick = tick;
        Some(CompletedTick {
            tick,
            inbound,
            solved,
            events,
        })
    }

    fn view(&self, tick: Tick) -> View<'_> {
        View {
            tick,
            seed: self.seed,
            state: &self.state,
            geometry: &self.geometry,
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
    ) -> Vec<Event> {
        // Merge first. Mark eliminations now so none of these actors can win a later claim.
        let deaths = apply::merge(&mut self.state, &mut effects);
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
        mechanics.claims(
            &mut self.state,
            ClaimView {
                tick,
                seed: self.seed,
                solved,
            },
            effects.claims,
            &mut placement,
            &mut commit,
        );
        let placed = mechanics.place(
            ResolveView {
                start: self.view(tick),
                solved,
            },
            placement,
            &mut commit,
        );
        self.ids
            .spawn(&mut self.state, &mut self.bodies, placed, &mut facts);
        let hooks = effects.new_hooks.into_iter().filter_map(|(owner, hook)| {
            let lost_target = matches!(hook.phase, HookPhase::Pulling { target, .. } if !self.state.active(target));
            if !self.state.active(owner) || lost_target {
                facts.push(Fact::HookReleased { owner, reason: HookRelease::EndpointGone });
                return None;
            }
            Some((SpawnKey { source: Entity::Actor(owner), ordinal: 0 }, Spawn::Hook(hook)))
        }).collect();
        self.ids
            .spawn(&mut self.state, &mut self.bodies, hooks, &mut facts);

        let deactivated = apply::sync(
            &mut self.state,
            &mut self.bodies,
            commit.lifecycle,
            &deaths,
            &mut facts,
        );
        for actor in deactivated {
            self.input.reset(actor);
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
                .map(|(body, impulse)| Carried::Impulse { body, impulse }),
        );
        self.finished = tick == self.time_limit || mechanics.terminal(self.view(tick));
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
            for actor in apply::sync(&mut self.state, &mut self.bodies, stranded, &[], &mut facts) {
                self.input.reset(actor);
            }
            self.queued.clear();
            facts.push(Fact::Finished);
        }
        facts.extend(effects.facts);
        facts.extend(commit.facts);
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
        self.ids.publish(tick, facts)
    }
}

#[cfg(test)]
mod tests;
