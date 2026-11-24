use super::*;
use crate::physics::{BodyParams, KIND_ACTOR, SHAPE_CIRCLE};

mod admission_tests;
mod codec_tests;
mod combat_tests;
mod hazard_tests;
mod hazard_trap_tests;
mod interaction_tests;
mod item_tests;
mod movement_tests;
mod output_tests;
mod terminal_tests;

const A: ActorId = ActorId {
    kind: ActorKind::Contestant,
    seat: 10,
};
const B: ActorId = ActorId {
    kind: ActorKind::Gladiator,
    seat: 2,
};
const C: ActorId = ActorId {
    kind: ActorKind::Contestant,
    seat: 2,
};

type TestEffects = Effects<(), ActorId>;
type Resolve = fn(ResolveView<'_>, &[Command]) -> TestEffects;

struct Rules(Resolve);

impl Mechanics for Rules {
    type Intent = Command;
    type Claim = ();
    type Placement = ActorId;

    fn intake(
        &self,
        before: IntakeView<'_>,
        _inbound: &[Inbound],
        commands: &[Command],
        writes: &mut Intake,
    ) -> Vec<Command> {
        assert!(
            commands
                .iter()
                .all(|command| before.start.state.active(command.actor))
        );
        for command in commands {
            if let Some(aim) = command.input.aim {
                writes.aim.insert(command.actor, aim);
            }
            if command.input.movement != [0.0; 2] {
                writes.motors.insert(
                    BodyId::Actor(command.actor),
                    Motor {
                        velocity: command.input.movement,
                        acceleration: 500.0,
                    },
                );
            }
        }
        commands.to_vec()
    }

    fn resolve(&self, view: ResolveView<'_>, commands: &[Command]) -> TestEffects {
        (self.0)(view, commands)
    }

    fn claims(
        &self,
        state: &mut State,
        _view: ClaimView<'_>,
        claims: Vec<(ActorId, ())>,
        placement: &mut Placement<ActorId>,
        _commit: &mut Commit,
    ) {
        for (actor, ()) in claims {
            assert!(state.active(actor));
            placement.pending.push(actor);
        }
    }

    fn place(
        &self,
        state: &mut State,
        view: ClaimView<'_>,
        mut placement: Placement<ActorId>,
        _commit: &mut Commit,
    ) -> BTreeMap<SpawnKey, Spawn> {
        for actor in placement.pending {
            assert!(state.active(actor));
            placement.reserved.insert(
                SpawnKey {
                    source: Entity::Actor(actor),
                    ordinal: 0,
                },
                Spawn::Item {
                    id: None,
                    item: GroundItem {
                        building: None,
                        pickup_ready_at: view.tick + 1,
                        ..pending_item()
                    },
                    body: None,
                },
            );
        }
        placement.reserved
    }
}

fn actor(presence: Presence) -> Actor {
    Actor {
        presence,
        kit: None,
        level: 1,
        kills: 0,
        hp: 90.0,
        max_hp: 100.0,
        shield: 0.0,
        max_shield: 15.0,
        aim: 0.0,
        sneak: false,
        view_lag: 0,
        inventory: Inventory::default(),
        charging: None,
        respawn_at: None,
        transit: None,
        bot: false,
        aggression: None,
        deadlines: Deadlines::default(),
        statuses: BTreeMap::new(),
    }
}

/// A bodiless contestant that keeps a scenario's match open once its own contestants
/// leave, or when it has none, since R12 ends a match with no active contestant.
const BYSTANDER: ActorId = ActorId {
    kind: ActorKind::Contestant,
    seat: 99,
};

fn keep_open(scenario: &mut Scenario) {
    scenario
        .state
        .actors
        .insert(BYSTANDER, actor(Presence::Active));
}

fn pending_item() -> GroundItem {
    GroundItem {
        building: None,
        loot: Loot::Equipment(Equipment {
            kind: EquipmentKind::Cell { charge: 0 },
            quality: 1,
        }),
        lineage: None,
        unplaced_at: Some([0.0; 2]),
        dropped_by: None,
        pickup_ready_at: 0,
    }
}

fn body(x: f64) -> BodySpec {
    BodySpec {
        params: BodyParams {
            kind: KIND_ACTOR,
            map_geometry: false,
            pose: [x, 0.0, 0.0, 0.0, 0.0, 0.0],
            material: [1.0, 0.0, 0.0],
            damping: [Some(0.0); 2],
            groups: 0xffff_ffff,
        },
        shape: SHAPE_CIRCLE,
        dimensions: [1.0, 0.0],
        vertices: Vec::new(),
        speed_limit: 1_000.0,
        tip_radius: 0.0,
    }
}

/// Whether `actor` escaped with `cell` in the tick, whatever slots remained.
fn escaped(tick: &CompletedTick, actor: ActorId, cell: ItemId) -> bool {
    tick.changes.events.iter().any(|event| {
        matches!(event.fact, Fact::Escaped { actor: a, cell: c, .. } if a == actor && c == cell)
    })
}

fn submit(game: &mut Match, actor: ActorId, tick: Tick, seq: u64, input: Input) {
    assert!(game.submit(
        tick,
        Inbound::Command(Command {
            actor,
            source: CommandSource::Player,
            tick,
            seq,
            input,
        })
    ));
}

#[test]
fn apply_merges_simultaneous_hits_and_status_before_survivor_claims() {
    let rules = Rules(|view, _| {
        assert!(view.start.state.active(A) && view.start.state.active(B));
        let a = Entity::Actor(A);
        let b = Entity::Actor(B);
        TestEffects {
            vitals: vec![
                (
                    A,
                    VitalEffect::Damage {
                        source: b,
                        amount: 115.0,
                    },
                ),
                (A, VitalEffect::Heal(25.0)),
                (
                    B,
                    VitalEffect::Damage {
                        source: a,
                        amount: 90.0,
                    },
                ),
                (A, VitalEffect::Shield(35.0)),
                (
                    C,
                    VitalEffect::Damage {
                        source: b,
                        amount: 17.0,
                    },
                ),
                (C, VitalEffect::Heal(25.0)),
                (C, VitalEffect::Shield(35.0)),
            ],
            statuses: vec![
                (
                    A,
                    Status::Stun,
                    StatusEffect::Extend(Window {
                        active_from: 2,
                        expires_at: 4,
                    }),
                ),
                (
                    A,
                    Status::Stun,
                    StatusEffect::Extend(Window {
                        active_from: 2,
                        expires_at: 3,
                    }),
                ),
                (C, Status::Cloak, StatusEffect::Clear),
                (
                    C,
                    Status::Cloak,
                    StatusEffect::Extend(Window {
                        active_from: 2,
                        expires_at: 8,
                    }),
                ),
            ],
            claims: vec![(B, ()), (A, ()), (C, ())],
            lifecycle: vec![Lifecycle::SetPresence {
                actor: A,
                presence: Presence::Transit,
            }],
            facts: vec![
                Fact::Hit {
                    source: b,
                    target: A,
                },
                Fact::Hit {
                    source: a,
                    target: B,
                },
            ],
            ..TestEffects::default()
        }
    });
    let mut scenario = Scenario::default();
    for (id, x) in [(B, 0.0), (A, 4.0), (C, 8.0)] {
        scenario.state.actors.insert(id, actor(Presence::Active));
        scenario.body(BodyId::Actor(id), body(x));
    }
    scenario.state.actors.get_mut(&C).unwrap().statuses.insert(
        Status::Cloak,
        Window {
            active_from: 0,
            expires_at: 5,
        },
    );
    let mut game = scenario.start(4217, 10);
    let result = game.step(&rules).unwrap();
    assert_eq!(
        result
            .changes
            .events
            .iter()
            .map(|event| event.fact)
            .collect::<Vec<_>>(),
        [
            Fact::Placed {
                source: Entity::Actor(C),
                placed: Entity::Item(ItemId(1))
            },
            Fact::Hit {
                source: Entity::Actor(A),
                target: B
            },
            Fact::Eliminated { actor: A },
            Fact::KillCredited {
                actor: A,
                target: B
            },
            Fact::Hit {
                source: Entity::Actor(B),
                target: A
            },
            Fact::Eliminated { actor: B },
            Fact::KillCredited {
                actor: B,
                target: A
            },
        ],
    );
    assert_eq!(game.state().actors[&C].hp, 98.0);
    assert_eq!(game.state().actors[&C].shield, 0.0);
    assert!(
        !game.state().actors[&C]
            .statuses
            .contains_key(&Status::Cloak)
    );
    let stun = game.state().actors[&A].statuses[&Status::Stun];
    assert!(!stun.contains(1) && stun.contains(2) && stun.contains(3) && !stun.contains(4));
    assert_eq!(game.state().actors[&A].presence, Presence::Eliminated);
    assert_eq!(game.state().actors[&B].presence, Presence::Eliminated);
    assert_eq!(game.position(BodyId::Actor(A)), None);
    assert!(result.solved.path(BodyId::Actor(A)).is_some());
}

#[test]
fn intake_drives_this_solve_but_resolve_impulse_reaches_the_next_solve() {
    let rules = Rules(|view, _| {
        let id = BodyId::Actor(A);
        assert_eq!(view.start.state.actors[&A].aim, 1.0);
        let [x, y] = view.solved.position(id).unwrap();
        assert!(x > 0.0);
        if view.start.tick == 1 {
            assert_eq!(y, 0.0);
            TestEffects {
                impulses: vec![(id, [0.0, 30.0])],
                ..TestEffects::default()
            }
        } else {
            assert!(y > 0.0);
            TestEffects::default()
        }
    });
    let mut scenario = Scenario::default();
    scenario.state.actors.insert(A, actor(Presence::Active));
    scenario.body(BodyId::Actor(A), body(0.0));
    let mut game = scenario.start(4217, 2);
    let input = Input {
        aim: Some(1.0),
        movement: [80.0, 0.0],
        ..Input::default()
    };
    submit(&mut game, A, 1, 1, input);
    submit(&mut game, A, 2, 2, Input::default());
    let first = game.step(&rules).unwrap();
    assert!(first.changes.events.is_empty());
    let last = game.step(&rules).unwrap();
    assert_eq!(last.changes.events[0].fact, Fact::Finished);
    assert_eq!(
        last.inbound[0],
        Inbound::Carried(Carried::Impulse {
            body: BodyId::Actor(A),
            impulse: [0.0, 30.0],
        })
    );
    assert_eq!(game.state().actors[&A].presence, Presence::Stranded);
    assert_eq!(game.position(BodyId::Actor(A)), None);
    assert!(game.step(&rules).is_none());
}

#[test]
fn input_for_inactive_actor_is_discarded_and_only_spent_input_can_repeat() {
    let rules = Rules(|view, commands| {
        match view.start.tick {
            1 => {
                assert!(commands.is_empty());
                return TestEffects {
                    lifecycle: vec![Lifecycle::SetPresence {
                        actor: A,
                        presence: Presence::Active,
                    }],
                    ..TestEffects::default()
                };
            }
            2 | 14 => assert!(commands.is_empty()),
            3 => {
                assert_eq!(commands.len(), 1);
                assert_eq!(commands[0].seq, 3);
                assert!(commands[0].input.skill);
            }
            _ => {
                assert_eq!(commands.len(), 1);
                assert_eq!(commands[0].seq, 3);
                assert!(commands[0].input.sneak);
                assert!(!commands[0].input.skill);
            }
        }
        TestEffects::default()
    });
    let mut scenario = Scenario::default();
    scenario.state.actors.insert(A, actor(Presence::Pending));
    let mut game = scenario.start(4217, 20);
    let input = Input {
        skill: true,
        sneak: true,
        ..Input::default()
    };
    submit(&mut game, A, 1, 1, input);
    submit(&mut game, A, 3, 2, Input::default());
    submit(&mut game, A, 3, 3, input);
    assert_eq!(game.step(&rules).unwrap().inbound.len(), 1);
    assert_eq!(game.acknowledged(A), None);
    game.step(&rules).unwrap();
    assert_eq!(game.acknowledged(A), None);
    assert_eq!(game.step(&rules).unwrap().inbound.len(), 2);
    assert_eq!(game.acknowledged(A), Some(3));
    for _ in 4..=14 {
        game.step(&rules).unwrap();
    }
    assert_eq!(game.acknowledged(A), Some(3));
}

#[test]
fn successful_placements_allocate_ids_and_publish_in_canonical_order() {
    let mut scenario = Scenario::default();
    for id in [B, A, C] {
        scenario.state.actors.insert(id, actor(Presence::Active));
    }
    scenario.state.items.insert(ItemId(12), pending_item());
    let mut game = scenario.start(4217, 20);
    let result = game
        .step(&Rules(|_, _| TestEffects {
            placements: vec![A, B, C],
            ..TestEffects::default()
        }))
        .unwrap();
    for (index, (out, actor)) in result.changes.events.iter().zip([C, A, B]).enumerate() {
        assert_eq!(out.id, index as u64 + 1);
        assert_eq!(
            out.fact,
            Fact::Placed {
                source: Entity::Actor(actor),
                placed: Entity::Item(ItemId(13 + index as u32)),
            }
        );
    }
    assert_eq!(result.changes.events.len(), 3);
    assert_eq!(game.state().items.len(), 4);
}

#[test]
fn stateless_scores_rank_the_same_candidates_in_either_order() {
    let rank = |ids: [ActorId; 3]| {
        let mut ids = ids;
        ids.sort_unstable_by_key(|&id| (contest_score(4217, 30, 9, actor_word(id)), id));
        ids
    };
    assert_eq!(rank([A, B, C]), rank([C, A, B]));
    assert_ne!(actor_word(B), actor_word(C));
    assert_ne!(
        contest_score(4217, 30, 9, actor_word(A)),
        contest_score(4217, 31, 9, actor_word(A))
    );
    assert_ne!(
        scatter_score(4217, 30, A, 9, 0),
        scatter_score(4217, 30, A, 9, 1)
    );
}
