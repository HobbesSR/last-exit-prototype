use super::*;

fn add_actor(scenario: &mut Scenario, id: ActorId, x: f64) {
    scenario.state.actors.insert(id, actor(Presence::Active));
    scenario.body(BodyId::Actor(id), body(x));
}

fn cell(scenario: &mut Scenario, actor: ActorId, id: u32, charge: u32) {
    let id = ItemId(id);
    scenario
        .state
        .actors
        .get_mut(&actor)
        .unwrap()
        .inventory
        .slots[0] = Some(CarriedItem {
        id,
        lineage: id,
        equipment: Equipment {
            kind: EquipmentKind::Cell { charge },
            quality: 1,
        },
    });
}

fn interact(game: &mut Match, actor: ActorId, tick: Tick, target: Option<Target>) {
    submit(
        game,
        actor,
        tick,
        u64::from(tick),
        Input {
            interact: true,
            target,
            ..Input::default()
        },
    );
}

fn has(tick: &CompletedTick, fact: Fact) -> bool {
    tick.changes.events.iter().any(|event| event.fact == fact)
}

#[test]
fn each_escape_carries_the_slots_left_after_it() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 10.0);
    add_actor(&mut scenario, C, 30.0);
    cell(&mut scenario, A, 10, 100);
    cell(&mut scenario, C, 11, 100);
    scenario.state.extraction = Some(Extraction {
        position: [0.0, 0.0],
        slots: 3,
    });
    let mut game = scenario.start(50, 10);
    interact(&mut game, A, 1, None);
    interact(&mut game, C, 1, None);
    let tick = game.step(&Combat::default()).unwrap();
    // The closer claimant takes the first slot; each fact pairs its actor with its own count.
    let counts: Vec<_> = tick
        .changes
        .events
        .iter()
        .filter_map(|event| match event.fact {
            Fact::Escaped { actor, slots, .. } => Some((actor, slots)),
            _ => None,
        })
        .collect();
    assert_eq!(counts.len(), 2);
    assert!(counts.contains(&(A, 2)) && counts.contains(&(C, 1)));
    assert_eq!(tick.changes.extraction.unwrap().slots, 1);
}

#[test]
fn closest_surviving_extraction_claimant_gets_the_last_slot() {
    for lethal in [false, true] {
        let mut scenario = Scenario::default();
        add_actor(&mut scenario, A, 10.0);
        add_actor(&mut scenario, C, 30.0);
        add_actor(&mut scenario, B, -40.0);
        scenario.state.actors.get_mut(&A).unwrap().hp = if lethal { 10.0 } else { 90.0 };
        scenario.state.actors.get_mut(&B).unwrap().kit = Some(Kit::Warden);
        cell(&mut scenario, A, 10, 100);
        cell(&mut scenario, C, 11, 100);
        scenario.state.extraction = Some(Extraction {
            position: [0.0, 0.0],
            slots: 1,
        });
        let mut game = scenario.start(50, 10);
        interact(&mut game, A, 1, None);
        interact(&mut game, C, 1, None);
        submit(
            &mut game,
            B,
            1,
            1,
            Input {
                attack: true,
                ..Input::default()
            },
        );
        let tick = game.step(&Combat::default()).unwrap();
        assert_eq!(has(&tick, Fact::Eliminated { actor: A }), lethal);
        assert_eq!(escaped(&tick, C, ItemId(11)), lethal);
        assert_eq!(escaped(&tick, A, ItemId(10)), !lethal);
        let winner = if lethal { C } else { A };
        assert_eq!(game.state().actors[&winner].presence, Presence::Escaped);
        assert_eq!(game.state().extraction.unwrap().slots, 0);
    }
}

#[test]
fn nominated_unavailable_target_does_not_fall_back_to_extraction() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    cell(&mut scenario, A, 10, 100);
    scenario.state.extraction = Some(Extraction {
        position: [10.0, 0.0],
        slots: 1,
    });
    let mut game = scenario.start(50, 10);
    interact(&mut game, A, 1, Some(Target::Gate(GateId(99))));
    let tick = game.step(&Combat::default()).unwrap();
    assert!(has(
        &tick,
        Fact::Rejected {
            actor: A,
            reason: Rejection::Interaction(Some(Target::Gate(GateId(99))))
        }
    ));
    assert_eq!(game.state().actors[&A].presence, Presence::Active);
    assert_eq!(game.state().extraction.unwrap().slots, 1);
}

#[test]
fn charging_starts_then_completes_before_the_cell_can_fund_extraction() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    cell(&mut scenario, A, 10, 99);
    let station = StationId(1);
    scenario.state.stations.insert(
        station,
        Station {
            kind: StationKind::Charging,
            position: [10.0, 0.0],
        },
    );
    scenario.state.extraction = Some(Extraction {
        position: [10.0, 0.0],
        slots: 1,
    });
    let mut game = scenario.start(50, 10);
    let rules = Combat::default();
    interact(&mut game, A, 1, None);
    let start = game.step(&rules).unwrap();
    assert!(has(&start, Fact::ChargingStarted { actor: A, station }));
    assert_eq!(
        game.state().actors[&A].inventory.slots[0]
            .unwrap()
            .equipment
            .kind,
        EquipmentKind::Cell { charge: 99 }
    );
    interact(&mut game, A, 2, Some(Target::Extraction));
    let complete = game.step(&rules).unwrap();
    assert!(has(&complete, Fact::CellCharged { actor: A, station }));
    assert!(!escaped(&complete, A, ItemId(10)));
    interact(&mut game, A, 3, None);
    let done = game.step(&rules).unwrap();
    assert!(escaped(&done, A, ItemId(10)));
}

#[test]
fn sensor_reveal_starts_next_tick_and_respects_sneak_and_cloak() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    add_actor(&mut scenario, C, 20.0);
    scenario.state.sensors.push([0.0, 0.0]);
    scenario.state.actors.get_mut(&A).unwrap().statuses.insert(
        Status::Cloak,
        Window {
            active_from: 0,
            expires_at: 10,
        },
    );
    let mut game = scenario.start(50, 10);
    submit(
        &mut game,
        C,
        1,
        1,
        Input {
            sneak: true,
            ..Input::default()
        },
    );
    let rules = Combat::default();
    game.step(&rules).unwrap();
    assert!(
        !game.state().actors[&A]
            .statuses
            .contains_key(&Status::Reveal)
    );
    assert!(
        !game.state().actors[&C]
            .statuses
            .contains_key(&Status::Reveal)
    );
    submit(
        &mut game,
        A,
        2,
        2,
        Input {
            attack: true,
            ..Input::default()
        },
    );
    submit(&mut game, C, 2, 2, Input::default());
    game.step(&rules).unwrap();
    let reveal = game.state().actors[&C].statuses[&Status::Reveal];
    assert!(!reveal.contains(2));
    assert!(reveal.contains(3));
}

#[test]
fn key_picked_up_after_a_locked_attempt_only_opens_the_gate_next_tick() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    let gate = GateId(0);
    scenario.state.gates.insert(
        gate,
        Gate {
            open: false,
            locked: true,
            door: true,
            position: [20.0, 0.0],
        },
    );
    let mut door = body(20.0);
    door.params.kind = crate::physics::KIND_STATIC;
    scenario.body(BodyId::Gate(gate), door);
    let key = ItemId(5);
    scenario.state.items.insert(
        key,
        GroundItem {
            loot: Loot::AccessKey,
            unplaced_at: None,
            ..pending_item()
        },
    );
    let mut spec = body(5.0);
    spec.params.kind = crate::physics::KIND_PROP;
    spec.params.groups = crate::physics::LOOT_GROUP << 16 | 1;
    scenario.body(BodyId::Item(key), spec);
    let mut game = scenario.start(50, 10);
    let rules = Combat::default();
    interact(&mut game, A, 1, Some(Target::Gate(gate)));
    let first = game.step(&rules).unwrap();
    assert!(has(
        &first,
        Fact::Rejected {
            actor: A,
            reason: Rejection::GateLocked(gate)
        }
    ));
    assert!(!game.state().gates[&gate].open);
    assert_eq!(game.state().actors[&A].inventory.keys, 1);
    interact(&mut game, A, 2, Some(Target::Gate(gate)));
    let second = game.step(&rules).unwrap();
    assert!(has(
        &second,
        Fact::GateObserved {
            actor: A,
            gate,
            open: false,
            locked: true
        }
    ));
    assert!(has(
        &second,
        Fact::GateChanged {
            actor: A,
            gate,
            open: true
        }
    ));
    assert!(game.state().gates[&gate].open);
    assert_eq!(game.state().actors[&A].inventory.keys, 0);
    assert_eq!(game.position(BodyId::Gate(gate)), None);
}

#[test]
fn default_interact_prefers_extraction_to_a_closer_gate() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    cell(&mut scenario, A, 10, 100);
    let gate = GateId(0);
    scenario.state.gates.insert(
        gate,
        Gate {
            open: false,
            locked: false,
            door: true,
            position: [10.0, 0.0],
        },
    );
    scenario.body(BodyId::Gate(gate), body(10.0));
    scenario.state.extraction = Some(Extraction {
        position: [-25.0, 0.0],
        slots: 1,
    });
    let mut game = scenario.start(50, 10);
    interact(&mut game, A, 1, None);
    let tick = game.step(&Combat::default()).unwrap();
    assert!(escaped(&tick, A, ItemId(10)));
    assert!(!game.state().gates[&gate].open);
}

#[test]
fn an_unresolved_nomination_is_rejected_and_allows_no_other_gesture() {
    for pressed in [true, false] {
        let mut scenario = Scenario::default();
        add_actor(&mut scenario, B, 0.0);
        rail_station(&mut scenario, 1, 0.0);
        let destination = rail_station(&mut scenario, 2, 400.0);
        keep_open(&mut scenario);
        let mut game = scenario.start(50, 10);
        // A valid rail destination competes with the failed nomination; R8 never falls through.
        submit(
            &mut game,
            B,
            1,
            1,
            Input {
                interact: pressed,
                target: Some(Target::Unresolved),
                transit: Some(destination),
                movement: [1.0, 0.0],
                ..Input::default()
            },
        );
        let tick = game.step(&Combat::default()).unwrap();
        let rejected = Fact::Rejected {
            actor: B,
            reason: Rejection::Interaction(Some(Target::Unresolved)),
        };
        // Pressed, the core rejects it so the player learns why; unpressed, nothing was asked.
        assert_eq!(has(&tick, rejected), pressed);
        assert!(
            !tick
                .changes
                .events
                .iter()
                .any(|event| matches!(event.fact, Fact::TransitLanded { .. }))
        );
        assert!(game.state().actors[&B].transit.is_none());
        // Movement stands.
        assert!(tick.solved.position(BodyId::Actor(B)).unwrap()[0] > 0.0);
    }
}

fn rail_station(scenario: &mut Scenario, id: u32, x: f64) -> StationId {
    let id = StationId(id);
    scenario.state.stations.insert(
        id,
        Station {
            kind: StationKind::Transit,
            position: [x, 0.0],
        },
    );
    id
}

#[test]
fn instant_transit_keeps_its_solved_origin_and_arbitrates_landing_space() {
    let mut scenario = Scenario::default();
    let other = ActorId {
        seat: B.seat + 1,
        ..B
    };
    add_actor(&mut scenario, B, 0.0);
    add_actor(&mut scenario, other, 10.0);
    let source = rail_station(&mut scenario, 1, 0.0);
    let destination = rail_station(&mut scenario, 2, 400.0);
    keep_open(&mut scenario);
    let mut game = scenario.start(50, 10);
    submit(
        &mut game,
        B,
        1,
        1,
        Input {
            transit: Some(source),
            interact: true,
            ..Input::default()
        },
    );
    let refused = game.step(&Combat::default()).unwrap();
    assert!(has(
        &refused,
        Fact::Rejected {
            actor: B,
            reason: Rejection::Transit(source)
        }
    ));
    assert_eq!(game.position(BodyId::Actor(B)), Some([0.0, 0.0]));

    for actor in [B, other] {
        submit(
            &mut game,
            actor,
            2,
            2,
            Input {
                transit: Some(destination),
                ..Input::default()
            },
        );
    }
    let tick = game.step(&Combat::default()).unwrap();
    for (actor, origin) in [(B, 0.0), (other, 10.0)] {
        assert!(has(&tick, Fact::TransitLanded { actor, destination }));
        assert!((tick.solved.position(BodyId::Actor(actor)).unwrap()[0] - origin).abs() < 0.001);
        assert_eq!(game.state().actors[&actor].deadlines.transit_ready_at, 182);
    }
    let first = game.position(BodyId::Actor(B)).unwrap();
    let second = game.position(BodyId::Actor(other)).unwrap();
    assert!((first[0] - second[0]).abs() > 2.0);
}

#[test]
fn timed_riders_can_depart_for_the_same_clear_destination() {
    let mut scenario = Scenario::default();
    let other = ActorId {
        seat: B.seat + 1,
        ..B
    };
    add_actor(&mut scenario, B, 0.0);
    add_actor(&mut scenario, other, 10.0);
    rail_station(&mut scenario, 1, 0.0);
    let destination = rail_station(&mut scenario, 2, 400.0);
    // Only one radius-one actor could occupy the destination.
    scenario.bounds([-1.1, -1.1], [401.1, 1.1]);
    scenario.geometry(Arc::new(SweptMap::new(
        vec![Shape::Rect {
            x: 300.0,
            y: -2.0,
            w: 98.5,
            h: 4.0,
        }],
        vec![true],
        vec![],
    )));
    let mut game = scenario.start(50, 10);
    let mut rules = Combat::default();
    rules.interactions.transit_base = 5.0;
    for actor in [B, other] {
        submit(
            &mut game,
            actor,
            1,
            1,
            Input {
                transit: Some(destination),
                ..Input::default()
            },
        );
    }
    let tick = game.step(&rules).unwrap();
    for (actor, x) in [(B, 0.0), (other, 10.0)] {
        assert!(has(&tick, Fact::TransitDeparted { actor, destination }));
        assert!(!has(&tick, Fact::TransitLanded { actor, destination }));
        let record = &game.state().actors[&actor];
        assert_eq!(record.presence, Presence::Transit);
        let ride = record.transit.unwrap();
        assert_eq!((ride.destination, ride.arrive_at), (destination, 6));
        assert!((ride.origin[0] - x).abs() < 0.001);
        assert_eq!(game.position(BodyId::Actor(actor)), None);
    }
}

#[test]
fn solved_occupants_block_door_closure_until_they_escape() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    add_actor(&mut scenario, C, 20.0);
    cell(&mut scenario, C, 9, 100);
    scenario.state.extraction = Some(Extraction {
        position: [20.0, 0.0],
        slots: 1,
    });
    let gate = GateId(0);
    scenario.state.gates.insert(
        gate,
        Gate {
            open: true,
            door: true,
            position: [20.0, 0.0],
            ..Gate::default()
        },
    );
    let mut spec = body(20.0);
    spec.params.kind = crate::physics::KIND_STATIC;
    spec.shape = crate::physics::SHAPE_BOX;
    spec.dimensions = [2.0, 5.0];
    scenario.body(BodyId::Gate(gate), spec);
    let grid = &[0, 0, 0, 0, 0];
    scenario.sight(
        Arc::new(SightIndex::new(&[], grid, &[], &[0], grid)),
        Arc::new(GateSet::new(&[], &[0, 0], &[18.0, -5.0, 4.0, 10.0], grid)),
    );
    let mut game = scenario.start(50, 10);
    assert_eq!(game.position(BodyId::Gate(gate)), None);
    interact(&mut game, A, 1, Some(Target::Gate(gate)));
    let first = game.step(&Combat::default()).unwrap();
    assert!(has(
        &first,
        Fact::Rejected {
            actor: A,
            reason: Rejection::GateOccupied(gate)
        }
    ));

    interact(&mut game, A, 2, Some(Target::Gate(gate)));
    interact(&mut game, C, 2, Some(Target::Extraction));
    let second = game.step(&Combat::default()).unwrap();
    assert!(escaped(&second, C, ItemId(9)));
    assert!(has(
        &second,
        Fact::GateChanged {
            actor: A,
            gate,
            open: false
        }
    ));
    assert_eq!(game.position(BodyId::Actor(C)), None);
    assert!(game.position(BodyId::Gate(gate)).is_some());
}

#[test]
fn movement_cancels_charging_without_progress() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    cell(&mut scenario, A, 10, 10);
    let station = StationId(1);
    scenario.state.stations.insert(
        station,
        Station {
            kind: StationKind::Charging,
            position: [5.0, 0.0],
        },
    );
    let mut game = scenario.start(50, 10);
    let rules = Combat::default();
    interact(&mut game, A, 1, None);
    game.step(&rules).unwrap();
    submit(
        &mut game,
        A,
        2,
        2,
        Input {
            movement: [1.0, 0.0],
            ..Input::default()
        },
    );
    let tick = game.step(&rules).unwrap();
    assert!(has(&tick, Fact::ChargingStopped { actor: A, station }));
    let actor = &game.state().actors[&A];
    assert_eq!(actor.charging, None);
    assert_eq!(
        actor.inventory.slots[0].unwrap().equipment.kind,
        EquipmentKind::Cell { charge: 10 }
    );
}

#[test]
fn opposite_gate_intents_use_rewound_state_and_seeded_contention() {
    let gate = GateId(0);
    for seed in [1, 2, 3, 4] {
        let mut scenario = Scenario::default();
        add_actor(&mut scenario, A, 0.0);
        add_actor(&mut scenario, C, 1.0);
        scenario.state.actors.get_mut(&A).unwrap().view_lag = 1;
        scenario.state.gates.insert(
            gate,
            Gate {
                open: true,
                door: true,
                position: [20.0, 0.0],
                ..Gate::default()
            },
        );
        scenario.history.insert(
            0,
            RewindFrame {
                gates: BTreeMap::from([(gate, false)]),
                ..RewindFrame::default()
            },
        );
        let mut game = scenario.start(seed, 10);
        interact(&mut game, C, 1, Some(Target::Gate(gate)));
        interact(&mut game, A, 1, Some(Target::Gate(gate)));
        let tick = game.step(&Combat::default()).unwrap();
        let rank = |actor| {
            (
                contest_score(seed, 1, 0x6761_7465_0000_0000, actor_word(actor)),
                actor,
            )
        };
        let expected_open = rank(A) < rank(C);
        let loser = if expected_open { C } else { A };
        assert!(has(
            &tick,
            Fact::Rejected {
                actor: loser,
                reason: Rejection::GateContested(gate)
            }
        ));
        assert_eq!(game.state().gates[&gate].open, expected_open);
    }
}

#[test]
fn gates_and_full_inventory_swaps_share_the_distance_tier() {
    for (gate_x, swap) in [(5.0, false), (35.0, true)] {
        let mut scenario = Scenario::default();
        add_actor(&mut scenario, A, 0.0);
        cell(&mut scenario, A, 10, 0);
        let inventory = &mut scenario.state.actors.get_mut(&A).unwrap().inventory;
        let template = inventory.slots[0].unwrap();
        for (index, slot) in inventory.slots.iter_mut().enumerate().skip(1) {
            let id = ItemId(10 + index as u32);
            *slot = Some(CarriedItem {
                id,
                lineage: id,
                ..template
            });
        }
        let gate = GateId(0);
        scenario.state.gates.insert(
            gate,
            Gate {
                position: [gate_x, 0.0],
                door: true,
                ..Gate::default()
            },
        );
        let item = ItemId(20);
        scenario.state.items.insert(
            item,
            GroundItem {
                unplaced_at: None,
                ..pending_item()
            },
        );
        let mut spec = body(20.0);
        spec.params.kind = crate::physics::KIND_PROP;
        spec.params.groups = crate::physics::LOOT_GROUP << 16 | 1;
        scenario.body(BodyId::Item(item), spec);

        let mut game = scenario.start(50, 10);
        interact(&mut game, A, 1, None);
        let tick = game.step(&Combat::default()).unwrap();
        assert_eq!(
            has(
                &tick,
                Fact::Pickup {
                    actor: A,
                    item,
                    count: 1
                }
            ),
            swap
        );
        assert_eq!(
            has(
                &tick,
                Fact::GateChanged {
                    actor: A,
                    gate,
                    open: true
                }
            ),
            !swap
        );
        assert_eq!(game.state().items.contains_key(&item), !swap);
    }
}

#[test]
fn a_solid_dynamic_prop_blocks_a_close() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    let gate = GateId(0);
    scenario.state.gates.insert(
        gate,
        Gate {
            open: true,
            door: true,
            position: [20.0, 0.0],
            ..Gate::default()
        },
    );
    let mut door = body(20.0);
    door.params.kind = crate::physics::KIND_STATIC;
    door.shape = crate::physics::SHAPE_BOX;
    door.dimensions = [2.0, 5.0];
    scenario.body(BodyId::Gate(gate), door);
    let mut prop = body(20.0);
    prop.params.kind = crate::physics::KIND_PROP;
    scenario.body(BodyId::Prop(0), prop);
    let mut game = scenario.start(50, 10);
    interact(&mut game, A, 1, Some(Target::Gate(gate)));
    let tick = game.step(&Combat::default()).unwrap();
    assert!(has(
        &tick,
        Fact::Rejected {
            actor: A,
            reason: Rejection::GateOccupied(gate)
        }
    ));
    assert!(game.state().gates[&gate].open);
    assert_eq!(game.position(BodyId::Gate(gate)), None);
}
