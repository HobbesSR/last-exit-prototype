use super::*;
use crate::physics::KIND_PROP;

const MINE: TrapId = TrapId(1);
const TURRET: TrapId = TrapId(2);
const FLAME: TrapId = TrapId(3);

fn add_actor(scenario: &mut Scenario, id: ActorId, x: f64) {
    scenario.state.actors.insert(id, actor(Presence::Active));
    scenario.body(BodyId::Actor(id), body(x));
}

fn trap(position: Point, kind: TrapKind) -> Trap {
    Trap {
        position,
        kind,
        heading: 0.0,
        ready_at: 0,
    }
}

fn has(tick: &CompletedTick, fact: Fact) -> bool {
    tick.changes.events.iter().any(|event| event.fact == fact)
}

fn charged_cell(id: ItemId) -> CarriedItem {
    CarriedItem {
        id,
        lineage: id,
        equipment: Equipment {
            kind: EquipmentKind::Cell { charge: 100 },
            quality: 1,
        },
    }
}

#[test]
fn wall_advances_on_the_match_clock_and_uses_strict_solved_exposure() {
    let mut scenario = Scenario::default();
    scenario.hazard_wall(220.0, 2);
    add_actor(&mut scenario, A, 39.0);
    scenario.state.actors.insert(C, actor(Presence::Active));
    let mut boundary = body(40.0);
    boundary.params.pose[1] = 100.0;
    scenario.body(BodyId::Actor(C), boundary);
    let rules = Combat::default();
    let mut game = scenario.start(1, 10);
    assert_eq!(game.state().hazard_x, Some(-80.0));
    for expected_wall in [-80.0, -80.0, -40.0, 0.0] {
        let tick = game.step(&rules).unwrap();
        assert!(
            !tick
                .changes
                .events
                .iter()
                .any(|event| matches!(event.fact, Fact::Hit { .. }))
        );
        assert_eq!(game.state().hazard_x, Some(expected_wall));
    }
    let tick = game.step(&rules).unwrap();
    assert_eq!(game.state().hazard_x, Some(40.0));
    assert!(has(
        &tick,
        Fact::Hit {
            source: Entity::Match,
            target: A
        }
    ));
    assert!(!has(
        &tick,
        Fact::Hit {
            source: Entity::Match,
            target: C
        }
    ));
    assert_eq!(game.state().actors[&A].hp, 81.0);
}

#[test]
fn wall_area_and_flame_merge_before_extraction_and_turret_keeps_its_s0_target() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 40.0);
    let mut other = body(140.0);
    other.params.pose[1] = 40.0;
    scenario.state.actors.insert(C, actor(Presence::Active));
    scenario.body(BodyId::Actor(C), other);
    let cell = ItemId(20);
    let claimant = scenario.state.actors.get_mut(&A).unwrap();
    claimant.hp = 129.0;
    claimant.max_hp = 129.0;
    claimant.shield = 5.0;
    claimant.inventory.slots[0] = Some(charged_cell(cell));
    scenario.state.hazard_x = Some(100.0);
    scenario.hazard_area([39.0, -10.0, 20.0, 20.0]);
    scenario.hazard_area([30.0, -5.0, 20.0, 10.0]);
    scenario.state.extraction = Some(Extraction {
        position: [40.0, 0.0],
        slots: 1,
    });
    scenario.state.traps.insert(
        FLAME,
        trap(
            [0.0, 0.0],
            TrapKind::Flame {
                offset: 60,
                warning: false,
                firing: false,
            },
        ),
    );
    scenario.state.traps.insert(
        TURRET,
        Trap {
            ready_at: 60,
            ..trap([0.0, 0.0], TrapKind::Turret { aiming: false })
        },
    );
    let mut game = scenario.start(1, 61);
    let rules = Combat::default();
    for _ in 1..60 {
        game.step(&rules).unwrap();
    }
    assert_eq!(game.state().actors[&A].hp, 15.0);
    submit(
        &mut game,
        A,
        60,
        1,
        Input {
            interact: true,
            target: Some(Target::Extraction),
            ..Input::default()
        },
    );
    let tick = game.step(&rules).unwrap();
    assert_eq!(
        tick.changes
            .events
            .iter()
            .filter(|event| event.fact
                == Fact::Hit {
                    source: Entity::Match,
                    target: A
                })
            .count(),
        2
    );
    assert!(has(
        &tick,
        Fact::Hit {
            source: Entity::Trap(FLAME),
            target: A
        }
    ));
    assert!(has(&tick, Fact::Eliminated { actor: A }));
    assert!(!escaped(&tick, A, cell));
    assert_eq!(game.state().extraction.unwrap().slots, 1);
    assert_eq!(game.state().actors[&A].hp, 0.0);
    assert_eq!(
        game.state().projectiles[&ProjectileId(1)].velocity,
        [24.0, 0.0]
    );
}

#[test]
fn mine_requires_solved_motion_and_pushes_only_existing_surviving_bodies_next_tick() {
    for movement in [0.05, 0.5] {
        let mut scenario = Scenario::default();
        add_actor(&mut scenario, A, 25.0);
        add_actor(&mut scenario, B, 70.0);
        add_actor(&mut scenario, C, 100.0);
        let cell = ItemId(25);
        let victim = scenario.state.actors.get_mut(&B).unwrap();
        victim.hp = 10.0;
        victim.inventory.slots[0] = Some(charged_cell(cell));
        let prop = BodyId::Prop(0);
        let mut spec = body(90.0);
        spec.params.kind = KIND_PROP;
        spec.params.pose[1] = 30.0;
        scenario.body(prop, spec);
        scenario
            .state
            .traps
            .insert(MINE, trap([0.0, 0.0], TrapKind::Mine { spent: false }));

        let rules = Combat::default();
        let mut game = scenario.start(1, 10);
        submit(
            &mut game,
            A,
            1,
            1,
            Input {
                movement: [movement, 0.0],
                ..Input::default()
            },
        );
        let first = game.step(&rules).unwrap();
        let triggered = movement == 0.5;
        assert_eq!(has(&first, Fact::MineExploded { trap: MINE }), triggered);
        assert_eq!(
            game.state().traps[&MINE].kind,
            TrapKind::Mine { spent: triggered }
        );
        assert_eq!(first.solved.position(prop), Some([90.0, 30.0]));
        if !triggered {
            assert_eq!(game.state().actors[&B].hp, 10.0);
            continue;
        }
        assert!(has(&first, Fact::Eliminated { actor: B }));
        assert!(game.state().items.contains_key(&cell));
        assert_eq!(first.solved.position(BodyId::Actor(C)), Some([100.0, 0.0]));
        assert_eq!(game.state().actors[&C].hp, 45.0);

        let second = game.step(&rules).unwrap();
        assert!(!has(&second, Fact::MineExploded { trap: MINE }));
        let pushed: Vec<_> = second
            .inbound
            .iter()
            .filter_map(|record| match *record {
                Inbound::Carried(Carried::Impulse { body, .. }) => Some(body),
                _ => None,
            })
            .collect();
        assert_eq!(pushed, [BodyId::Actor(C), BodyId::Actor(A), prop]);
        assert!(second.solved.position(prop).unwrap()[0] > 90.0);
        assert!(second.solved.position(BodyId::Actor(C)).unwrap()[0] > 100.0);
    }
}

#[test]
fn turret_ties_use_the_seed_and_the_shot_first_sweeps_next_tick() {
    let mut winners = BTreeMap::new();
    for seed in 1..=8 {
        let mut scenario = Scenario::default();
        add_actor(&mut scenario, A, 35.0);
        add_actor(&mut scenario, B, -35.0);
        scenario
            .state
            .traps
            .insert(TURRET, trap([0.0, 0.0], TrapKind::Turret { aiming: false }));
        let rules = Combat::default();
        let mut game = scenario.start(seed, 10);
        let first = game.step(&rules).unwrap();
        let score = |actor| {
            contest_score(
                seed,
                1,
                hazards::TARGET_CONTEST ^ u64::from(TURRET.0),
                actor_word(actor),
            )
        };
        let winner = [A, B]
            .into_iter()
            .min_by_key(|&actor| (score(actor), actor))
            .unwrap();
        winners.insert(winner, seed);
        let source = Entity::Trap(TURRET);
        let id = ProjectileId(1);
        assert!(has(
            &first,
            Fact::Placed {
                source,
                placed: Entity::Projectile(id)
            }
        ));
        assert!(!has(
            &first,
            Fact::Hit {
                source,
                target: winner
            }
        ));
        let shot = game.state().projectiles[&id];
        assert_eq!(shot.position, [0.0, 0.0]);
        assert_eq!((shot.active_from, shot.expires_at), (2, 31));
        assert_eq!(game.state().traps[&TURRET].ready_at, 36);

        let second = game.step(&rules).unwrap();
        assert!(has(
            &second,
            Fact::Hit {
                source,
                target: winner
            }
        ));
        assert!(game.state().projectiles.is_empty());
        assert_eq!(game.state().actors[&winner].hp, 78.0);
    }
    assert_eq!(winners.len(), 2);
}

#[test]
fn turret_reads_s0_gate_and_its_next_tick_sweep_reads_the_closed_gate() {
    let mut scenario = Scenario::default();
    let gate = GateId(0);
    add_actor(&mut scenario, A, 55.0);
    scenario.state.gates.insert(
        gate,
        Gate {
            open: true,
            door: true,
            position: [20.0, 0.0],
            ..Gate::default()
        },
    );
    let empty = &[0, 0, 0, 0, 0];
    scenario.sight(
        Arc::new(SightIndex::new(&[], empty, &[], &[0], empty)),
        Arc::new(GateSet::new(
            &[20.0, -10.0, 20.0, 10.0],
            &[0, 1],
            &[20.0, -10.0, 2.0, 20.0],
            &[0, -1, 1, 2, 0, 1, 2, 0, 0],
        )),
    );
    scenario.geometry(Arc::new(SweptMap::new(
        vec![],
        vec![],
        vec![Shape::Rect {
            x: 20.0,
            y: -10.0,
            w: 2.0,
            h: 20.0,
        }],
    )));
    scenario
        .state
        .traps
        .insert(TURRET, trap([0.0, 0.0], TrapKind::Turret { aiming: false }));
    let rules = Combat::default();
    let mut game = scenario.start(1, 10);
    submit(
        &mut game,
        A,
        1,
        1,
        Input {
            interact: true,
            target: Some(Target::Gate(gate)),
            ..Input::default()
        },
    );
    let tick = game.step(&rules).unwrap();
    assert!(has(
        &tick,
        Fact::GateChanged {
            actor: A,
            gate,
            open: false
        }
    ));
    let source = Entity::Trap(TURRET);
    assert!(has(
        &tick,
        Fact::Placed {
            source,
            placed: Entity::Projectile(ProjectileId(1))
        }
    ));
    let tick = game.step(&rules).unwrap();
    assert!(!has(&tick, Fact::Hit { source, target: A }));
    assert!(game.state().projectiles.is_empty());
    assert_eq!(
        game.state().traps[&TURRET].kind,
        TrapKind::Turret { aiming: false }
    );
}
