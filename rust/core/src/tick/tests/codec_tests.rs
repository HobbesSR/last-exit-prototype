//! 3d.1: the live adapter's word codec. Round trips pin the layout `tick/codec.rs` documents.

use std::collections::BTreeSet;

use super::codec::*;
use super::*;

fn encoded(write: impl FnOnce(&mut Vec<f64>)) -> Vec<f64> {
    let mut words = Vec::new();
    write(&mut words);
    words
}

fn bits(words: &[f64]) -> Vec<u64> {
    words.iter().map(|word| word.to_bits()).collect()
}

fn id(seat: u32) -> ActorId {
    ActorId {
        kind: ActorKind::Gladiator,
        seat,
    }
}

fn item(id: u32, loot: Loot) -> GroundItem {
    GroundItem {
        loot,
        lineage: Some(ItemId(id + 100)),
        unplaced_at: Some([1.5, -2.5]),
        dropped_by: Some(A),
        pickup_ready_at: 77,
    }
}

fn equipment(kind: EquipmentKind) -> Equipment {
    Equipment { kind, quality: 3 }
}

fn carried(id: u32, kind: EquipmentKind) -> Option<CarriedItem> {
    Some(CarriedItem {
        id: ItemId(id),
        lineage: ItemId(id + 1),
        equipment: equipment(kind),
    })
}

fn full_actor() -> Actor {
    let mut full = actor(Presence::Transit);
    full.kit = Some(Kit::Specter);
    full.level = 4;
    full.kills = 9;
    full.sneak = true;
    full.view_lag = 3;
    full.bot = true;
    full.inventory = Inventory {
        slots: [
            carried(
                1,
                EquipmentKind::Firearm {
                    kind: WeaponKind::Scattergun,
                    rounds: 5,
                },
            ),
            carried(
                3,
                EquipmentKind::Stack {
                    kind: Utility::Shield,
                    count: 2,
                },
            ),
            carried(5, EquipmentKind::Cell { charge: 40 }),
            None,
            carried(
                7,
                EquipmentKind::Stack {
                    kind: Utility::Medkit,
                    count: 1,
                },
            ),
            None,
        ],
        selected: 4,
        reserves: [10, 20, 30],
        keys: 2,
        reload: Some(Reload {
            slot: 0,
            item: ItemId(1),
            ready_at: 90,
        }),
    };
    full.charging = Some(Charging {
        station: StationId(2),
        cell: ItemId(5),
    });
    full.respawn_at = Some(500);
    full.transit = Some(Transit {
        destination: StationId(3),
        origin: [4.0, 5.0],
        arrive_at: 60,
    });
    full.aggression = Some(Aggression {
        source: id(8),
        expires_at: 200,
    });
    full.deadlines = Deadlines {
        skill_ready_at: 11,
        weapon_ready_at: 12,
        transit_ready_at: 13,
    };
    for (status, from) in [
        (Status::Boost, 1),
        (Status::Cloak, 2),
        (Status::Reveal, 3),
        (Status::Stun, 4),
    ] {
        full.statuses.insert(
            status,
            Window {
                active_from: from,
                expires_at: from + 10,
            },
        );
    }
    full
}

fn rich_state() -> State {
    let mut state = State::default();
    state.actors.insert(A, full_actor());
    state.actors.insert(id(8), actor(Presence::Pending));
    state.actors.insert(C, actor(Presence::Eliminated));
    state.items.insert(ItemId(1), item(1, Loot::AccessKey));
    state.items.insert(
        ItemId(2),
        item(
            2,
            Loot::Equipment(equipment(EquipmentKind::Firearm {
                kind: WeaponKind::Rifle,
                rounds: 30,
            })),
        ),
    );
    state.items.insert(
        ItemId(3),
        GroundItem {
            lineage: None,
            unplaced_at: None,
            dropped_by: None,
            ..item(
                3,
                Loot::Ammo {
                    family: AmmoFamily::Shell,
                    count: 12,
                },
            )
        },
    );
    state.projectiles.insert(
        ProjectileId(1),
        Projectile {
            source: Entity::Actor(A),
            position: [1.0, 2.0],
            velocity: [3.0, 4.0],
            damage: 6.5,
            active_from: 5,
            expires_at: 25,
        },
    );
    state.projectiles.insert(
        ProjectileId(2),
        Projectile {
            source: Entity::Trap(TrapId(2)),
            position: [0.0; 2],
            velocity: [0.0; 2],
            damage: 12.0,
            active_from: 1,
            expires_at: 2,
        },
    );
    state.hooks.insert(
        HookId(1),
        Hook {
            owner: A,
            phase: HookPhase::Flying {
                position: [1.0, 1.0],
                direction: [0.0, 1.0],
                travelled: 9.0,
            },
            expires_at: 40,
        },
    );
    state.hooks.insert(
        HookId(2),
        Hook {
            owner: id(8),
            phase: HookPhase::Pulling {
                target: A,
                length: 120.0,
            },
            expires_at: 41,
        },
    );
    state.gates.insert(
        GateId(0),
        Gate {
            open: true,
            locked: false,
            door: true,
            position: [10.0, 20.0],
        },
    );
    state.gates.insert(GateId(3), Gate::default());
    let trap = |kind| Trap {
        position: [7.0, 8.0],
        heading: 0.5,
        ready_at: 33,
        kind,
    };
    state
        .traps
        .insert(TrapId(1), trap(TrapKind::Mine { spent: true }));
    state
        .traps
        .insert(TrapId(2), trap(TrapKind::Turret { aiming: true }));
    state.traps.insert(
        TrapId(3),
        trap(TrapKind::Flame {
            offset: 17,
            warning: true,
            firing: false,
        }),
    );
    state.traps.insert(
        TrapId(4),
        trap(TrapKind::Spider {
            home: [3.0, 3.0],
            target: Some(A),
        }),
    );
    state.traps.insert(
        TrapId(5),
        trap(TrapKind::Spider {
            home: [3.0, 3.0],
            target: None,
        }),
    );
    for (n, kind) in [StationKind::Charging, StationKind::Transit]
        .into_iter()
        .enumerate()
    {
        state.stations.insert(
            StationId(n as u32),
            Station {
                kind,
                position: [n as f64, 1.0],
            },
        );
    }
    state.extraction = Some(Extraction {
        position: [50.0, 60.0],
        slots: 3,
    });
    state.sensors = vec![[1.0, 2.0], [3.0, 4.0]];
    state.hazard_x = 123.0;
    state
}

fn state_round_trip(state: &State) -> State {
    let words = encoded(|w| put_state(w, state));
    let mut reader = Reader::new(&words);
    let back = get_state(&mut reader).expect("a state decodes");
    assert!(reader.is_empty());
    back
}

#[test]
fn every_row_has_its_documented_stride() {
    let state = rich_state();
    let base = encoded(|w| put_state(w, &State::default())).len();
    // An empty state is seven empty sections, the extraction option, an empty sensor section
    // and the hazard wall's word.
    assert_eq!(base, 7 + EXTRACTION_WORDS + 1 + 1);
    let mut one = State::default();
    one.actors.insert(A, state.actors[&A].clone());
    assert_eq!(encoded(|w| put_state(w, &one)).len() - base, ACTOR_STRIDE);
    let size = |put: fn(&mut State)| {
        let mut one = State::default();
        put(&mut one);
        encoded(|w| put_state(w, &one)).len() - base
    };
    assert_eq!(
        size(|s| {
            s.items.insert(ItemId(1), pending_item());
        }),
        ITEM_STRIDE
    );
    for (name, stride, row) in [
        (
            "projectile",
            PROJECTILE_STRIDE,
            size(|s| {
                s.projectiles
                    .insert(ProjectileId(1), rich_state().projectiles[&ProjectileId(1)]);
            }),
        ),
        (
            "hook",
            HOOK_STRIDE,
            size(|s| {
                s.hooks.insert(HookId(2), rich_state().hooks[&HookId(2)]);
            }),
        ),
        (
            "gate",
            GATE_STRIDE,
            size(|s| {
                s.gates.insert(GateId(3), Gate::default());
            }),
        ),
        (
            "trap",
            TRAP_STRIDE,
            size(|s| {
                s.traps.insert(TrapId(4), rich_state().traps[&TrapId(4)]);
            }),
        ),
        (
            "station",
            STATION_STRIDE,
            size(|s| {
                s.stations
                    .insert(StationId(0), rich_state().stations[&StationId(0)]);
            }),
        ),
    ] {
        assert_eq!(row, stride, "{name}");
    }
}

#[test]
fn state_tables_round_trip_every_variant() {
    let state = rich_state();
    assert_eq!(state_round_trip(&state), state);
    let empty = State::default();
    assert_eq!(state_round_trip(&empty), empty);
}

#[test]
fn a_status_window_may_be_absent_per_status() {
    let mut state = State::default();
    let mut partial = actor(Presence::Active);
    partial.statuses.insert(
        Status::Cloak,
        Window {
            active_from: 4,
            expires_at: 9,
        },
    );
    state.actors.insert(A, partial);
    assert_eq!(state_round_trip(&state), state);
}

fn every_fact() -> Vec<Fact> {
    let spot = EventPoint::from([12.25, -8.5]);
    let mut facts = vec![
        Fact::Hit {
            source: Entity::Projectile(ProjectileId(4)),
            target: A,
        },
        Fact::Eliminated { actor: A },
        Fact::Respawned { actor: B },
        Fact::KillCredited {
            actor: A,
            target: B,
        },
        Fact::Assisted {
            actor: A,
            target: B,
        },
        Fact::KillRewarded { actor: B },
        Fact::Placed {
            source: Entity::Hook(HookId(1)),
            placed: Entity::Item(ItemId(9)),
        },
        Fact::Boosted { actor: B },
        Fact::ShotFired {
            actor: A,
            weapon: WeaponKind::Rifle,
        },
        Fact::ReloadStarted {
            actor: A,
            ready_at: 31,
        },
        Fact::Reloaded {
            actor: A,
            weapon: WeaponKind::Scattergun,
            rounds: 6,
        },
        Fact::Pickup {
            actor: A,
            item: ItemId(2),
            count: 3,
        },
        Fact::Escaped {
            actor: A,
            cell: ItemId(5),
        },
        Fact::ChargingStarted {
            actor: A,
            station: StationId(1),
        },
        Fact::ChargingStopped {
            actor: A,
            station: StationId(1),
        },
        Fact::CellCharged {
            actor: A,
            station: StationId(1),
        },
        Fact::GateChanged {
            actor: A,
            gate: GateId(2),
            open: true,
        },
        Fact::GateObserved {
            actor: A,
            gate: GateId(2),
            open: false,
            locked: true,
        },
        Fact::TransitDeparted {
            actor: A,
            destination: StationId(4),
        },
        Fact::TransitLanded {
            actor: A,
            destination: StationId(4),
        },
        Fact::UtilityUsed {
            actor: A,
            utility: Utility::Shield,
        },
        Fact::MeleeSwung { actor: B },
        Fact::WardenPulsed { actor: B },
        Fact::SpecterScanned { actor: B },
        Fact::HookFired { owner: B },
        Fact::HookAttached {
            owner: B,
            target: A,
        },
        Fact::MineExploded { trap: TrapId(1) },
        Fact::SpiderGrappled {
            trap: TrapId(4),
            target: A,
            at: spot,
        },
        Fact::Heard {
            listener: A,
            at: spot,
            until: 88,
        },
        Fact::Contact(Contact {
            substep: 3,
            a: BodyId::Actor(A),
            b: BodyId::Gate(GateId(1)),
            kind: ContactKind::Started,
        }),
        Fact::Contact(Contact {
            substep: 0,
            a: BodyId::Prop(2),
            b: BodyId::Geometry(7),
            kind: ContactKind::Stopped,
        }),
        Fact::Finished,
    ];
    for reason in [
        HookRelease::Cancelled,
        HookRelease::Expired,
        HookRelease::Obstructed,
        HookRelease::FriendlyContact,
        HookRelease::Range,
        HookRelease::Standoff,
        HookRelease::Separation,
        HookRelease::EndpointGone,
        HookRelease::Relocated,
    ] {
        facts.push(Fact::HookReleased { owner: B, reason });
    }
    for reason in [
        Rejection::SkillCooldown,
        Rejection::HookCapacity,
        Rejection::Drop,
        Rejection::DropAmmo(AmmoFamily::Rifle),
        Rejection::Reload,
        Rejection::SelectSlot,
        Rejection::MoveSlot,
        Rejection::Pickup(ItemId(4)),
        Rejection::Swap(ItemId(5)),
        Rejection::Interaction(None),
        Rejection::Interaction(Some(Target::Extraction)),
        Rejection::Interaction(Some(Target::Station(StationId(2)))),
        Rejection::Interaction(Some(Target::Gate(GateId(3)))),
        Rejection::Interaction(Some(Target::Item(ItemId(6)))),
        Rejection::GateLocked(GateId(1)),
        Rejection::GateOccupied(GateId(2)),
        Rejection::GateContested(GateId(3)),
        Rejection::Transit(StationId(2)),
    ] {
        facts.push(Fact::Rejected { actor: A, reason });
    }
    facts
}

#[test]
fn every_event_and_entity_round_trips() {
    let mut events: Vec<Event> = every_fact()
        .into_iter()
        .enumerate()
        .map(|(n, fact)| Event {
            id: n as u64,
            tick: 9,
            fact,
        })
        .collect();
    // Entity tags with no fact of their own.
    for (n, source) in [
        Entity::Prop(3),
        Entity::Geometry(4),
        Entity::Gate(GateId(5)),
        Entity::Station(StationId(6)),
        Entity::Match,
    ]
    .into_iter()
    .enumerate()
    {
        events.push(Event {
            id: 1000 + n as u64,
            tick: 9,
            fact: Fact::Placed {
                source,
                placed: Entity::Actor(id(n as u32)),
            },
        });
    }
    let changes = Changes {
        events: events.clone(),
        ..Changes::default()
    };
    let words = encoded(|w| put_changes(w, &changes));
    let empty = encoded(|w| put_changes(w, &Changes::default()));
    assert_eq!(words.len(), empty.len() + events.len() * EVENT_STRIDE);
    let back = get_changes(&mut Reader::new(&words)).unwrap();
    assert_eq!(back, changes);
}

#[test]
fn changes_round_trip_every_field() {
    let state = rich_state();
    let changes = Changes {
        actors: state.actors.clone(),
        items: state.items.clone(),
        projectiles: state.projectiles.clone(),
        hooks: state.hooks.clone(),
        gates: state.gates.clone(),
        traps: state.traps.clone(),
        extraction: state.extraction,
        hazard_x: Some(f64::NEG_INFINITY),
        removed: vec![
            Entity::Item(ItemId(1)),
            Entity::Projectile(ProjectileId(2)),
            Entity::Hook(HookId(3)),
        ],
        poses: BTreeMap::from([
            (BodyId::Actor(A), [1.0, 2.0]),
            (BodyId::Item(ItemId(4)), [3.0, 4.0]),
            (BodyId::Prop(5), [5.0, 6.0]),
        ]),
        events: every_fact()
            .into_iter()
            .map(|fact| Event {
                id: 1 << 40,
                tick: 3,
                fact,
            })
            .collect(),
    };
    let words = encoded(|w| put_changes(w, &changes));
    let mut reader = Reader::new(&words);
    assert_eq!(get_changes(&mut reader).unwrap(), changes);
    assert!(reader.is_empty());
    let none = Changes::default();
    let words = encoded(|w| put_changes(w, &none));
    assert_eq!(get_changes(&mut Reader::new(&words)).unwrap(), none);
}

#[test]
fn snapshots_round_trip() {
    let snapshot = Snapshot {
        tick: 12,
        state: rich_state(),
        poses: BTreeMap::from([(BodyId::Actor(A), [9.0, 8.0])]),
    };
    let words = encoded(|w| put_snapshot(w, &snapshot));
    assert_eq!(get_snapshot(&mut Reader::new(&words)).unwrap(), snapshot);
}

fn every_input() -> Vec<Input> {
    let full = Input {
        movement: [0.5, -1.0],
        aim: Some(1.25),
        sneak: true,
        attack: true,
        utility_slot: Some(2),
        skill: true,
        interact: true,
        target: Some(Target::Gate(GateId(4))),
        slot: Some(3),
        move_slot: Some((1, 5)),
        drop: Some(DropSlot::Slot(2)),
        reload: true,
        drop_ammo: Some((AmmoFamily::Shell, 7)),
        transit: Some(StationId(2)),
    };
    let mut inputs = vec![Input::default(), full];
    for target in [
        Target::Extraction,
        Target::Station(StationId(1)),
        Target::Item(ItemId(2)),
    ] {
        inputs.push(Input {
            target: Some(target),
            ..Input::default()
        });
    }
    inputs.push(Input {
        drop: Some(DropSlot::Selected),
        ..Input::default()
    });
    inputs
}

fn every_inbound() -> Vec<Inbound> {
    let mut inbound = Vec::new();
    for (n, input) in every_input().into_iter().enumerate() {
        for source in [CommandSource::Player, CommandSource::Bot] {
            inbound.push(Inbound::Command(Command {
                actor: A,
                source,
                tick: 5,
                seq: (1 << 40) + n as u64,
                input,
            }));
        }
    }
    inbound.extend([
        Inbound::Observation(Observation::ViewLag { actor: A, ticks: 4 }),
        Inbound::Observation(Observation::InputLead { actor: A, ticks: 2 }),
        Inbound::Observation(Observation::Join { actor: C }),
        Inbound::Observation(Observation::Leave { actor: C }),
        Inbound::Observation(Observation::Teleport {
            body: BodyId::Actor(A),
            to: [3.0, 4.0],
        }),
        Inbound::Carried(Carried::Impulse {
            body: BodyId::Item(ItemId(2)),
            impulse: [1.0, -1.0],
        }),
        Inbound::Carried(Carried::KillReward { actor: B }),
        Inbound::Carried(Carried::GateObserved {
            actor: A,
            gate: GateId(2),
            open: true,
            locked: false,
        }),
    ]);
    inbound
}

#[test]
fn inbound_rows_round_trip_at_one_stride() {
    for inbound in every_inbound() {
        let words = encoded(|w| put_inbound(w, &inbound));
        assert_eq!(words.len(), INBOUND_STRIDE);
        let mut reader = Reader::new(&words);
        assert_eq!(get_inbound(&mut reader).unwrap(), inbound);
        assert!(reader.is_empty());
    }
}

#[test]
fn discontinuities_discovery_memory_and_cues_round_trip() {
    for marker in [
        Discontinuity::Placed(BodyId::Actor(A)),
        Discontinuity::Warped(BodyId::Item(ItemId(1))),
        Discontinuity::Removed(BodyId::Prop(2)),
        Discontinuity::Removed(BodyId::Gate(GateId(3))),
        Discontinuity::Placed(BodyId::Geometry(4)),
    ] {
        let words = encoded(|w| put_discontinuity(w, marker));
        assert_eq!(words.len(), DISCONTINUITY_STRIDE);
        assert_eq!(get_discontinuity(&mut Reader::new(&words)), Ok(marker));
    }
    let discovery = Discovery {
        gates: vec![
            GateObservation {
                actor: A,
                gate: GateId(1),
                open: false,
                locked: true,
            },
            GateObservation {
                actor: C,
                gate: GateId(2),
                open: true,
                locked: false,
            },
        ],
        samples: vec![DiscoverySample {
            actor: A,
            eye: [10.0, 20.0],
        }],
    };
    let words = encoded(|w| put_discovery(w, &discovery));
    assert_eq!(get_discovery(&mut Reader::new(&words)).unwrap(), discovery);

    let memory = Memory {
        discovered: BTreeSet::from([1, 5, 9]),
        seen: BTreeSet::from([2]),
        surveyed: BTreeSet::new(),
        items: BTreeMap::from([(
            ItemId(3),
            RememberedItem {
                at: [4.0, 5.0],
                item: item(3, Loot::AccessKey),
            },
        )]),
        gates: BTreeMap::from([(
            GateId(1),
            DoorMemory {
                open: true,
                locked: false,
            },
        )]),
        revision: 12,
    };
    let words = encoded(|w| put_memory(w, Some(&memory)));
    assert_eq!(get_memory(&mut Reader::new(&words)).unwrap(), Some(memory));
    let words = encoded(|w| put_memory(w, None));
    assert_eq!(words, [0.0]);
    assert_eq!(get_memory(&mut Reader::new(&words)).unwrap(), None);

    let cues = vec![
        Cue {
            at: [1.0, 2.0],
            tick: 3,
            until: 9,
        },
        Cue {
            at: [5.0, 6.0],
            tick: 4,
            until: 10,
        },
    ];
    let words = encoded(|w| put_cues(w, &cues));
    assert_eq!(words.len(), 1 + 2 * CUE_STRIDE);
    assert_eq!(get_cues(&mut Reader::new(&words)).unwrap(), cues);
}

fn station(scenario: &mut Scenario, id: u32, kind: StationKind, x: f64) {
    scenario.state.stations.insert(
        StationId(id),
        Station {
            kind,
            position: [x, 0.0],
        },
    );
}

/// A scenario with a locked door, a rail, loot, an extraction and a held cell, which a few ticks
/// of commands and a teleport change in every table the codec carries.
fn busy_scenario() -> (Scenario, GateId) {
    let mut scenario = Scenario::default();
    for (id, x) in [(C, 0.0), (A, 100.0), (B, 140.0)] {
        scenario.state.actors.insert(id, actor(Presence::Active));
        scenario.body(BodyId::Actor(id), body(x));
    }
    let cell = ItemId(40);
    scenario.state.actors.get_mut(&A).unwrap().inventory.slots[0] =
        carried(cell.0, EquipmentKind::Cell { charge: 100 });
    let gate = GateId(0);
    scenario.state.gates.insert(
        gate,
        Gate {
            open: false,
            locked: true,
            door: true,
            position: [120.0, 0.0],
        },
    );
    let mut door = body(120.0);
    door.params.kind = crate::physics::KIND_STATIC;
    scenario.body(BodyId::Gate(gate), door);
    station(&mut scenario, 1, StationKind::Charging, 100.0);
    station(&mut scenario, 2, StationKind::Transit, 300.0);
    scenario.state.extraction = Some(Extraction {
        position: [0.0, 0.0],
        slots: 2,
    });
    scenario.state.items.insert(
        ItemId(5),
        GroundItem {
            unplaced_at: None,
            ..pending_item()
        },
    );
    let mut loot = body(900.0);
    loot.params.kind = crate::physics::KIND_PROP;
    loot.params.groups = crate::physics::LOOT_GROUP << 16 | 1;
    scenario.body(BodyId::Item(ItemId(5)), loot);
    scenario.state.sensors = vec![[50.0, 50.0]];
    (scenario, gate)
}

#[test]
fn a_richer_snapshot_decodes_as_setup_tables() {
    let (scenario, gate) = busy_scenario();
    let mut game = scenario.start(7, 30);
    let rules = Combat::default();
    submit(
        &mut game,
        A,
        1,
        1,
        Input {
            interact: true,
            target: Some(Target::Gate(gate)),
            movement: [50.0, 0.0],
            ..Input::default()
        },
    );
    for tick in 1..=4 {
        if tick == 2 {
            assert!(game.submit(
                tick,
                Inbound::Observation(Observation::Teleport {
                    body: BodyId::Actor(C),
                    to: [3.0, 4.0]
                })
            ));
        }
        game.step(&rules).unwrap();
    }
    let snapshot = game.snapshot();
    // The snapshot's tables are valid setup tables: the same decoder reads them.
    assert_eq!(state_round_trip(&snapshot.state), snapshot.state);
    let words = encoded(|w| put_snapshot(w, &snapshot));
    assert_eq!(get_snapshot(&mut Reader::new(&words)).unwrap(), snapshot);
    assert_eq!(snapshot.state.actors[&A].view_lag, 0);
    assert!(!snapshot.poses.is_empty());

    let setup = Setup {
        seed: 7,
        time_limit: 30,
        state: snapshot.state.clone(),
        bodies: Vec::new(),
        floor: [0.0; 4],
        hazard_areas: Vec::new(),
        wall: None,
        bounds: None,
        combat: Combat::default(),
    };
    assert_eq!(
        Setup::decode(&setup.encode()).unwrap().state,
        snapshot.state
    );
}

#[test]
fn a_stepped_tick_decodes_to_the_same_outputs() {
    let (scenario, gate) = busy_scenario();
    let mut game = scenario.start(50, 20);
    let rules = Combat::default();
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
    submit(
        &mut game,
        C,
        1,
        1,
        Input {
            movement: [10.0, 0.0],
            ..Input::default()
        },
    );
    assert!(game.submit(
        2,
        Inbound::Observation(Observation::Teleport {
            body: BodyId::Actor(C),
            to: [3.0, 4.0]
        })
    ));
    let (mut gates, mut samples, mut markers, mut events) = (0, 0, 0, 0);
    for _ in 0..12 {
        let tick = game.step(&rules).unwrap();
        let words = encoded(|w| put_completed(w, &tick));
        let mut reader = Reader::new(&words);
        let decoded = get_completed(&mut reader).unwrap();
        assert!(reader.is_empty());
        assert_eq!(decoded.tick, tick.tick);
        assert_eq!(decoded.inbound, tick.inbound);
        assert_eq!(decoded.changes, tick.changes);
        assert_eq!(decoded.discontinuities, tick.discontinuities);
        assert_eq!(decoded.discovery, tick.discovery);
        gates += tick.discovery.gates.len();
        samples += tick.discovery.samples.len();
        markers += tick.discontinuities.len();
        events += tick.changes.events.len();
    }
    // The run must have exercised each part, so the equalities above were not over empties.
    assert!(gates > 0 && samples > 0 && markers > 0 && events > 0);
}

fn surface(key: u32, priority: f64, drag: Option<f64>) -> MotorSurface {
    MotorSurface {
        id: format!("{key:010}"),
        priority,
        origin: [0.0, 0.0],
        size: [50.0, 50.0],
        speed: 0.5,
        traction: 0.25,
        braking: 0.75,
        drag,
    }
}

fn sample_setup() -> Setup {
    let mut spread = CombatRules {
        hearing: Some(Hearing {
            ranges: [100.0, 200.0, 300.0],
            ticks: 40,
            width: 960.0,
            height: 480.0,
        }),
        ..CombatRules::default()
    };
    spread.weapons[2].spread = vec![-0.1, 0.0, 0.1];
    let mut movement = Movement::default().with_surfaces(vec![
        surface(2, 1.0, None),
        surface(1, 1.0, Some(0.5)),
        surface(0, 5.0, Some(2.0)),
    ]);
    movement.boost_duration = 61;
    let combat = Combat {
        movement,
        rules: spread,
        items: ItemRules {
            reloading: true,
            quality_damage: true,
            drops: DropTuning {
                ground_capacity: 99,
                optional_body_capacity: 7,
                body_capacity: 9,
                drop_reserve: 2,
            },
        },
        interactions: InteractionRules {
            charge_ticks: 21,
            transit_base: 1.5,
            transit_per_unit: 0.25,
        },
        ..Combat::default()
    };
    let mut state = State::default();
    for id in [A, C] {
        state.actors.insert(id, actor(Presence::Active));
    }
    let mut hull = body(0.0);
    hull.shape = 2;
    hull.vertices = vec![0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0];
    let mut loot = body(5.0);
    loot.params.kind = crate::physics::KIND_PROP;
    loot.params.groups = crate::physics::LOOT_GROUP << 16 | 1;
    loot.params.damping = [f64::NAN, 0.5];
    Setup {
        seed: 0x0000_0001_8000_0002,
        time_limit: 25,
        state,
        bodies: vec![
            (BodyId::Actor(A), body(0.0)),
            (BodyId::Actor(C), body(200.0)),
            (BodyId::Geometry(1), hull),
            (BodyId::Item(ItemId(9)), loot),
        ],
        floor: [0.5, 0.25, 0.75, 0.125],
        hazard_areas: vec![[1.0, 2.0, 3.0, 4.0]],
        wall: Some((960.0, 5)),
        bounds: Some([0.0, 0.0, 1000.0, 500.0]),
        combat,
    }
}

#[test]
fn setup_round_trips_and_keeps_motor_surface_order() {
    let setup = sample_setup();
    let words = setup.encode();
    let back = Setup::decode(&words).expect("a setup decodes");
    // Combat has no equality, so the re-encoding must be bit identical.
    assert_eq!(bits(&back.encode()), bits(&words));
    assert_eq!(back.seed, 0x0000_0001_8000_0002);
    assert_eq!(back.state, setup.state);
    assert_eq!(back.bodies.len(), 4);
    // Priority 5 first, then the equal-priority pair by key.
    let ids: Vec<_> = back
        .combat
        .movement
        .surfaces()
        .iter()
        .map(|s| s.id.as_str())
        .collect();
    assert_eq!(ids, ["0000000000", "0000000001", "0000000002"]);
    assert_eq!(back.combat.rules.weapons[2].spread, [-0.1, 0.0, 0.1]);
    assert_eq!(back.wall, Some((960.0, 5)));
}

#[test]
fn a_decoded_setup_runs_through_the_live_match() {
    let mut live = LiveMatch::new(&sample_setup().encode(), Handles::default())
        .expect("a valid setup starts a match");
    let input = live.input(2 * INBOUND_STRIDE);
    let command = |seq| {
        Inbound::Command(Command {
            actor: A,
            source: CommandSource::Player,
            tick: 1,
            seq,
            input: Input {
                movement: [100.0, 0.0],
                ..Input::default()
            },
        })
    };
    let rows = encoded(|w| {
        put_inbound(w, &command(4));
        // A row with a bad tag is refused and the next row still lands.
        let mut bad = encoded(|w| put_inbound(w, &command(5)));
        bad[0] = 77.0;
        w.extend(bad);
    });
    input.copy_from_slice(&rows);
    assert_eq!(live.submit(1, 2), 1);
    assert_eq!(live.flags(), [1, 0]);
    assert!(live.step());
    let tick = get_completed(&mut Reader::new(live.output())).unwrap();
    assert_eq!(tick.tick, 1);
    assert_eq!(tick.inbound, [command(4)]);
    assert_eq!(live.acknowledged(actor_word(A) as f64), 4.0);
    assert_eq!(live.acknowledged(actor_word(C) as f64), -1.0);
    live.snapshot();
    let snapshot = get_snapshot(&mut Reader::new(live.output())).unwrap();
    assert_eq!(snapshot.tick, 1);
    assert!(snapshot.poses[&BodyId::Actor(A)][0] > 0.0);
    live.memory(actor_word(A) as f64);
    assert_eq!(
        get_memory(&mut Reader::new(live.output())),
        Ok(Some(Memory::default()))
    );
    live.memory(actor_word(B) as f64);
    assert_eq!(live.output(), [0.0]);
    live.heard(actor_word(A) as f64);
    assert_eq!(live.output(), [0.0]);
    for _ in 1..25 {
        assert!(live.step());
    }
    assert!(!live.step());
    assert!(live.output().is_empty());
}

#[test]
fn malformed_setup_is_an_error_and_never_a_panic() {
    let words = sample_setup().encode();
    for len in 0..words.len() {
        assert!(Setup::decode(&words[..len]).is_err(), "prefix {len}");
    }
    let mut longer = words.clone();
    longer.push(0.0);
    assert!(Setup::decode(&longer).is_err());
    // Every word, replaced by values no field accepts, decodes or fails but never panics. A bad
    // tag or count must be an error.
    for at in 0..words.len() {
        for bad in [f64::NAN, -1.0, 0.5, 99.0, 1e300, f64::INFINITY] {
            let mut mutated = words.clone();
            mutated[at] = bad;
            let _ = Setup::decode(&mutated);
        }
    }
    let mut tag = words.clone();
    // The first actor's presence word: after the header (3), the count (1) and its actor word.
    tag[5] = 9.0;
    assert_eq!(
        Setup::decode(&tag).err().map(|e| e.what),
        Some("unknown tag")
    );
    let mut count = words.clone();
    count[3] = 1e6;
    assert!(Setup::decode(&count).is_err());
    assert!(Setup::decode(&[]).is_err());
}

/// A NaN or an infinity in any word either fails to decode or is dropped as padding: whatever
/// decodes re-encodes to finite words. The one exception is the state's last word, `hazard_x`,
/// whose negative infinity means no wall.
#[test]
fn non_finite_words_never_decode_into_a_value() {
    type Decode = fn(&[f64]) -> Option<Vec<f64>>;
    let state = encoded(|w| put_state(w, &sample_setup().state));
    let decode_state: Decode = |words| {
        let state = get_state(&mut Reader::new(words)).ok()?;
        Some(encoded(|w| put_state(w, &state)))
    };
    let decode_inbound: Decode = |words| {
        let inbound = get_inbound(&mut Reader::new(words)).ok()?;
        Some(encoded(|w| put_inbound(w, &inbound)))
    };
    let mut rows = vec![(state, decode_state, true)];
    rows.extend(
        every_inbound()
            .iter()
            .map(|inbound| (encoded(|w| put_inbound(w, inbound)), decode_inbound, false)),
    );
    for (words, decode, wall_last) in rows {
        for at in 0..words.len() {
            for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut mutated = words.clone();
                mutated[at] = bad;
                let Some(again) = decode(&mutated) else {
                    continue;
                };
                let last = again.len() - 1;
                for (i, word) in again.iter().enumerate() {
                    assert!(
                        word.is_finite() || wall_last && i == last && *word == f64::NEG_INFINITY,
                        "word {at} as {bad} decoded into word {i} = {word}"
                    );
                }
            }
        }
    }
}
