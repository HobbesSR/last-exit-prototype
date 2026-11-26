use std::f64::consts::PI;

use super::*;

const D: ActorId = ActorId {
    kind: ActorKind::Gladiator,
    seat: 3,
};

fn add(scenario: &mut Scenario, id: ActorId, x: f64, hp: f64, kit: Option<Kit>) {
    let mut record = actor(Presence::Active);
    record.hp = hp;
    record.kit = kit;
    scenario.state.actors.insert(id, record);
    scenario.body(BodyId::Actor(id), body(x));
}

fn equip(scenario: &mut Scenario, id: ActorId, kind: WeaponKind, rounds: u32) {
    let actor = scenario.state.actors.get_mut(&id).unwrap();
    let item = ItemId(id.seat + 1);
    actor.inventory.slots[0] = Some(CarriedItem {
        id: item,
        lineage: item,
        equipment: Equipment {
            kind: EquipmentKind::Firearm { kind, rounds },
            quality: 1,
        },
    });
}

fn has(tick: &CompletedTick, fact: Fact) -> bool {
    tick.changes.events.iter().any(|event| event.fact == fact)
}

fn attack(aim: f64) -> Input {
    Input {
        attack: true,
        aim: Some(aim),
        ..Input::default()
    }
}

fn hit_target(from: ActorId, target: ActorId) -> Fact {
    Fact::Hit {
        source: Entity::Actor(from),
        target,
    }
}

#[test]
fn firing_tick_and_lethal_melee_trade_both_award_credit() {
    let mut scenario = Scenario::default();
    add(&mut scenario, A, 0.0, 10.0, None);
    add(&mut scenario, B, 32.0, 10.0, Some(Kit::Warden));
    equip(&mut scenario, A, WeaponKind::Pistol, 2);
    scenario.state.actors.get_mut(&A).unwrap().statuses.insert(
        Status::Cloak,
        Window {
            active_from: 0,
            expires_at: 20,
        },
    );
    keep_open(&mut scenario);
    let mut game = scenario.start(87, 10);
    submit(&mut game, B, 1, 1, attack(PI));
    submit(&mut game, A, 1, 1, attack(0.0));

    let rules = Combat::default();
    let first = game.step(&rules).unwrap();
    for fact in [
        Fact::ShotFired {
            actor: A,
            weapon: WeaponKind::Pistol,
        },
        Fact::MeleeSwung { actor: B },
        hit_target(A, B),
        hit_target(B, A),
        Fact::Eliminated { actor: A },
        Fact::Eliminated { actor: B },
        Fact::KillCredited {
            actor: A,
            target: B,
        },
        Fact::KillCredited {
            actor: B,
            target: A,
        },
    ] {
        assert!(has(&first, fact), "missing {fact:?}");
    }
    let actors = &game.state().actors;
    assert!(actors[&A].inventory.selected_weapon().is_none());
    assert_eq!(
        game.state().items[&ItemId(A.seat + 1)].loot,
        Loot::Equipment(Equipment {
            kind: EquipmentKind::Firearm {
                kind: WeaponKind::Pistol,
                rounds: 1
            },
            quality: 1,
        })
    );
    assert_eq!(actors[&A].deadlines.weapon_ready_at, 9);
    assert!(!actors[&A].statuses.contains_key(&Status::Cloak));
    assert_eq!(
        actors[&A].aggression,
        Some(Aggression {
            source: B,
            expires_at: 201
        })
    );
    assert_eq!(
        (actors[&A].kills, actors[&B].kills, actors[&B].level),
        (1, 1, 1)
    );
    assert_eq!(game.position(BodyId::Actor(A)), None);
    assert_eq!(game.position(BodyId::Actor(B)), None);
    assert!(game.state().projectiles.is_empty());

    let next = game.step(&rules).unwrap();
    assert!(has(&next, Fact::KillRewarded { actor: B }));
    assert_eq!(
        next.inbound,
        [Inbound::Carried(Carried::KillReward { actor: B })]
    );
    let gladiator = &game.state().actors[&B];
    assert_eq!(
        (gladiator.level, gladiator.max_hp, gladiator.hp),
        (2, 120.0, 45.0)
    );
    assert_eq!(gladiator.presence, Presence::Pending);
    assert_eq!(gladiator.respawn_at, Some(401));
}

#[test]
fn lethal_first_contact_consumes_shot_while_both_warden_casts_land() {
    let mut scenario = Scenario::default();
    add(&mut scenario, A, 0.0, 100.0, None);
    add(&mut scenario, C, 24.0, 20.0, None);
    add(&mut scenario, B, 52.0, 100.0, Some(Kit::Warden));
    equip(&mut scenario, A, WeaponKind::Pistol, 1);
    let mut game = scenario.start(23, 10);
    submit(&mut game, A, 1, 1, attack(0.0));
    submit(
        &mut game,
        B,
        1,
        1,
        Input {
            skill: true,
            ..attack(PI)
        },
    );

    let tick = game.step(&Combat::default()).unwrap();
    assert!(has(&tick, Fact::WardenPulsed { actor: B }));
    assert!(has(&tick, Fact::MeleeSwung { actor: B }));
    assert!(has(&tick, hit_target(A, C)));
    assert!(!has(&tick, hit_target(A, B)));
    assert_eq!(
        tick.changes
            .events
            .iter()
            .filter(|event| event.fact == hit_target(B, C))
            .count(),
        2
    );
    assert_eq!(
        tick.changes
            .events
            .iter()
            .filter(|e| matches!(e.fact, Fact::KillCredited { target: C, .. }))
            .count(),
        1
    );
    assert_eq!(
        tick.changes
            .events
            .iter()
            .filter(|e| matches!(e.fact, Fact::Assisted { target: C, .. }))
            .count(),
        1
    );
    assert!(has(&tick, Fact::Eliminated { actor: C }));
    assert_eq!(
        game.state().actors[&C].statuses[&Status::Stun],
        Window {
            active_from: 2,
            expires_at: 24
        }
    );
    assert_eq!(game.state().actors[&B].hp, 100.0);
    assert!(game.state().projectiles.is_empty());
}

#[test]
fn seeded_credit_is_independent_of_submission_order_and_rewards_only_the_winner() {
    let fight = |order: [ActorId; 2]| {
        let mut scenario = Scenario::default();
        add(&mut scenario, A, 0.0, 10.0, None);
        add(&mut scenario, B, 32.0, 50.0, Some(Kit::Warden));
        add(&mut scenario, D, -39.0, 50.0, Some(Kit::Specter));
        for id in [B, D] {
            scenario
                .state
                .actors
                .get_mut(&id)
                .unwrap()
                .deadlines
                .skill_ready_at = 80;
        }
        keep_open(&mut scenario);
        let mut game = scenario.start(71, 10);
        for id in order {
            submit(&mut game, id, 1, 1, attack(if id == B { PI } else { 0.0 }));
            submit(
                &mut game,
                id,
                2,
                2,
                Input {
                    skill: true,
                    ..Input::default()
                },
            );
        }
        let rules = Combat::default();
        let first = game.step(&rules).unwrap();
        assert!(has(&first, hit_target(B, A)) && has(&first, hit_target(D, A)));
        let winner = first
            .changes
            .events
            .iter()
            .find_map(|e| match e.fact {
                Fact::KillCredited { actor, target: A } => Some(actor),
                _ => None,
            })
            .unwrap();
        let helper = if winner == B { D } else { B };
        assert!(has(
            &first,
            Fact::Assisted {
                actor: helper,
                target: A
            }
        ));
        assert_eq!(game.state().actors[&winner].deadlines.skill_ready_at, 80);
        let next = game.step(&rules).unwrap();
        assert!(has(&next, Fact::KillRewarded { actor: winner }));
        assert!(has(
            &next,
            if winner == B {
                Fact::WardenPulsed { actor: B }
            } else {
                Fact::SpecterScanned { actor: D }
            }
        ));
        assert!(has(
            &next,
            Fact::Rejected {
                actor: helper,
                reason: Rejection::SkillCooldown
            }
        ));
        assert_eq!(game.state().actors[&helper].level, 1);
        assert_eq!(game.state().actors[&winner].level, 2);
        first.changes.events
    };
    assert_eq!(fight([B, D]), fight([D, B]));
}

#[test]
fn rewind_uses_historical_target_and_gate_with_current_caster() {
    for gate_open in [false, true] {
        let mut scenario = Scenario::default();
        add(&mut scenario, B, 0.0, 50.0, Some(Kit::Warden));
        add(&mut scenario, A, 180.0, 50.0, None);
        scenario.state.actors.get_mut(&B).unwrap().view_lag = 1;
        let gate = GateId(0);
        scenario.state.gates.insert(
            gate,
            Gate {
                building: None,
                open: !gate_open,
                locked: false,
                ..Gate::default()
            },
        );
        scenario.history.insert(
            0,
            RewindFrame {
                poses: BTreeMap::from([(A, [60.0, 0.0]), (B, [500.0, 0.0])]),
                gates: BTreeMap::from([(gate, gate_open)]),
                ..RewindFrame::default()
            },
        );
        let empty_grid = &[0, 0, 0, 0, 0];
        scenario.sight(
            Arc::new(SightIndex::new(&[], empty_grid, &[], &[0], empty_grid)),
            Arc::new(GateSet::new(
                &[40.0, -5.0, 40.0, 5.0],
                &[0, 1],
                &[40.0, -5.0, 1.0, 10.0],
                &[0, 0, 1, 1, 0, 1, 0],
            )),
        );
        let mut game = scenario.start(91, 10);
        submit(
            &mut game,
            B,
            1,
            1,
            Input {
                skill: true,
                ..Input::default()
            },
        );

        let tick = game.step(&Combat::default()).unwrap();
        assert!(has(&tick, Fact::WardenPulsed { actor: B }));
        assert_eq!(has(&tick, hit_target(B, A)), gate_open);
        assert_eq!(
            game.state().actors[&A].hp,
            if gate_open { 27.0 } else { 50.0 }
        );
    }
}

#[test]
fn melee_ranks_eligible_targets_by_current_distance() {
    let mut scenario = Scenario::default();
    add(&mut scenario, B, 0.0, 100.0, Some(Kit::Warden));
    add(&mut scenario, A, 30.0, 100.0, None);
    add(&mut scenario, C, 65.0, 100.0, None);
    scenario.state.actors.get_mut(&B).unwrap().view_lag = 1;
    scenario.history.insert(
        0,
        RewindFrame {
            poses: BTreeMap::from([(A, [70.0, 0.0]), (C, [20.0, 0.0])]),
            ..RewindFrame::default()
        },
    );
    let mut game = scenario.start(20, 10);
    submit(&mut game, B, 1, 1, attack(0.0));
    let tick = game.step(&Combat::default()).unwrap();
    assert!(has(&tick, hit_target(B, A)));
    assert!(!has(&tick, hit_target(B, C)));
}

#[test]
fn projectile_from_a_previously_eliminated_shooter_still_gets_credit() {
    let mut scenario = Scenario::default();
    scenario.state.actors.insert(A, actor(Presence::Eliminated));
    add(&mut scenario, B, 100.0, 10.0, Some(Kit::Warden));
    scenario.state.projectiles.insert(
        ProjectileId(12),
        Projectile {
            source: Entity::Actor(A),
            position: [0.0, 0.0],
            velocity: [20.0, 0.0],
            damage: 10.0,
            active_from: 0,
            expires_at: 10,
        },
    );
    keep_open(&mut scenario);
    let mut game = scenario.start(22, 10);
    let rules = Combat::default();
    for x in [20.0, 40.0, 60.0] {
        let tick = game.step(&rules).unwrap();
        assert!(!has(&tick, Fact::Eliminated { actor: B }));
        assert_eq!(
            game.state().projectiles[&ProjectileId(12)].position,
            [x, 0.0]
        );
    }
    let impact = game.step(&rules).unwrap();
    assert!(has(
        &impact,
        Fact::KillCredited {
            actor: A,
            target: B
        }
    ));
    assert_eq!(game.state().actors[&A].kills, 1);
    assert!(game.state().projectiles.is_empty());
}

#[test]
fn specter_uses_the_solved_positions_and_reveal_starts_next_tick() {
    let mut scenario = Scenario::default();
    add(&mut scenario, B, 0.0, 50.0, Some(Kit::Specter));
    add(&mut scenario, A, 452.0, 50.0, None);
    add(&mut scenario, C, 480.0, 50.0, None);
    let mut game = scenario.start(10, 10);
    submit(
        &mut game,
        B,
        1,
        1,
        Input {
            skill: true,
            movement: [1.0, 0.0],
            ..Input::default()
        },
    );

    let tick = game.step(&Combat::default()).unwrap();
    assert!(has(&tick, Fact::SpecterScanned { actor: B }));
    assert_eq!(
        game.state().actors[&A].statuses[&Status::Reveal],
        Window {
            active_from: 2,
            expires_at: 112
        }
    );
    assert!(
        !game.state().actors[&C]
            .statuses
            .contains_key(&Status::Reveal)
    );
}

#[test]
fn projectile_allocation_and_expiry_use_the_firing_tick_and_spread_order() {
    let mut scenario = Scenario::default();
    add(&mut scenario, A, 0.0, 100.0, None);
    equip(&mut scenario, A, WeaponKind::Scattergun, 2);
    let mut game = scenario.start(10, 10);
    let mut rules = Combat::default();
    rules.rules.weapons[WeaponKind::Scattergun as usize].life = 3;
    submit(
        &mut game,
        A,
        1,
        1,
        Input {
            reload: true,
            ..attack(0.0)
        },
    );
    submit(
        &mut game,
        A,
        2,
        2,
        Input {
            drop: Some(DropSlot::Slot(1)),
            ..attack(0.0)
        },
    );

    let blocked = game.step(&rules).unwrap();
    assert!(!has(
        &blocked,
        Fact::ShotFired {
            actor: A,
            weapon: WeaponKind::Scattergun
        }
    ));
    assert_eq!(
        game.state().actors[&A]
            .inventory
            .selected_weapon()
            .unwrap()
            .1,
        2
    );
    let launched = game.step(&rules).unwrap();
    assert!(has(
        &launched,
        Fact::ShotFired {
            actor: A,
            weapon: WeaponKind::Scattergun
        }
    ));
    for id in 1..=5 {
        assert!(has(
            &launched,
            Fact::Placed {
                source: Entity::Actor(A),
                placed: Entity::Projectile(ProjectileId(id))
            }
        ));
        let projectile = game.state().projectiles[&ProjectileId(id)];
        assert_eq!((projectile.active_from, projectile.expires_at), (2, 4));
        assert_eq!(projectile.position, projectile.velocity);
    }
    let positions: Vec<_> = game
        .state()
        .projectiles
        .values()
        .map(|shot| shot.position[1])
        .collect();
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(
        game.state().actors[&A]
            .inventory
            .selected_weapon()
            .unwrap()
            .1,
        1
    );
    game.step(&rules).unwrap();
    assert!(game.state().projectiles.is_empty());
}

/// A shot from an eliminated owner (nothing it hits is its own), one tick from its first sweep.
fn shot(id: u32, from: [f64; 2], velocity: [f64; 2]) -> (ProjectileId, Projectile) {
    (
        ProjectileId(id),
        Projectile {
            source: Entity::Actor(A),
            position: from,
            velocity,
            damage: 10.0,
            active_from: 0,
            expires_at: 10,
        },
    )
}

/// The shooter A (eliminated, so it is no target) and one victim C at `x`, with `shapes` as the map's statics
/// (`true`: shots see it too) and `gates` its doors (`true`: open), and the shot below.
fn lane(
    x: f64,
    statics: Vec<(Shape, bool)>,
    gates: Vec<(Shape, bool)>,
    (id, projectile): (ProjectileId, Projectile),
) -> (Match, CompletedTick) {
    let mut scenario = Scenario::default();
    scenario.state.actors.insert(A, actor(Presence::Eliminated));
    add(&mut scenario, C, x, 90.0, None);
    keep_open(&mut scenario);
    for (index, (_, open)) in gates.iter().enumerate() {
        scenario.state.gates.insert(
            GateId(index as u32),
            Gate {
                building: None,
                position: [0.0, 0.0],
                open: *open,
                door: true,
                ..Gate::default()
            },
        );
    }
    scenario.geometry(Arc::new(SweptMap::new(
        statics.iter().map(|(shape, _)| shape.clone()).collect(),
        statics.iter().map(|(_, shots)| *shots).collect(),
        gates.into_iter().map(|(shape, _)| shape).collect(),
    )));
    scenario.state.projectiles.insert(id, projectile);
    let mut game = scenario.start(7, 10);
    let tick = game.step(&Combat::default()).unwrap();
    (game, tick)
}

fn wall(x: f64) -> Shape {
    Shape::Rect {
        x,
        y: -20.0,
        w: 2.0,
        h: 40.0,
    }
}

#[test]
fn shot_blocking_statics_and_closed_gates_stop_a_shot_while_see_through_ones_and_open_gates_pass() {
    // `true` in a static's flag: the map's voids, boundary and solid obstacles. `false`: a window or fence.
    let thrown = || shot(1, [20.0, 0.0], [65.0, 0.0]);
    let outcome = |statics, gates| {
        let (game, tick) = lane(70.0, statics, gates, thrown());
        assert!(game.state().projectiles.is_empty(), "consumed either way");
        has(&tick, hit_target(A, C))
    };
    assert!(
        !outcome(vec![(wall(50.0), true)], vec![]),
        "a void or wall stops the shot"
    );
    assert!(
        outcome(vec![(wall(50.0), false)], vec![]),
        "a window passes it"
    );
    assert!(
        !outcome(vec![], vec![(wall(50.0), false)]),
        "a closed gate stops it"
    );
    assert!(
        outcome(vec![], vec![(wall(50.0), true)]),
        "an open gate passes it"
    );
    assert!(
        outcome(vec![], vec![]),
        "nothing in the lane: the control hits"
    );
}

#[test]
fn geometry_beats_a_later_actor_while_an_earlier_actor_wins_and_an_equal_time_tie_goes_to_geometry()
{
    let thrown = || shot(1, [20.0, 0.0], [65.0, 0.0]);
    let blocks = |x: f64| {
        let (game, tick) = lane(x, vec![(wall(50.0), true)], vec![], thrown());
        assert!(game.state().projectiles.is_empty());
        (has(&tick, hit_target(A, C)), game.state().actors[&C].hp)
    };
    assert_eq!(blocks(70.0), (false, 90.0), "the wall comes first");
    assert_eq!(
        blocks(36.0),
        (true, 80.0),
        "an actor before the wall is hit"
    );
    // The contestant's hit radius 15 meets the wall's contact at the shot's radius 2 at x = 48: the same instant.
    assert_eq!(
        blocks(63.0),
        (false, 90.0),
        "geometry wins an equal-time contact"
    );
    // Exactly equal: a shot that starts touching the wall and overlapping the actor meets both at time zero.
    let (game, tick) = lane(
        60.0,
        vec![(wall(50.0), true)],
        vec![],
        shot(1, [49.0, 0.0], [65.0, 0.0]),
    );
    assert!(game.state().projectiles.is_empty());
    assert!(
        !has(&tick, hit_target(A, C)),
        "geometry wins a tie at time zero"
    );
}

#[test]
fn two_lethal_shots_in_one_tick_eliminate_in_hit_order_and_each_drops_its_loot() {
    let mut scenario = Scenario::default();
    scenario.state.actors.insert(A, actor(Presence::Eliminated));
    for (n, (id, x)) in [(C, 300.0), (B, 600.0)].into_iter().enumerate() {
        add(&mut scenario, id, x, 5.0, None);
        let cell = ItemId(40 + n as u32);
        scenario.state.actors.get_mut(&id).unwrap().inventory.slots[0] = Some(CarriedItem {
            id: cell,
            lineage: cell,
            equipment: Equipment {
                kind: EquipmentKind::Cell { charge: 100 },
                quality: 1,
            },
        });
    }
    keep_open(&mut scenario);
    let (first, a) = shot(1, [255.0, 0.0], [40.0, 0.0]);
    let (second, b) = shot(2, [555.0, 0.0], [40.0, 0.0]);
    scenario.state.projectiles.extend([(first, a), (second, b)]);
    let items = scenario.state.items.len();
    let mut game = scenario.start(7, 10);
    let tick = game.step(&Combat::default()).unwrap();
    let eliminated: Vec<_> = tick
        .changes
        .events
        .iter()
        .filter_map(|event| match event.fact {
            Fact::Eliminated { actor } => Some(actor),
            _ => None,
        })
        .collect();
    assert_eq!(eliminated, [C, B]);
    assert_eq!(
        game.state().items.len(),
        items + 2,
        "each death dropped its cell"
    );
    for id in [C, B] {
        assert!(
            game.state().actors[&id]
                .inventory
                .slots
                .iter()
                .all(Option::is_none)
        );
    }
    assert!(game.state().projectiles.is_empty());
}
