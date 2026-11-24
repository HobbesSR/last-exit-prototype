//! 3b.7: terminal predicates, rewind capture and discovery at the close of a tick (27.2 R12).

use super::*;

/// A fourth contestant, last in canonical order after C (seat 2) and A (seat 10).
const D: ActorId = ActorId {
    kind: ActorKind::Contestant,
    seat: 11,
};

fn add_actor(scenario: &mut Scenario, id: ActorId, x: f64) {
    scenario.state.actors.insert(id, actor(Presence::Active));
    scenario.body(BodyId::Actor(id), body(x));
}

fn charged_cell(scenario: &mut Scenario, actor: ActorId, id: u32) -> ItemId {
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
            kind: EquipmentKind::Cell { charge: 100 },
            quality: 1,
        },
    });
    id
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

fn station(scenario: &mut Scenario, id: u32, x: f64) -> StationId {
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

fn locked_gate(scenario: &mut Scenario, x: f64) -> GateId {
    let gate = GateId(0);
    scenario.state.gates.insert(
        gate,
        Gate {
            building: None,
            open: false,
            locked: true,
            door: true,
            position: [x, 0.0],
        },
    );
    let mut door = body(x);
    door.params.kind = crate::physics::KIND_STATIC;
    scenario.body(BodyId::Gate(gate), door);
    gate
}

#[test]
fn the_final_tick_completes_its_claims_then_strands_the_rest() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 10.0);
    add_actor(&mut scenario, C, 300.0);
    add_actor(&mut scenario, B, -300.0);
    let cell = charged_cell(&mut scenario, A, 10);
    scenario.state.extraction = Some(Extraction {
        position: [0.0, 0.0],
        slots: 2,
    });
    let mut game = scenario.start(50, 10);
    let rules = Combat::default();
    for _ in 1..10 {
        assert!(!has(&game.step(&rules).unwrap(), Fact::Finished));
    }
    interact(&mut game, A, 10, Some(Target::Extraction));
    let last = game.step(&rules).unwrap();
    assert_eq!(last.tick, 10);
    // The time limit ends the match only after the final tick's own claims commit.
    assert!(escaped(&last, A, cell));
    assert_eq!(last.changes.events.last().unwrap().fact, Fact::Finished);
    assert_eq!(game.state().actors[&A].presence, Presence::Escaped);
    assert_eq!(game.state().actors[&C].presence, Presence::Stranded);
    assert_eq!(game.state().actors[&B].presence, Presence::Active);
    assert_eq!(game.position(BodyId::Actor(C)), None);
    // C's stagger slot is tick 10, but a stranded contestant does not sample.
    assert!(last.discovery.samples.is_empty());
    let frame = game.history().frame(10).unwrap();
    assert_eq!(frame.poses.keys().copied().collect::<Vec<_>>(), [B]);
    assert!(!game.submit(11, Inbound::Observation(Observation::Leave { actor: B })));
    assert!(game.step(&rules).is_none());
}

#[test]
fn spending_the_last_slot_or_losing_the_last_contestant_ends_the_match_early() {
    // The last slot: the escape commits and the other active contestant is stranded.
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 10.0);
    add_actor(&mut scenario, C, 300.0);
    add_actor(&mut scenario, B, -300.0);
    let cell = charged_cell(&mut scenario, A, 10);
    scenario.state.extraction = Some(Extraction {
        position: [0.0, 0.0],
        slots: 1,
    });
    let mut game = scenario.start(50, 100);
    interact(&mut game, A, 1, Some(Target::Extraction));
    let tick = game.step(&Combat::default()).unwrap();
    assert!(escaped(&tick, A, cell));
    assert!(has(&tick, Fact::Finished));
    assert_eq!(game.state().actors[&C].presence, Presence::Stranded);
    assert_eq!(game.state().actors[&B].presence, Presence::Active);
    assert!(game.step(&Combat::default()).is_none());

    // The last contestant eliminated: nobody is left to strand.
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 30.0);
    add_actor(&mut scenario, B, -40.0);
    scenario.state.actors.get_mut(&A).unwrap().hp = 5.0;
    scenario.state.actors.get_mut(&B).unwrap().kit = Some(Kit::Warden);
    let mut game = scenario.start(50, 100);
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
    assert!(has(&tick, Fact::Eliminated { actor: A }));
    assert!(has(&tick, Fact::Finished));
    assert_eq!(game.state().actors[&A].presence, Presence::Eliminated);
    assert!(game.step(&Combat::default()).is_none());
}

#[test]
fn rewind_captures_admissions_warps_and_removals_from_the_committed_state() {
    let mut scenario = Scenario::default();
    let rider = ActorId {
        seat: B.seat + 1,
        ..B
    };
    add_actor(&mut scenario, A, 10.0);
    add_actor(&mut scenario, B, -100.0);
    add_actor(&mut scenario, C, 200.0);
    let cell = charged_cell(&mut scenario, A, 10);
    scenario.state.extraction = Some(Extraction {
        position: [0.0, 0.0],
        slots: 2,
    });
    station(&mut scenario, 1, -100.0);
    let landing = station(&mut scenario, 2, 600.0);
    let arrival = station(&mut scenario, 3, 900.0);
    let mut record = actor(Presence::Transit);
    record.transit = Some(Transit {
        destination: arrival,
        origin: [0.0, 0.0],
        arrive_at: 1,
    });
    scenario.state.actors.insert(rider, record);
    scenario.body(BodyId::Actor(rider), body(0.0));
    let gate = GateId(0);
    scenario.state.gates.insert(
        gate,
        Gate {
            building: None,
            open: false,
            locked: false,
            door: true,
            position: [215.0, 0.0],
        },
    );
    let mut door = body(215.0);
    door.params.kind = crate::physics::KIND_STATIC;
    scenario.body(BodyId::Gate(gate), door);
    let drop = ItemId(20);
    scenario.state.items.insert(
        drop,
        GroundItem {
            building: None,
            unplaced_at: Some([-400.0, 0.0]),
            ..pending_item()
        },
    );
    let mut game = scenario.start(50, 10);
    interact(&mut game, A, 1, Some(Target::Extraction));
    interact(&mut game, C, 1, Some(Target::Gate(gate)));
    submit(
        &mut game,
        B,
        1,
        1,
        Input {
            transit: Some(landing),
            ..Input::default()
        },
    );
    let tick = game.step(&Combat::default()).unwrap();
    assert!(escaped(&tick, A, cell));
    assert!(has(
        &tick,
        Fact::TransitLanded {
            actor: B,
            destination: landing
        }
    ));
    assert!(has(
        &tick,
        Fact::TransitLanded {
            actor: rider,
            destination: arrival
        }
    ));
    assert!(has(
        &tick,
        Fact::GateChanged {
            actor: C,
            gate,
            open: true
        }
    ));

    let committed = [B, rider].map(|id| game.position(BodyId::Actor(id)).unwrap());
    let dropped = game.position(BodyId::Item(drop)).unwrap();
    let frame = game.history().frame(1).unwrap();
    // The escape is gone; the warp and the admission are at their committed poses.
    assert_eq!(
        frame.poses.keys().copied().collect::<Vec<_>>(),
        [C, B, rider]
    );
    let warped = frame.poses[&B];
    assert_eq!(warped, committed[0]);
    assert!((warped[0] - 600.0).abs() < 5.0);
    assert!((tick.solved.position(BodyId::Actor(B)).unwrap()[0] + 100.0).abs() < 1.0);
    assert_eq!(tick.solved.path(BodyId::Actor(rider)), None);
    assert_eq!(frame.poses[&rider], committed[1]);
    assert!((frame.poses[&rider][0] - 900.0).abs() < 5.0);
    // Only changes are recorded: the opened gate and the newly admitted body.
    assert_eq!(frame.gates, BTreeMap::from([(gate, true)]));
    assert_eq!(frame.gates_before, BTreeMap::from([(gate, false)]));
    assert_eq!(frame.items, BTreeMap::from([(drop, dropped)]));
    assert!(frame.items_before.is_empty());

    game.step(&Combat::default()).unwrap();
    let still = game.history().frame(2).unwrap();
    assert!(still.gates.is_empty() && still.items.is_empty());
    assert_eq!(still.poses[&B], warped);
}

#[test]
fn discovery_rotates_through_active_contestants_and_learns_gate_attempts_next_tick() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, C, 0.0);
    add_actor(&mut scenario, A, 100.0);
    add_actor(&mut scenario, D, 200.0);
    add_actor(&mut scenario, B, 140.0);
    let gate = locked_gate(&mut scenario, 120.0);
    let mut game = scenario.start(50, 20);
    let rules = Combat::default();
    interact(&mut game, A, 1, Some(Target::Gate(gate)));
    interact(&mut game, B, 1, Some(Target::Gate(gate)));
    let attempt = game.step(&rules).unwrap();
    assert!(has(
        &attempt,
        Fact::Rejected {
            actor: A,
            reason: Rejection::GateLocked(gate)
        }
    ));
    assert!(attempt.discovery.gates.is_empty());
    let learned = game.step(&rules).unwrap();
    // A contestant learns the lock on the following tick. The gladiator has no memory.
    assert_eq!(
        learned.discovery.gates,
        [GateObservation {
            actor: A,
            gate,
            open: false,
            locked: true
        }]
    );
    let memory = game.memory(A).unwrap();
    assert_eq!(
        memory.gates[&gate],
        DoorMemory {
            open: false,
            locked: true
        }
    );
    assert_eq!(memory.revision, 1);
    assert!(game.memory(B).is_none());
    let mut sampled = Vec::new();
    for _ in 3..=12 {
        let tick = game.step(&rules).unwrap();
        assert!(tick.discovery.gates.is_empty());
        for sample in &tick.discovery.samples {
            assert_eq!(Some(sample.eye), game.position(BodyId::Actor(sample.actor)));
            sampled.push((tick.tick, sample.actor));
        }
    }
    // Canonical contestant index i samples when (tick + i) is a multiple of the interval.
    assert_eq!(sampled, [(8, D), (9, A), (10, C)]);
}
