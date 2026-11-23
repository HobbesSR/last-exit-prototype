use super::*;
use crate::floor_drag::Class;
use crate::physics::{KIND_PROP, KIND_STATIC};
use crate::swept::Shape;

fn skill() -> Input {
    Input {
        skill: true,
        ..Input::default()
    }
}

fn fight(target_x: f64) -> Scenario {
    let mut scenario = Scenario::default();
    let mut caster = actor(Presence::Active);
    caster.kit = Some(Kit::Hook);
    scenario.state.actors.insert(B, caster);
    scenario.state.actors.insert(A, actor(Presence::Active));
    scenario.body(BodyId::Actor(B), body(0.0));
    scenario.body(BodyId::Actor(A), body(target_x));
    scenario
}

fn has(result: &CompletedTick, fact: Fact) -> bool {
    result.events.iter().any(|event| event.fact == fact)
}

#[test]
fn overdrive_spends_a_ready_skill_and_boosts_the_same_solve() {
    let mut movement = Movement::default();
    movement.boost_duration = 2;
    let game = || {
        let mut scenario = Scenario::default();
        let mut striker = actor(Presence::Active);
        striker.kit = Some(Kit::Striker);
        striker.level = 3;
        striker.deadlines.skill_ready_at = 2;
        scenario.state.actors.insert(B, striker);
        scenario.body(BodyId::Actor(B), body(0.0));
        keep_open(&mut scenario);
        scenario.start(4217, 10)
    };
    let mut boosted = game();
    let mut ordinary = game();
    let walking = Input {
        movement: [1.0, 0.0],
        ..Input::default()
    };
    for tick in 1..=2 {
        submit(
            &mut boosted,
            B,
            tick,
            u64::from(tick),
            Input {
                skill: true,
                ..walking
            },
        );
        submit(&mut ordinary, B, tick, u64::from(tick), walking);
    }
    let actor = BodyId::Actor(B);
    let waiting = boosted.step(&movement).unwrap();
    assert!(has(
        &waiting,
        Fact::Rejected {
            actor: B,
            reason: Rejection::SkillCooldown
        }
    ));
    assert_eq!(
        waiting.solved.path(actor),
        ordinary.step(&movement).unwrap().solved.path(actor)
    );

    let surge = boosted.step(&movement).unwrap();
    assert!(has(&surge, Fact::Boosted { actor: B }));
    assert!(
        surge.solved.position(actor).unwrap()[0]
            > ordinary
                .step(&movement)
                .unwrap()
                .solved
                .position(actor)
                .unwrap()[0]
    );
    let striker = &boosted.state().actors[&B];
    assert_eq!(striker.deadlines.skill_ready_at, 73);
    let window = striker.statuses[&Status::Boost];
    assert!(!window.contains(1) && window.contains(2) && window.contains(3) && !window.contains(4));
}

#[test]
fn command_tip_attaches_on_its_firing_tick_and_pulls_on_the_following_tick() {
    let movement = Movement::default();
    let mut game = fight(59.0).start(4217, 10);
    submit(&mut game, B, 1, 1, skill());
    let first = game.step(&movement).unwrap();
    assert!(has(&first, Fact::HookFired { owner: B }));
    assert!(has(
        &first,
        Fact::HookAttached {
            owner: B,
            target: A
        }
    ));
    assert_eq!(game.state().actors[&B].deadlines.skill_ready_at, 141);
    let (&id, hook) = game.state().hooks.first_key_value().unwrap();
    assert_eq!(id, HookId(1));
    assert!(matches!(hook.phase, HookPhase::Pulling { target: A, .. }));
    let path = first.solved.path(BodyId::Actor(A)).unwrap();
    assert_eq!(path.first(), path.last());
    let start = path[0][0];
    let next = game.step(&movement).unwrap();
    assert!(next.solved.position(BodyId::Actor(A)).unwrap()[0] < start);
    assert!(next.solved.position(BodyId::Actor(B)).unwrap()[0] > 0.0);
}

#[test]
fn cancel_and_obstruction_both_release_a_tether_before_the_solve() {
    let movement = Movement::default();
    for release in [
        None,
        Some(HookRelease::Cancelled),
        Some(HookRelease::Obstructed),
    ] {
        let mut scenario = fight(100.0);
        scenario
            .state
            .actors
            .get_mut(&B)
            .unwrap()
            .deadlines
            .skill_ready_at = 140;
        scenario.state.hooks.insert(
            HookId(10),
            Hook {
                owner: B,
                expires_at: 60,
                phase: HookPhase::Pulling {
                    target: A,
                    length: 100.0,
                },
            },
        );
        if release == Some(HookRelease::Obstructed) {
            let mut prop = body(50.0);
            prop.params.kind = KIND_PROP;
            scenario.body(BodyId::Prop(7), prop);
        }
        let mut game = scenario.start(4217, 10);
        if release == Some(HookRelease::Cancelled) {
            submit(&mut game, B, 1, 1, skill());
        }
        let result = game.step(&movement).unwrap();
        let path = result.solved.path(BodyId::Actor(A)).unwrap();
        if let Some(reason) = release {
            assert!(has(&result, Fact::HookReleased { owner: B, reason }));
            assert!(game.state().hooks.is_empty());
            assert_eq!(path.first(), path.last());
            assert_eq!(game.state().actors[&B].deadlines.skill_ready_at, 140);
        } else {
            assert!(path.last().unwrap()[0] < path[0][0]);
        }
    }
}

#[test]
fn a_closed_gate_wins_the_contact_tie_and_open_gate_leaves_the_path_clear() {
    let mut movement = Movement::default();
    movement.hook.speed = 800.0;
    for open in [false, true] {
        // First actor contact at x=20, exactly where the closed gate starts.
        let mut scenario = fight(35.0);
        scenario.state.gates.insert(
            GateId(0),
            Gate {
                open,
                locked: false,
                ..Gate::default()
            },
        );
        scenario.geometry(Arc::new(SweptMap::new(
            vec![],
            vec![],
            vec![Shape::Rect {
                x: 20.0,
                y: -5.0,
                w: 1.0,
                h: 10.0,
            }],
        )));
        let mut game = scenario.start(4217, 10);
        submit(&mut game, B, 1, 1, skill());
        let result = game.step(&movement).unwrap();
        assert!(has(&result, Fact::HookFired { owner: B }));
        assert_eq!(
            has(
                &result,
                Fact::HookAttached {
                    owner: B,
                    target: A
                }
            ),
            open
        );
        assert_eq!(
            has(
                &result,
                Fact::HookReleased {
                    owner: B,
                    reason: HookRelease::Obstructed
                }
            ),
            !open
        );
        assert_eq!(game.state().hooks.len(), usize::from(open));
    }
}

#[test]
fn equally_early_actors_use_seeded_hook_arbitration() {
    let movement = Movement::default();
    let winner = |seed, mirrored| {
        let mut scenario = Scenario::default();
        let mut caster = actor(Presence::Active);
        caster.kit = Some(Kit::Hook);
        scenario.state.actors.insert(B, caster);
        scenario.body(BodyId::Actor(B), body(0.0));
        for (id, y) in [(C, 9.0), (A, -9.0)] {
            scenario.state.actors.insert(id, actor(Presence::Active));
            let mut target = body(55.0);
            target.params.pose[1] = if mirrored { -y } else { y };
            scenario.body(BodyId::Actor(id), target);
        }
        let mut game = scenario.start(seed, 10);
        submit(&mut game, B, 1, 1, skill());
        game.step(&movement)
            .unwrap()
            .events
            .iter()
            .find_map(|event| match event.fact {
                Fact::HookAttached { owner: B, target } => Some(target),
                _ => None,
            })
            .unwrap()
    };
    let mut winners = std::collections::BTreeSet::new();
    for seed in 1..=8 {
        let selected = winner(seed, false);
        assert_eq!(selected, winner(seed, true));
        winners.insert(selected);
    }
    assert_eq!(winners, [A, C].into());
}

#[test]
fn hook_outcome_uses_committed_endpoints_after_elimination_or_relocation() {
    for reason in [HookRelease::EndpointGone, HookRelease::Relocated] {
        let rules = match reason {
            HookRelease::EndpointGone => Rules(|_, _| TestEffects {
                vitals: vec![(
                    A,
                    VitalEffect::Damage {
                        source: Entity::Actor(B),
                        amount: 100.0,
                    },
                )],
                new_hooks: [(
                    B,
                    Hook {
                        owner: B,
                        phase: HookPhase::Pulling {
                            target: A,
                            length: 59.0,
                        },
                        expires_at: 61,
                    },
                )]
                .into(),
                facts: vec![
                    Fact::HookFired { owner: B },
                    Fact::HookAttached {
                        owner: B,
                        target: A,
                    },
                ],
                ..TestEffects::default()
            }),
            HookRelease::Relocated => Rules(|_, _| TestEffects {
                lifecycle: vec![Lifecycle::Warp {
                    body: BodyId::Actor(A),
                    to: [250.0, 0.0],
                    angle: 0.0,
                }],
                ..TestEffects::default()
            }),
            _ => unreachable!(),
        };
        let mut scenario = fight(59.0);
        if reason == HookRelease::Relocated {
            scenario.state.hooks.insert(
                HookId(1),
                Hook {
                    owner: B,
                    phase: HookPhase::Pulling {
                        target: A,
                        length: 59.0,
                    },
                    expires_at: 61,
                },
            );
        }
        let mut game = scenario.start(4217, 10);
        let result = game.step(&rules).unwrap();
        assert!(has(&result, Fact::HookReleased { owner: B, reason }));
        assert!(!has(
            &result,
            Fact::HookAttached {
                owner: B,
                target: A
            }
        ));
        assert!(game.state().hooks.is_empty());
        if reason == HookRelease::Relocated {
            let path = result.solved.path(BodyId::Actor(A)).unwrap();
            assert_eq!(path.first(), path.last());
            assert_eq!(game.position(BodyId::Actor(A)), Some([250.0, 0.0]));
        }
    }
}

#[test]
fn indexed_floor_drag_and_stable_rapier_contacts_reach_the_tick() {
    let surface = |id: &str, priority, drag| MotorSurface {
        id: id.into(),
        priority,
        origin: [0.0, -20.0],
        size: [20.0, 40.0],
        speed: 1.0,
        traction: 1.0,
        braking: 1.0,
        drag: Some(drag),
    };
    let movement = Movement::default().with_surfaces(vec![
        surface("z", 10.0, 0.5),
        surface("a", 10.0, 0.0),
        surface("low", 0.0, 0.9),
    ]);
    let floor = movement.floor_drag([4.0; 2], [20.0; 2]);
    assert_eq!(floor.damping(Class::Prop, 5.0, 0.0), Some([0.0; 2]));
    assert_eq!(floor.damping(Class::Prop, 20.0, 0.0), Some([20.0; 2]));
    let run = |configure_floor| {
        let mut scenario = Scenario::default();
        scenario.state.actors.insert(A, actor(Presence::Active));
        let actor_id = BodyId::Actor(A);
        let static_id = BodyId::Geometry(9);
        let prop_id = BodyId::Prop(12);
        let mut wall = body(51.0);
        wall.params.kind = KIND_STATIC;
        let mut prop = body(5.0);
        prop.params.kind = KIND_PROP;
        prop.params.pose[3] = 20.0;
        prop.params.damping = [20.0; 2];
        scenario.body(static_id, wall);
        scenario.body(prop_id, prop);
        scenario.body(actor_id, body(50.0));
        if configure_floor {
            scenario.floor_drag(movement.floor_drag([4.0; 2], [20.0; 2]));
        }
        let result = scenario.start(4217, 10).step(&movement).unwrap();
        let contact = result
            .solved
            .contacts
            .iter()
            .find(|c| c.a == actor_id && c.b == static_id && c.kind == ContactKind::Started)
            .unwrap();
        assert!(has(&result, Fact::Contact(*contact)));
        result.solved.position(prop_id).unwrap()[0]
    };
    assert!(run(true) > run(false));
}
