use super::*;

const TRAP: TrapId = TrapId(1);

fn add_actor(scenario: &mut Scenario, id: ActorId, position: Point, hp: f64) {
    let mut record = actor(Presence::Active);
    record.hp = hp;
    scenario.state.actors.insert(id, record);
    let mut spec = body(position[0]);
    spec.params.pose[1] = position[1];
    scenario.body(BodyId::Actor(id), spec);
}

fn flame(offset: Tick) -> Trap {
    Trap {
        position: [0.0, 0.0],
        heading: 0.0,
        ready_at: 0,
        kind: TrapKind::Flame {
            offset,
            warning: false,
            firing: false,
        },
    }
}

fn hit(tick: &CompletedTick, target: ActorId) -> bool {
    tick.events.iter().any(|event| {
        event.fact
            == Fact::Hit {
                source: Entity::Trap(TRAP),
                target,
            }
    })
}

#[test]
fn flame_warns_then_fires_but_only_damages_on_interval() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, [100.0, 0.0], 90.0);
    scenario.state.traps.insert(TRAP, flame(118));
    let mut game = scenario.start(1, 20);
    let rules = Combat::default();
    let first = game.step(&rules).unwrap();
    assert!(!hit(&first, A));
    assert!(matches!(
        game.state().traps[&TRAP].kind,
        TrapKind::Flame {
            warning: true,
            firing: false,
            ..
        }
    ));
    let second = game.step(&rules).unwrap();
    assert!(!hit(&second, A));
    assert!(matches!(
        game.state().traps[&TRAP].kind,
        TrapKind::Flame {
            warning: false,
            firing: true,
            ..
        }
    ));
    assert!(!hit(&game.step(&rules).unwrap(), A));
    assert!(!hit(&game.step(&rules).unwrap(), A));
    assert!(hit(&game.step(&rules).unwrap(), A));
    assert_eq!(game.state().actors[&A].hp, 84.0);
}

#[test]
fn flame_cone_and_range_exclude_their_boundaries() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, [80.0, 60.0], 90.0);
    add_actor(&mut scenario, B, [162.0, 118.0], 90.0);
    add_actor(&mut scenario, C, [240.0, 0.0], 90.0);
    scenario.state.traps.insert(TRAP, flame(120));
    let mut game = scenario.start(2, 20);
    for _ in 0..4 {
        game.step(&Combat::default()).unwrap();
    }
    let tick = game.step(&Combat::default()).unwrap();
    assert!(
        !hit(&tick, A),
        "a target exactly on the cone boundary is excluded"
    );
    assert!(hit(&tick, B));
    assert!(!hit(&tick, C), "a target exactly at range is excluded");
}

#[test]
fn spider_steps_into_range_and_lethal_grapple_uses_solved_victim_pose() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, [154.0, 0.0], 10.0);
    scenario.state.traps.insert(
        TRAP,
        Trap {
            position: [0.0, 0.0],
            heading: 0.0,
            ready_at: 0,
            kind: TrapKind::Spider {
                home: [0.0, 0.0],
                target: None,
            },
        },
    );
    let mut game = scenario.start(3, 20);
    let tick = game.step(&Combat::default()).unwrap();
    let solved = tick.solved.position(BodyId::Actor(A)).unwrap();
    assert_eq!(game.state().traps[&TRAP].position, [5.0, 0.0]);
    assert!(hit(&tick, A));
    assert!(
        tick.events
            .iter()
            .any(|event| matches!(event.fact, Fact::Eliminated { actor: A }))
    );
    assert!(tick.events.iter().any(|event| match event.fact {
        Fact::SpiderGrappled {
            trap: TRAP,
            target: A,
            at,
        } => at.position() == solved,
        _ => false,
    }));
    assert_eq!(
        game.state().actors[&A].statuses[&Status::Stun],
        Window {
            active_from: 2,
            expires_at: 32
        }
    );
}

#[test]
fn spider_retains_a_target_beyond_acquisition_range_and_steps_only_into_clear_space() {
    for blocked in [false, true] {
        let mut scenario = Scenario::default();
        add_actor(&mut scenario, A, [300.0, 0.0], 90.0);
        add_actor(&mut scenario, C, [-80.0, 0.0], 90.0);
        if blocked {
            scenario.geometry(Arc::new(SweptMap::new(
                vec![Shape::Rect {
                    x: 19.0,
                    y: -30.0,
                    w: 2.0,
                    h: 60.0,
                }],
                vec![true],
                vec![],
            )));
        }
        scenario.state.traps.insert(
            TRAP,
            Trap {
                position: [0.0, 0.0],
                heading: 0.0,
                ready_at: 0,
                kind: TrapKind::Spider {
                    home: [0.0, 0.0],
                    target: Some(A),
                },
            },
        );
        let mut game = scenario.start(4, 20);
        let tick = game.step(&Combat::default()).unwrap();
        assert!(!hit(&tick, A));
        assert!(!hit(&tick, C));
        let trap = &game.state().traps[&TRAP];
        assert_eq!(trap.position, [if blocked { 0.0 } else { 5.0 }, 0.0]);
        assert!(matches!(
            trap.kind,
            TrapKind::Spider {
                target: Some(A),
                ..
            }
        ));
    }
}
