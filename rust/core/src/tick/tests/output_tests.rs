//! 3c: what a completed tick sends out (27.2 Boundary). Every scenario in a test build also folds
//! each change list into the first snapshot and compares it with the match (`Match::step`).

use super::*;

fn add_actor(scenario: &mut Scenario, id: ActorId, x: f64) {
    scenario.state.actors.insert(id, actor(Presence::Active));
    scenario.body(BodyId::Actor(id), body(x));
}

fn add_loot(scenario: &mut Scenario, id: ItemId, x: f64) {
    scenario.state.items.insert(
        id,
        GroundItem {
            unplaced_at: None,
            ..pending_item()
        },
    );
    let mut spec = body(x);
    spec.params.kind = crate::physics::KIND_PROP;
    spec.params.groups = crate::physics::LOOT_GROUP << 16 | 1;
    scenario.body(BodyId::Item(id), spec);
}

fn observe(game: &mut Match, tick: Tick, observation: Observation) {
    assert!(game.submit(tick, Inbound::Observation(observation)));
}

#[test]
fn the_change_list_carries_only_what_changed_and_escapes_are_removals() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 10.0);
    add_actor(&mut scenario, C, 300.0);
    add_loot(&mut scenario, ItemId(5), 900.0);
    let cell = ItemId(10);
    scenario.state.actors.get_mut(&A).unwrap().inventory.slots[0] = Some(CarriedItem {
        id: cell,
        lineage: cell,
        equipment: Equipment {
            kind: EquipmentKind::Cell { charge: 100 },
            quality: 1,
        },
    });
    scenario.state.extraction = Some(Extraction {
        position: [0.0, 0.0],
        slots: 2,
    });
    let mut game = scenario.start(50, 10);
    let rules = Combat::default();
    submit(
        &mut game,
        C,
        1,
        1,
        Input {
            movement: [100.0, 0.0],
            ..Input::default()
        },
    );
    let moved = game.step(&rules).unwrap();
    // C's record is unchanged by moving; only its committed pose is listed.
    assert!(moved.changes.actors.is_empty());
    assert!(moved.changes.items.is_empty() && moved.changes.removed.is_empty());
    assert_eq!(
        moved.changes.poses.keys().copied().collect::<Vec<_>>(),
        [BodyId::Actor(C)]
    );
    assert!(moved.discontinuities.is_empty());

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
    let escape = game.step(&rules).unwrap();
    assert!(
        escape
            .changes
            .events
            .iter()
            .any(|event| event.fact == Fact::Escaped { actor: A, cell })
    );
    assert_eq!(escape.changes.actors[&A].presence, Presence::Escaped);
    assert_eq!(escape.changes.extraction.unwrap().slots, 1);
    assert_eq!(
        escape.discontinuities,
        [Discontinuity::Removed(BodyId::Actor(A))]
    );
    // The untouched ground item is in the snapshot but never in a change list.
    assert!(game.snapshot().state.items.contains_key(&ItemId(5)));
}

#[test]
fn death_drops_are_placed_and_the_dead_are_removed() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 25.0);
    add_actor(&mut scenario, C, 300.0);
    add_actor(&mut scenario, B, 0.0);
    scenario.state.actors.get_mut(&A).unwrap().hp = 10.0;
    scenario.state.actors.get_mut(&B).unwrap().kit = Some(Kit::Warden);
    let dropped = ItemId(30);
    scenario.state.actors.get_mut(&A).unwrap().inventory.slots[0] = Some(CarriedItem {
        id: dropped,
        lineage: dropped,
        equipment: Equipment {
            kind: EquipmentKind::Cell { charge: 80 },
            quality: 1,
        },
    });
    let mut game = scenario.start(50, 10);
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
    assert_eq!(
        tick.discontinuities,
        [
            Discontinuity::Placed(BodyId::Item(dropped)),
            Discontinuity::Removed(BodyId::Actor(A)),
        ]
    );
    assert!(tick.changes.items.contains_key(&dropped));
    assert!(tick.changes.poses.contains_key(&BodyId::Item(dropped)));
}

#[test]
fn observations_are_recorded_inbound_and_written_at_intake() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 10.0);
    add_actor(&mut scenario, C, 300.0);
    let mut game = scenario.start(50, 10);
    observe(&mut game, 1, Observation::ViewLag { actor: A, ticks: 3 });
    observe(&mut game, 1, Observation::InputLead { actor: A, ticks: 2 });
    observe(&mut game, 1, Observation::Leave { actor: C });
    observe(
        &mut game,
        1,
        Observation::Teleport {
            body: BodyId::Actor(C),
            to: [500.0, 40.0],
        },
    );
    let tick = game.step(&Combat::default()).unwrap();
    // The recording frame keeps every observation in arrival order, as a command.
    let observed: Vec<_> = tick
        .inbound
        .iter()
        .filter(|entry| matches!(entry, Inbound::Observation(_)))
        .collect();
    assert_eq!(observed.len(), 4);
    assert_eq!(tick.changes.actors[&A].view_lag, 3);
    assert!(tick.changes.actors[&C].bot);
    assert_eq!(
        tick.discontinuities,
        [Discontinuity::Warped(BodyId::Actor(C))]
    );
    assert_eq!(tick.changes.poses[&BodyId::Actor(C)], [500.0, 40.0]);

    // The bot spent a high sequence; a connection taking the seat back numbers from the start.
    super::submit(&mut game, C, 2, 90, Input::default());
    game.step(&Combat::default()).unwrap();
    assert_eq!(game.acknowledged(C), Some(90));
    observe(&mut game, 3, Observation::Join { actor: C });
    super::submit(&mut game, C, 3, 0, Input::default());
    let joined = game.step(&Combat::default()).unwrap();
    assert!(!joined.changes.actors[&C].bot);
    assert_eq!(game.acknowledged(C), Some(0));
}

fn discovery_scenario(scenario: &mut Scenario, gate_box: [f64; 4]) {
    let empty_grid = [0, 0, 0, 0, 0];
    let [x, y, w, h] = gate_box;
    let edges = [
        x,
        y,
        x + w,
        y,
        x + w,
        y,
        x + w,
        y + h,
        x + w,
        y + h,
        x,
        y + h,
        x,
        y + h,
        x,
        y,
    ];
    let (cols, rows) = (20, 10);
    let map = crate::discovery::DiscoveryMap::new(
        &[cols as f64, rows as f64, 192.0, 1200.0, 800.0, 4000.0],
        &vec![1; cols * rows],
        &[],
        &[],
        &[],
    );
    scenario.discovery(
        map,
        crate::sight::SightIndex::new(&[], &empty_grid, &[], &[0], &empty_grid),
        crate::sight::GateSet::new(&edges, &[0, 4], &gate_box, &empty_grid),
    );
    scenario.state.gates.insert(
        GateId(0),
        Gate {
            open: false,
            locked: true,
            door: true,
            position: [x + w / 2.0, y + h / 2.0],
        },
    );
}

#[test]
fn humans_learn_the_view_window_and_bots_also_remember_what_they_see() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, C, 100.0);
    add_actor(&mut scenario, A, 2000.0);
    scenario.state.actors.get_mut(&C).unwrap().bot = true;
    let item = ItemId(7);
    add_loot(&mut scenario, item, 400.0);
    discovery_scenario(&mut scenario, [600.0, -20.0, 10.0, 40.0]);
    let mut game = scenario.start(50, 30);
    let rules = Combat::default();
    for _ in 1..9 {
        game.step(&rules).unwrap();
    }
    assert_eq!(game.memory(A), Some(&Memory::default()));
    // A, canonical index 1, samples at tick 9: the view window's geometry only.
    game.step(&rules).unwrap();
    let human = game.memory(A).unwrap();
    assert!(human.discovered.contains(&(2000 / 192)));
    assert!(human.seen.is_empty() && human.items.is_empty() && human.gates.is_empty());
    assert_eq!(human.revision, 1);

    // C, a bot at canonical index 0, samples at tick 10 with line of sight.
    game.step(&rules).unwrap();
    let bot = game.memory(C).unwrap();
    assert!(bot.discovered.contains(&0) && bot.seen.contains(&0) && bot.surveyed.contains(&0));
    assert_eq!(bot.items[&item].item.loot, game.state().items[&item].loot);
    assert_eq!(
        bot.gates[&GateId(0)],
        DoorMemory {
            open: false,
            locked: true
        }
    );

    // Once the item is gone, the next sample sees its spot empty and forgets it.
    observe(
        &mut game,
        11,
        Observation::Teleport {
            body: BodyId::Item(item),
            to: [4000.0, 0.0],
        },
    );
    while game.step(&rules).unwrap().tick < 20 {}
    let bot = game.memory(C).unwrap();
    assert!(!bot.items.contains_key(&item));
}

#[test]
fn a_shot_is_heard_in_its_tick_events_and_reaches_listeners_after_it() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 100.0);
    add_actor(&mut scenario, C, 400.0);
    add_actor(&mut scenario, B, 5000.0);
    let pistol = ItemId(3);
    scenario.state.actors.get_mut(&A).unwrap().inventory.slots[0] = Some(CarriedItem {
        id: pistol,
        lineage: pistol,
        equipment: Equipment {
            kind: EquipmentKind::Firearm {
                kind: WeaponKind::Pistol,
                rounds: 5,
            },
            quality: 1,
        },
    });
    let mut game = scenario.start(50, 60);
    let mut rules = Combat::default();
    rules.rules.hearing = Some(Hearing {
        ranges: [1000.0; 3],
        ticks: 40,
        width: 8000.0,
        height: 2000.0,
    });
    let shoot = |game: &mut Match, tick| {
        submit(
            game,
            A,
            tick,
            u64::from(tick),
            Input {
                attack: true,
                aim: Some(-std::f64::consts::FRAC_PI_2),
                ..Input::default()
            },
        );
    };
    shoot(&mut game, 1);
    assert!(
        game.heard(C).is_empty(),
        "nothing is heard before the shot's tick"
    );
    let shot = game.step(&rules).unwrap();
    let heard: Vec<_> = shot
        .changes
        .events
        .iter()
        .filter_map(|event| match event.fact {
            Fact::Heard {
                listener,
                at,
                until,
            } => Some((listener, at.position(), until)),
            _ => None,
        })
        .collect();
    // The shooter's cell centre, to the one listener in range; not the shooter or the far gladiator.
    assert_eq!(heard, [(C, [96.0, 96.0], 41)]);
    let cue = Cue {
        at: [96.0, 96.0],
        tick: 1,
        until: 41,
    };
    assert_eq!(game.heard(C), [cue]);
    assert!(game.heard(B).is_empty());

    // A repeat from the same cell refreshes the one cue.
    let ready = game.state().actors[&A].deadlines.weapon_ready_at;
    while game.step(&rules).unwrap().tick + 1 < ready {}
    shoot(&mut game, ready);
    game.step(&rules).unwrap();
    assert_eq!(
        game.heard(C),
        [Cue {
            tick: ready,
            until: ready + 40,
            ..cue
        }]
    );
    while game.step(&rules).unwrap().tick < ready + 40 {}
    assert!(game.heard(C).is_empty(), "the cue fades");
}
