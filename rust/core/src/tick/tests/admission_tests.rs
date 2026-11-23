use super::*;

fn station(scenario: &mut Scenario, id: u32, x: f64, kind: StationKind) -> StationId {
    let id = StationId(id);
    scenario.state.stations.insert(
        id,
        Station {
            kind,
            position: [x, 0.0],
        },
    );
    id
}

fn rider(scenario: &mut Scenario, id: ActorId, destination: StationId, arrive_at: Tick) {
    let mut record = actor(Presence::Transit);
    record.transit = Some(Transit {
        destination,
        origin: [0.0, 0.0],
        arrive_at,
    });
    scenario.state.actors.insert(id, record);
    scenario.body(BodyId::Actor(id), body(0.0));
}

fn pending_gladiator(scenario: &mut Scenario, id: ActorId, due: Tick) {
    let mut record = actor(Presence::Pending);
    record.respawn_at = Some(due);
    record.hp = 0.0;
    scenario.state.actors.insert(id, record);
    scenario.body(BodyId::Actor(id), body(0.0));
}

fn has(tick: &CompletedTick, fact: Fact) -> bool {
    tick.changes.events.iter().any(|event| event.fact == fact)
}

#[test]
fn due_arrival_is_not_solved_or_allowed_to_spend_input_until_next_tick() {
    let mut scenario = Scenario::default();
    let destination = station(&mut scenario, 1, 400.0, StationKind::Transit);
    rider(&mut scenario, B, destination, 2);
    keep_open(&mut scenario);
    let mut game = scenario.start(50, 10);
    let rules = Combat::default();
    assert_eq!(game.position(BodyId::Actor(B)), None);
    submit(
        &mut game,
        B,
        1,
        1,
        Input {
            movement: [1.0, 0.0],
            ..Input::default()
        },
    );
    let early = game.step(&rules).unwrap();
    assert!(!has(
        &early,
        Fact::TransitLanded {
            actor: B,
            destination
        }
    ));
    assert_eq!(game.position(BodyId::Actor(B)), None);
    submit(
        &mut game,
        B,
        2,
        2,
        Input {
            movement: [1.0, 0.0],
            ..Input::default()
        },
    );
    let arrival = game.step(&rules).unwrap();
    assert!(has(
        &arrival,
        Fact::TransitLanded {
            actor: B,
            destination
        }
    ));
    assert_eq!(arrival.solved.position(BodyId::Actor(B)), None);
    assert_eq!(game.acknowledged(B), None);
    assert_eq!(game.state().actors[&B].transit, None);
    let landed = game.position(BodyId::Actor(B)).unwrap();
    game.step(&rules).unwrap();
    assert_eq!(game.acknowledged(B), None);
    assert_eq!(game.position(BodyId::Actor(B)).unwrap(), landed);
    submit(
        &mut game,
        B,
        4,
        4,
        Input {
            movement: [1.0, 0.0],
            ..Input::default()
        },
    );
    game.step(&rules).unwrap();
    assert_eq!(game.acknowledged(B), Some(4));
    assert!(game.position(BodyId::Actor(B)).unwrap()[0] > landed[0]);
}

#[test]
fn due_arrivals_contend_for_a_single_site_then_retry_after_it_is_vacated() {
    let mut scenario = Scenario::default();
    let other = ActorId {
        seat: A.seat + 1,
        ..A
    };
    let destination = station(&mut scenario, 1, 400.0, StationKind::Transit);
    for id in [A, other] {
        rider(&mut scenario, id, destination, 1);
        scenario.state.actors.get_mut(&id).unwrap().inventory.slots[0] = Some(CarriedItem {
            id: ItemId(id.seat),
            lineage: ItemId(id.seat),
            equipment: Equipment {
                kind: EquipmentKind::Cell { charge: 100 },
                quality: 1,
            },
        });
    }
    scenario.bounds([398.9, -1.1], [401.1, 1.1]);
    scenario.state.extraction = Some(Extraction {
        position: [400.0, 0.0],
        slots: 2, // spending the last slot would end the match (R12)
    });
    keep_open(&mut scenario);
    let mut game = scenario.start(50, 10);
    let rules = Combat::default();
    let first = game.step(&rules).unwrap();
    let winners: Vec<_> = [A, other]
        .into_iter()
        .filter(|&id| {
            has(
                &first,
                Fact::TransitLanded {
                    actor: id,
                    destination,
                },
            )
        })
        .collect();
    assert_eq!(winners.len(), 1);
    let winner = winners[0];
    let waiting = if winner == A { other } else { A };
    assert_eq!(game.state().actors[&waiting].presence, Presence::Transit);
    assert_eq!(game.position(BodyId::Actor(waiting)), None);
    let blocked = game.step(&rules).unwrap();
    assert!(!has(
        &blocked,
        Fact::TransitLanded {
            actor: waiting,
            destination
        }
    ));
    submit(
        &mut game,
        winner,
        3,
        3,
        Input {
            interact: true,
            target: Some(Target::Extraction),
            ..Input::default()
        },
    );
    let retry = game.step(&rules).unwrap();
    assert!(has(
        &retry,
        Fact::TransitLanded {
            actor: waiting,
            destination
        }
    ));
    assert_eq!(game.state().actors[&waiting].presence, Presence::Active);
}

#[test]
fn respawn_uses_westmost_eligible_transit_station_and_waits_for_deadline() {
    let mut scenario = Scenario::default();
    scenario.state.hazard_x = Some(0.0);
    station(&mut scenario, 1, 350.0, StationKind::Transit);
    station(&mut scenario, 2, 450.0, StationKind::Charging);
    station(&mut scenario, 3, 600.0, StationKind::Transit);
    station(&mut scenario, 4, 900.0, StationKind::Transit);
    pending_gladiator(&mut scenario, B, 2);
    keep_open(&mut scenario);
    let mut game = scenario.start(50, 10);
    let rules = Combat::default();
    assert_eq!(game.position(BodyId::Actor(B)), None);
    let early = game.step(&rules).unwrap();
    assert!(!has(&early, Fact::Respawned { actor: B }));
    submit(
        &mut game,
        B,
        2,
        2,
        Input {
            movement: [1.0, 0.0],
            ..Input::default()
        },
    );
    let due = game.step(&rules).unwrap();
    assert!(has(&due, Fact::Respawned { actor: B }));
    assert_eq!(due.solved.position(BodyId::Actor(B)), None);
    assert_eq!(game.state().actors[&B].presence, Presence::Active);
    assert_eq!(game.state().actors[&B].respawn_at, None);
    assert_eq!(game.position(BodyId::Actor(B)), Some([600.0, 0.0]));
    assert_eq!(game.acknowledged(B), None);
    submit(
        &mut game,
        B,
        3,
        3,
        Input {
            movement: [1.0, 0.0],
            ..Input::default()
        },
    );
    game.step(&rules).unwrap();
    assert_eq!(game.acknowledged(B), Some(3));
    assert!(game.position(BodyId::Actor(B)).unwrap()[0] > 600.0);
}

#[test]
fn respawn_and_arrival_share_placement_reservations() {
    for seed in [1, 2, 3, 4, 50] {
        let mut scenario = Scenario::default();
        scenario.state.hazard_x = Some(0.0);
        let destination = station(&mut scenario, 1, 600.0, StationKind::Transit);
        pending_gladiator(&mut scenario, B, 1);
        rider(&mut scenario, C, destination, 1);
        let mut game = scenario.start(seed, 10);
        let tick = game.step(&Combat::default()).unwrap();
        assert!(has(&tick, Fact::Respawned { actor: B }));
        assert!(has(
            &tick,
            Fact::TransitLanded {
                actor: C,
                destination
            }
        ));
        let a = game.position(BodyId::Actor(B)).unwrap();
        let b = game.position(BodyId::Actor(C)).unwrap();
        assert!(crate::math::hypot(a[0] - b[0], a[1] - b[1]) >= 2.0);
        let rank = |id| {
            (
                contest_score(
                    seed,
                    1,
                    0x706c_6163_6500_0000 ^ u64::MAX.rotate_left(16),
                    actor_word(id),
                ),
                id,
            )
        };
        let first = if rank(B) < rank(C) { a } else { b };
        assert_eq!(first, [600.0, 0.0], "seed {seed}");
    }
}

#[test]
fn pending_item_retries_body_placement_after_clearance_changes() {
    let mut scenario = Scenario::default();
    for (id, x) in [(A, 0.0), (C, 20.0)] {
        scenario.state.actors.insert(id, actor(Presence::Active));
        scenario.body(BodyId::Actor(id), body(x));
    }
    let cell = ItemId(10);
    let extractor = scenario.state.actors.get_mut(&A).unwrap();
    extractor.bot = true; // A bot carrying a cell leaves the ground cell alone.
    extractor.inventory.slots[0] = Some(CarriedItem {
        id: cell,
        lineage: cell,
        equipment: Equipment {
            kind: EquipmentKind::Cell { charge: 100 },
            quality: 1,
        },
    });
    scenario.state.extraction = Some(Extraction {
        position: [0.0, 0.0],
        slots: 2, // spending the last slot would end the match (R12)
    });
    let item = ItemId(20);
    scenario.state.items.insert(
        item,
        GroundItem {
            dropped_by: Some(C),
            pickup_ready_at: 3,
            ..pending_item()
        },
    );
    keep_open(&mut scenario);
    let mut game = scenario.start(50, 10);
    let rules = Combat::default();
    game.step(&rules).unwrap();
    assert_eq!(game.state().items[&item].unplaced_at, Some([0.0, 0.0]));
    assert_eq!(game.position(BodyId::Item(item)), None);
    submit(
        &mut game,
        A,
        2,
        2,
        Input {
            interact: true,
            target: Some(Target::Extraction),
            ..Input::default()
        },
    );
    submit(
        &mut game,
        C,
        2,
        2,
        Input {
            interact: true,
            target: Some(Target::Item(item)),
            ..Input::default()
        },
    );
    let admission = game.step(&rules).unwrap();
    assert!(escaped(&admission, A, cell));
    assert!(has(
        &admission,
        Fact::Rejected {
            actor: C,
            reason: Rejection::Pickup(item)
        }
    ));
    assert_eq!(game.state().items[&item].unplaced_at, None);
    assert_eq!(game.position(BodyId::Item(item)), Some([0.0, 0.0]));
    submit(
        &mut game,
        C,
        3,
        3,
        Input {
            interact: true,
            target: Some(Target::Item(item)),
            ..Input::default()
        },
    );
    let pickup = game.step(&rules).unwrap();
    assert!(has(
        &pickup,
        Fact::Pickup {
            actor: C,
            item,
            count: 1
        }
    ));
    assert!(!game.state().items.contains_key(&item));
}

#[test]
fn a_due_rider_sees_the_gate_committed_in_apply() {
    use crate::swept::Shape;

    let mut scenario = Scenario::default();
    scenario.state.actors.insert(A, actor(Presence::Active));
    scenario.body(BodyId::Actor(A), body(350.0));
    scenario.state.actors.insert(B, actor(Presence::Active));
    scenario.body(BodyId::Actor(B), body(0.0));
    station(&mut scenario, 1, 0.0, StationKind::Transit);
    let destination = station(&mut scenario, 2, 400.0, StationKind::Transit);
    scenario.bounds([398.9, -1.1], [401.1, 1.1]);
    let gate = GateId(0);
    scenario.state.gates.insert(
        gate,
        Gate {
            position: [400.0, 0.0],
            open: true,
            door: true,
            ..Gate::default()
        },
    );
    let mut door = body(400.0);
    door.params.kind = crate::physics::KIND_STATIC;
    door.shape = crate::physics::SHAPE_BOX;
    door.dimensions = [1.5, 5.0];
    scenario.body(BodyId::Gate(gate), door);
    scenario.geometry(Arc::new(SweptMap::new(
        vec![],
        vec![],
        vec![Shape::Rect {
            x: 398.5,
            y: -5.0,
            w: 3.0,
            h: 10.0,
        }],
    )));
    let mut game = scenario.start(50, 10);
    let mut rules = Combat::default();
    rules.interactions.transit_base = 1.0;
    submit(
        &mut game,
        B,
        1,
        1,
        Input {
            transit: Some(destination),
            ..Input::default()
        },
    );
    let departure = game.step(&rules).unwrap();
    assert!(has(
        &departure,
        Fact::TransitDeparted {
            actor: B,
            destination
        }
    ));
    let landing = Fact::TransitLanded {
        actor: B,
        destination,
    };
    for (tick, open) in [(2, false), (3, true)] {
        submit(
            &mut game,
            A,
            tick,
            u64::from(tick),
            Input {
                interact: true,
                target: Some(Target::Gate(gate)),
                ..Input::default()
            },
        );
        let result = game.step(&rules).unwrap();
        assert!(has(
            &result,
            Fact::GateChanged {
                actor: A,
                gate,
                open
            }
        ));
        assert_eq!(has(&result, landing), open);
        assert_eq!(game.position(BodyId::Actor(B)).is_some(), open);
    }
}

#[test]
fn pending_items_leave_the_drop_reserve_free() {
    let mut scenario = Scenario::default();
    scenario.state.actors.insert(A, actor(Presence::Active));
    scenario.body(BodyId::Actor(A), body(-200.0));
    let held = ItemId(5);
    scenario.state.actors.get_mut(&A).unwrap().inventory.slots[0] = Some(CarriedItem {
        id: held,
        lineage: held,
        equipment: Equipment {
            kind: EquipmentKind::Cell { charge: 0 },
            quality: 1,
        },
    });
    let waiting = [ItemId(20), ItemId(21), ItemId(22)];
    for (i, &id) in waiting.iter().enumerate() {
        scenario.state.items.insert(
            id,
            GroundItem {
                unplaced_at: Some([100.0 * (i as f64 + 1.0), 0.0]),
                ..pending_item()
            },
        );
    }
    keep_open(&mut scenario);
    let mut game = scenario.start(50, 10);
    let mut rules = Combat::default();
    // Four dynamic bodies, one held back for drops: the actor and two items fill the rest.
    rules.items.drops.body_capacity = 4;
    rules.items.drops.drop_reserve = 1;
    game.step(&rules).unwrap();
    let unplaced = |game: &Match| {
        waiting
            .iter()
            .filter(|id| game.state().items[id].unplaced_at.is_some())
            .count()
    };
    assert_eq!(unplaced(&game), 1);
    submit(
        &mut game,
        A,
        2,
        2,
        Input {
            drop: Some(DropSlot::Slot(0)),
            ..Input::default()
        },
    );
    game.step(&rules).unwrap();
    assert!(game.state().actors[&A].inventory.slots[0].is_none());
    assert!(game.position(BodyId::Item(held)).is_some());
    assert_eq!(unplaced(&game), 1);
}
