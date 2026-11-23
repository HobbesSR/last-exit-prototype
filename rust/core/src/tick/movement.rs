//! Movement, Overdrive and hook skill rules at the intake and resolve boundaries.

use std::collections::{BTreeMap, BTreeSet};
use std::convert::Infallible;

use crate::floor_drag::{Floor, SURFACE_STRIDE};
use crate::math::{cos, sin};
use crate::swept::Grid;
use crate::world::MAX_CONSTRAINTS;

use super::hook;
use super::motor::{MotorInput, motor, surface_order};
use super::*;

const HOOK_CAPACITY_CONTEST: u64 = 0x686f_6f6b_0000_0001;

pub struct Movement {
    pub motor: MotorTuning,
    surfaces: Vec<MotorSurface>,
    surface_index: Grid,
    pub hook: HookTuning,
    pub boost_duration: Tick,
    pub boost_cooldown: Tick,
}

impl Default for Movement {
    fn default() -> Self {
        Self {
            motor: MotorTuning {
                base_speed: [180.0, 160.0],
                boost: [1.45, 1.5],
                stun: 0.35,
                sneak: 0.55,
                acceleration: 3600.0,
                braking: 3600.0,
            },
            surfaces: Vec::new(),
            surface_index: Grid::for_bounds([]),
            hook: HookTuning::default(),
            boost_duration: 55,
            boost_cooldown: 95,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum MovementIntent {
    Boost(ActorId),
    Launch(Hook),
    Release { owner: ActorId, reason: HookRelease },
}

impl Movement {
    pub fn with_surfaces(mut self, mut surfaces: Vec<MotorSurface>) -> Self {
        surfaces.sort_unstable_by(surface_order);
        self.surface_index = Grid::for_bounds(surfaces.iter().map(|surface| {
            [
                surface.origin[0],
                surface.origin[1],
                surface.size[0],
                surface.size[1],
            ]
        }));
        self.surfaces = surfaces;
        self
    }

    /// Bake drag rules once, with the same authored overlap order as actor motors.
    pub fn floor_drag(&self, loot: [f64; 2], prop: [f64; 2]) -> Floor {
        let mut rows = Vec::with_capacity(4 + self.surfaces.len() * SURFACE_STRIDE);
        rows.extend(loot);
        rows.extend(prop);
        for surface in &self.surfaces {
            rows.extend(surface.origin);
            rows.extend(surface.size);
            rows.push(surface.drag.unwrap_or(1.0));
        }
        Floor::from_input(&rows).indexed()
    }

    pub fn prepare(
        &self,
        view: &IntakeView<'_>,
        commands: &[Command],
        writes: &mut Intake,
    ) -> Vec<MovementIntent> {
        let tick = view.start.tick;
        let state = view.start.state;
        let inputs: BTreeMap<_, _> = commands
            .iter()
            .map(|command| (command.actor, command.input))
            .collect();
        let mut intents = Vec::new();
        let mut consumed_skill = BTreeSet::new();
        let mut active_hooks = 0;
        for (&id, &record) in &state.hooks {
            let owns_hook = state.actors.get(&record.owner).is_some_and(|owner| {
                owner.presence == Presence::Active && owner.kit == Some(Kit::Hook)
            });
            let change = if !owns_hook {
                Err(HookRelease::EndpointGone)
            } else if tick < record.expires_at
                && inputs.get(&record.owner).is_some_and(|input| input.skill)
            {
                consumed_skill.insert(record.owner);
                Err(HookRelease::Cancelled)
            } else {
                hook::prepare(&self.hook, view, record)
            };
            match change {
                Ok(update) => {
                    active_hooks += 1;
                    if let Some((next, tether)) = update {
                        writes.hooks.insert(id, Some(next));
                        writes.tethers.insert(id, tether);
                    }
                }
                Err(reason) => {
                    writes.hooks.insert(id, None);
                    intents.push(MovementIntent::Release {
                        owner: record.owner,
                        reason,
                    });
                }
            }
        }

        let mut launches = Vec::new();
        for (&id, actor) in &state.actors {
            let body = BodyId::Actor(id);
            let Some(position) = view.bodies.position(body).filter(|_| state.active(id)) else {
                continue;
            };
            let input = inputs.get(&id).copied().unwrap_or_default();
            let aim = input.aim.unwrap_or(actor.aim);
            if input.aim.is_some() {
                writes.aim.insert(id, aim);
            }
            let sneak = input.sneak && id.kind == ActorKind::Contestant;
            if sneak != actor.sneak {
                writes.sneak.insert(id, sneak);
            }
            let status = |kind| {
                actor
                    .statuses
                    .get(&kind)
                    .is_some_and(|window| window.contains(tick))
            };
            let mut boosted = status(Status::Boost);
            if input.skill && id.kind == ActorKind::Gladiator && !consumed_skill.contains(&id) {
                match actor.kit {
                    Some(Kit::Striker | Kit::Hook) if tick < actor.deadlines.skill_ready_at => {
                        writes.facts.push(Fact::Rejected {
                            actor: id,
                            reason: Rejection::SkillCooldown,
                        });
                    }
                    Some(Kit::Striker) => {
                        let cooldown = self
                            .boost_cooldown
                            .saturating_sub(12 * u32::from(actor.level.saturating_sub(1)))
                            .max(45);
                        writes
                            .skill_ready_at
                            .insert(id, tick.saturating_add(cooldown));
                        writes.boosts.insert(
                            id,
                            Window {
                                active_from: tick,
                                expires_at: tick.saturating_add(self.boost_duration),
                            },
                        );
                        boosted = self.boost_duration != 0 || boosted;
                        intents.push(MovementIntent::Boost(id));
                    }
                    Some(Kit::Hook) => {
                        launches.push(Hook {
                            owner: id,
                            expires_at: tick.saturating_add(self.hook.duration),
                            phase: HookPhase::Flying {
                                position,
                                direction: [cos(aim), sin(aim)],
                                travelled: 0.0,
                            },
                        });
                    }
                    _ => {}
                }
            }
            writes.motors.insert(
                body,
                motor(
                    &self.motor,
                    self.surface_index
                        .at(position[0], position[1])
                        .into_iter()
                        .map(|i| &self.surfaces[i as usize]),
                    MotorInput {
                        kind: id.kind,
                        position,
                        axes: input.movement,
                        boosted,
                        stunned: status(Status::Stun),
                        sneak,
                    },
                ),
            );
        }

        let available = MAX_CONSTRAINTS.saturating_sub(active_hooks);
        if launches.len() > available {
            launches.sort_unstable_by_key(|hook| {
                (
                    contest_score(
                        view.start.seed,
                        tick,
                        HOOK_CAPACITY_CONTEST,
                        actor_word(hook.owner),
                    ),
                    hook.owner,
                )
            });
        }
        for (index, launch) in launches.into_iter().enumerate() {
            if index < available {
                writes
                    .skill_ready_at
                    .insert(launch.owner, tick.saturating_add(self.hook.cooldown));
                intents.push(MovementIntent::Launch(launch));
            } else {
                writes.facts.push(Fact::Rejected {
                    actor: launch.owner,
                    reason: Rejection::HookCapacity,
                });
            }
        }
        intents
    }

    pub fn resolve_into<C, P>(
        &self,
        view: &ResolveView<'_>,
        intents: impl IntoIterator<Item = MovementIntent>,
        effects: &mut Effects<C, P>,
    ) {
        effects
            .facts
            .extend(view.solved.contacts.iter().copied().map(Fact::Contact));
        for (&id, &record) in &view.start.state.hooks {
            let result = match record.phase {
                HookPhase::Flying { .. } => hook::sweep(&self.hook, view, record),
                HookPhase::Pulling { .. } if view.solved.tether_broke(id) => {
                    Err(HookRelease::Separation)
                }
                _ => continue,
            };
            match result {
                Ok(next) => {
                    effects
                        .lifecycle
                        .push(Lifecycle::UpdateHook { id, hook: next });
                    attached(&mut effects.facts, next);
                }
                Err(reason) => {
                    effects.lifecycle.push(Lifecycle::RemoveHook(id));
                    effects.facts.push(Fact::HookReleased {
                        owner: record.owner,
                        reason,
                    });
                }
            }
        }
        for intent in intents {
            match intent {
                MovementIntent::Boost(actor) => effects.facts.push(Fact::Boosted { actor }),
                MovementIntent::Release { owner, reason } => {
                    effects.facts.push(Fact::HookReleased { owner, reason })
                }
                MovementIntent::Launch(launch) => {
                    effects.facts.push(Fact::HookFired {
                        owner: launch.owner,
                    });
                    match hook::sweep(&self.hook, view, launch) {
                        Ok(next) => {
                            effects.new_hooks.insert(launch.owner, next);
                            attached(&mut effects.facts, next);
                        }
                        Err(reason) => effects.facts.push(Fact::HookReleased {
                            owner: launch.owner,
                            reason,
                        }),
                    }
                }
            }
        }
    }
}

fn attached(facts: &mut Vec<Fact>, hook: Hook) {
    if let HookPhase::Pulling { target, .. } = hook.phase {
        facts.push(Fact::HookAttached {
            owner: hook.owner,
            target,
        });
    }
}

impl Mechanics for Movement {
    type Intent = MovementIntent;
    type Claim = Infallible;
    type Placement = Infallible;

    fn intake(
        &self,
        view: IntakeView<'_>,
        _inbound: &[Inbound],
        commands: &[Command],
        writes: &mut Intake,
    ) -> Vec<Self::Intent> {
        self.prepare(&view, commands, writes)
    }

    fn resolve(
        &self,
        view: ResolveView<'_>,
        intents: &[Self::Intent],
    ) -> Effects<Self::Claim, Self::Placement> {
        let mut effects = Effects::default();
        self.resolve_into(&view, intents.iter().copied(), &mut effects);
        effects
    }

    fn claims(
        &self,
        _state: &mut State,
        _view: ClaimView<'_>,
        _claims: Vec<(ActorId, Self::Claim)>,
        _placement: &mut Placement<Self::Placement>,
        _commit: &mut Commit,
    ) {
    }

    fn place(
        &self,
        _state: &mut State,
        _view: ClaimView<'_>,
        placement: Placement<Self::Placement>,
        _commit: &mut Commit,
    ) -> BTreeMap<SpawnKey, Spawn> {
        placement.reserved
    }
}
