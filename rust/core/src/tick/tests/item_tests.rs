use super::*;

fn add_actor(scenario: &mut Scenario, id: ActorId, x: f64) {
    scenario.state.actors.insert(id, actor(Presence::Active));
    scenario.body(BodyId::Actor(id), body(x));
}

fn equip(scenario: &mut Scenario, actor: ActorId, slot: usize, id: u32, kind: EquipmentKind) {
    let id = ItemId(id);
    scenario
        .state
        .actors
        .get_mut(&actor)
        .unwrap()
        .inventory
        .slots[slot] = Some(CarriedItem {
        id,
        lineage: id,
        equipment: Equipment { kind, quality: 1 },
    });
}

fn add_loot(scenario: &mut Scenario, id: ItemId, x: f64, loot: Loot) {
    scenario.state.items.insert(
        id,
        GroundItem {
            loot,
            unplaced_at: None,
            ..pending_item()
        },
    );
    let mut spec = body(x);
    spec.params.kind = crate::physics::KIND_PROP;
    spec.params.groups = crate::physics::LOOT_GROUP << 16 | 1;
    scenario.body(BodyId::Item(id), spec);
}

fn loot(kind: EquipmentKind) -> Loot {
    Loot::Equipment(Equipment { kind, quality: 1 })
}

fn stack(count: u32) -> EquipmentKind {
    EquipmentKind::Stack {
        kind: Utility::Medkit,
        count,
    }
}

fn pistol(rounds: u32) -> EquipmentKind {
    EquipmentKind::Firearm {
        kind: WeaponKind::Pistol,
        rounds,
    }
}

fn cell(charge: u32) -> EquipmentKind {
    EquipmentKind::Cell { charge }
}

fn nominate(game: &mut Match, actor: ActorId, item: ItemId) {
    submit(
        game,
        actor,
        1,
        1,
        Input {
            interact: true,
            target: Some(Target::Item(item)),
            ..Input::default()
        },
    );
}

fn has(tick: &CompletedTick, fact: Fact) -> bool {
    tick.changes.events.iter().any(|event| event.fact == fact)
}

#[test]
fn a_killed_claimant_cannot_take_loot_and_death_drops_enter_on_the_next_tick() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 25.0);
    add_actor(&mut scenario, C, 50.0);
    add_actor(&mut scenario, B, 0.0);
    let victim = scenario.state.actors.get_mut(&A).unwrap();
    victim.hp = 10.0;
    scenario.state.actors.get_mut(&B).unwrap().kit = Some(Kit::Warden);
    equip(&mut scenario, A, 0, 30, cell(80));
    let item = ItemId(17);
    add_loot(&mut scenario, item, 30.0, loot(pistol(5)));
    let mut game = scenario.start(50, 10);
    nominate(&mut game, A, item);
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
    let rules = Combat::default();
    let tick = game.step(&rules).unwrap();
    assert!(has(&tick, Fact::Eliminated { actor: A }));
    assert!(has(
        &tick,
        Fact::Pickup {
            actor: C,
            item,
            count: 1
        }
    ));
    assert!(
        !tick
            .changes
            .events
            .iter()
            .any(|event| matches!(event.fact, Fact::Pickup { actor: A, .. }))
    );
    assert!(has(
        &tick,
        Fact::Placed {
            source: Entity::Actor(A),
            placed: Entity::Item(ItemId(30))
        }
    ));
    assert_eq!(game.state().items[&ItemId(30)].loot, loot(cell(80)));
    assert_eq!(game.state().actors[&A].inventory.slots, [None; SLOT_COUNT]);
    assert!(game.position(BodyId::Item(ItemId(30))).is_some());
}

#[test]
fn a_nominated_claim_outranks_a_closer_automatic_pickup() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 29.0);
    add_actor(&mut scenario, C, 0.0);
    let item = ItemId(40);
    add_loot(&mut scenario, item, 7.0, loot(pistol(5)));
    let mut game = scenario.start(30, 10);
    nominate(&mut game, A, item);
    let tick = game.step(&Combat::default()).unwrap();
    assert!(has(
        &tick,
        Fact::Pickup {
            actor: A,
            item,
            count: 1
        }
    ));
    assert!(!has(
        &tick,
        Fact::Pickup {
            actor: C,
            item,
            count: 1
        }
    ));
    assert_eq!(
        game.state().actors[&A]
            .inventory
            .selected_item()
            .unwrap()
            .id,
        item
    );
    assert!(game.position(BodyId::Item(item)).is_none());
}

#[test]
fn nominations_use_rewound_item_reach_and_do_not_fall_through() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    let item = ItemId(20);
    let other = ItemId(21);
    add_loot(&mut scenario, item, 170.0, loot(pistol(5)));
    add_loot(&mut scenario, other, 110.0, loot(cell(12)));
    scenario.state.actors.get_mut(&A).unwrap().view_lag = 1;
    for time in 0..=1 {
        scenario.history.insert(
            time,
            RewindFrame {
                items: BTreeMap::from([(item, [20.0, 0.0]), (other, [9.0, 0.0])]),
                ..RewindFrame::default()
            },
        );
    }
    let mut game = scenario.start(30, 10);
    nominate(&mut game, A, ItemId(90));
    let rules = Combat::default();
    let rejected = game.step(&rules).unwrap();
    assert!(has(
        &rejected,
        Fact::Rejected {
            actor: A,
            reason: Rejection::Pickup(ItemId(90))
        }
    ));
    assert_eq!(game.state().items.len(), 2);
    submit(
        &mut game,
        A,
        2,
        2,
        Input {
            interact: true,
            target: Some(Target::Item(item)),
            ..Input::default()
        },
    );
    let tick = game.step(&rules).unwrap();
    assert!(has(
        &tick,
        Fact::Pickup {
            actor: A,
            item,
            count: 1
        }
    ));
    assert!(game.state().items.contains_key(&other));
}

#[test]
fn partial_stacks_fill_remaining_capacity_in_claim_order() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 20.0);
    add_actor(&mut scenario, C, 0.0);
    for (actor, start, count) in [(A, 100, 2), (C, 200, 1)] {
        equip(&mut scenario, actor, 0, start, stack(count));
        for slot in 1..SLOT_COUNT {
            equip(&mut scenario, actor, slot, start + slot as u32, cell(0));
        }
    }
    let item = ItemId(40);
    add_loot(&mut scenario, item, 24.0, loot(stack(5)));
    let mut game = scenario.start(30, 10);
    let tick = game.step(&Combat::default()).unwrap();
    assert!(has(
        &tick,
        Fact::Pickup {
            actor: A,
            item,
            count: 1
        }
    ));
    assert!(has(
        &tick,
        Fact::Pickup {
            actor: C,
            item,
            count: 2
        }
    ));
    assert_eq!(game.state().items[&item].loot, loot(stack(2)));
    assert!(game.position(BodyId::Item(item)).is_some());
}

#[test]
fn splitting_a_ground_stack_preserves_its_root_and_allocates_distinct_children() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    equip(&mut scenario, A, 5, 100, cell(0));
    let item = ItemId(40);
    add_loot(&mut scenario, item, 25.0, loot(stack(7)));
    let mut game = scenario.start(30, 10);
    let tick = game.step(&Combat::default()).unwrap();
    assert!(has(
        &tick,
        Fact::Pickup {
            actor: A,
            item,
            count: 7
        }
    ));
    let received = game.state().actors[&A].inventory.slots;
    for (slot, id, count) in [(0, ItemId(101), 3), (1, ItemId(102), 3), (2, item, 1)] {
        let stack = received[slot].unwrap();
        assert_eq!(
            (stack.id, stack.lineage, stack.equipment.kind),
            (id, item, self::stack(count))
        );
    }
    assert!(!game.state().items.contains_key(&item));
}

#[test]
fn duplicate_magazines_and_loose_ammo_fill_reserves_without_changing_loaded_rounds() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 20.0);
    add_actor(&mut scenario, C, 0.0);
    for (actor, item, reserve) in [(A, 50, 70), (C, 51, 67)] {
        equip(&mut scenario, actor, 0, item, pistol(2));
        scenario
            .state
            .actors
            .get_mut(&actor)
            .unwrap()
            .inventory
            .reserves[0] = reserve;
    }
    let weapon = ItemId(40);
    let ammo = ItemId(41);
    add_loot(&mut scenario, weapon, 24.0, loot(pistol(3)));
    add_loot(
        &mut scenario,
        ammo,
        -12.0,
        Loot::Ammo {
            family: AmmoFamily::Pistol,
            count: 7,
        },
    );
    let mut game = scenario.start(30, 10);
    let mut rules = Combat::default();
    rules.items.reloading = true;
    let tick = game.step(&rules).unwrap();
    for (actor, item, count) in [(A, weapon, 2), (C, ammo, 5)] {
        assert!(has(&tick, Fact::Pickup { actor, item, count }));
        let inventory = game.state().actors[&actor].inventory;
        assert_eq!(inventory.reserves[0], 72);
        assert_eq!(inventory.selected_weapon().unwrap().1, 2);
    }
    assert_eq!(game.state().items[&weapon].loot, loot(pistol(1)));
    assert_eq!(
        game.state().items[&ammo].loot,
        Loot::Ammo {
            family: AmmoFamily::Pistol,
            count: 2
        }
    );
}

#[test]
fn a_refused_swap_keeps_the_outgoing_stack_and_lets_the_next_claimant_take_the_item() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 20.0);
    add_actor(&mut scenario, C, 0.0);
    equip(&mut scenario, A, 0, 10, stack(3));
    for slot in 1..SLOT_COUNT {
        equip(&mut scenario, A, slot, 10 + slot as u32, cell(0));
    }
    let item = ItemId(40);
    add_loot(&mut scenario, item, 23.0, loot(pistol(5)));
    let mut game = scenario.start(30, 10);
    nominate(&mut game, A, item);
    let mut rules = Combat::default();
    rules.items.drops.ground_capacity = 1;
    let tick = game.step(&rules).unwrap();
    assert!(has(
        &tick,
        Fact::Rejected {
            actor: A,
            reason: Rejection::Swap(item)
        }
    ));
    assert!(has(
        &tick,
        Fact::Pickup {
            actor: C,
            item,
            count: 1
        }
    ));
    let outgoing = game.state().actors[&A].inventory.selected_item().unwrap();
    assert_eq!(
        (outgoing.id, outgoing.equipment.kind),
        (ItemId(10), stack(3))
    );
    assert!(game.state().items.is_empty());
}

#[test]
fn a_successful_swap_reuses_capacity_and_locks_out_only_the_dropper() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    add_actor(&mut scenario, C, 2.0);
    for slot in 0..SLOT_COUNT {
        equip(&mut scenario, A, slot, 10 + slot as u32, cell(80));
    }
    let item = ItemId(40);
    let outgoing = ItemId(10);
    add_loot(&mut scenario, item, 8.0, loot(pistol(5)));
    let mut game = scenario.start(30, 10);
    nominate(&mut game, A, item);
    let mut rules = Combat::default();
    rules.items.drops.ground_capacity = 1;
    rules.items.drops.body_capacity = 3;
    let tick = game.step(&rules).unwrap();
    assert!(has(
        &tick,
        Fact::Pickup {
            actor: A,
            item,
            count: 1
        }
    ));
    assert!(has(
        &tick,
        Fact::Placed {
            source: Entity::Actor(A),
            placed: Entity::Item(outgoing)
        }
    ));
    assert!(
        !tick
            .changes
            .events
            .iter()
            .any(|event| matches!(event.fact, Fact::Pickup { item, .. } if item == outgoing))
    );
    assert_eq!(game.state().items[&outgoing].pickup_ready_at, 21);
    let following = game.step(&rules).unwrap();
    assert!(has(
        &following,
        Fact::Pickup {
            actor: C,
            item: outgoing,
            count: 1
        }
    ));
}

#[test]
fn reload_completes_before_fire_and_matching_drops_win_over_new_reloads() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    equip(&mut scenario, A, 0, 10, pistol(0));
    equip(&mut scenario, A, 1, 11, cell(60));
    scenario
        .state
        .actors
        .get_mut(&A)
        .unwrap()
        .inventory
        .reserves = [4, 7, 0];
    let mut game = scenario.start(31, 30);
    let mut rules = Combat::default();
    rules.items.reloading = true;
    submit(
        &mut game,
        A,
        1,
        1,
        Input {
            reload: true,
            attack: true,
            slot: Some(1),
            drop_ammo: Some((AmmoFamily::Rifle, 5)),
            ..Input::default()
        },
    );
    let start = game.step(&rules).unwrap();
    assert!(has(
        &start,
        Fact::ReloadStarted {
            actor: A,
            ready_at: 21
        }
    ));
    assert!(has(
        &start,
        Fact::Rejected {
            actor: A,
            reason: Rejection::SelectSlot
        }
    ));
    assert_eq!(game.state().actors[&A].inventory.reserves, [4, 2, 0]);
    for _ in 2..20 {
        game.step(&rules).unwrap();
    }
    submit(
        &mut game,
        A,
        20,
        2,
        Input {
            attack: true,
            ..Input::default()
        },
    );
    let blocked = game.step(&rules).unwrap();
    assert!(!has(
        &blocked,
        Fact::ShotFired {
            actor: A,
            weapon: WeaponKind::Pistol
        }
    ));
    submit(
        &mut game,
        A,
        21,
        3,
        Input {
            attack: true,
            ..Input::default()
        },
    );
    let due = game.step(&rules).unwrap();
    assert!(has(
        &due,
        Fact::Reloaded {
            actor: A,
            weapon: WeaponKind::Pistol,
            rounds: 4
        }
    ));
    assert!(has(
        &due,
        Fact::ShotFired {
            actor: A,
            weapon: WeaponKind::Pistol
        }
    ));
    assert_eq!(
        game.state().actors[&A]
            .inventory
            .selected_weapon()
            .unwrap()
            .1,
        3
    );
    submit(
        &mut game,
        A,
        22,
        4,
        Input {
            reload: true,
            drop: Some(DropSlot::Selected),
            ..Input::default()
        },
    );
    let drop = game.step(&rules).unwrap();
    assert!(has(
        &drop,
        Fact::Rejected {
            actor: A,
            reason: Rejection::Reload
        }
    ));
    assert_eq!(game.state().items[&ItemId(10)].loot, loot(pistol(3)));

    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    equip(&mut scenario, A, 0, 10, pistol(0));
    scenario
        .state
        .actors
        .get_mut(&A)
        .unwrap()
        .inventory
        .reserves = [4, 0, 0];
    let mut game = scenario.start(31, 30);
    submit(
        &mut game,
        A,
        1,
        1,
        Input {
            reload: true,
            drop_ammo: Some((AmmoFamily::Pistol, 2)),
            ..Input::default()
        },
    );
    let drop = game.step(&rules).unwrap();
    assert!(has(
        &drop,
        Fact::Rejected {
            actor: A,
            reason: Rejection::Reload
        }
    ));
    let inventory = game.state().actors[&A].inventory;
    assert_eq!(inventory.reload, None);
    assert_eq!(inventory.reserves, [2, 0, 0]);
}

#[test]
fn a_swap_reserves_its_body_slot_before_a_due_arrival() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 0.0);
    for slot in 0..SLOT_COUNT {
        equip(&mut scenario, A, slot, 10 + slot as u32, cell(80));
    }
    let incoming = ItemId(40);
    add_loot(&mut scenario, incoming, 8.0, loot(pistol(5)));
    let destination = StationId(0);
    scenario.state.stations.insert(
        destination,
        Station {
            kind: StationKind::Transit,
            position: [400.0, 0.0],
        },
    );
    let mut rider = actor(Presence::Transit);
    rider.transit = Some(Transit {
        destination,
        origin: [200.0, 0.0],
        arrive_at: 1,
    });
    scenario.state.actors.insert(B, rider);
    scenario.body(BodyId::Actor(B), body(200.0));

    let mut game = scenario.start(30, 10);
    nominate(&mut game, A, incoming);
    let mut rules = Combat::default();
    rules.items.drops.body_capacity = 2;
    let tick = game.step(&rules).unwrap();
    assert!(has(
        &tick,
        Fact::Pickup {
            actor: A,
            item: incoming,
            count: 1
        }
    ));
    assert!(game.position(BodyId::Item(ItemId(10))).is_some());
    assert_eq!(game.state().actors[&B].presence, Presence::Transit);
    assert_eq!(game.position(BodyId::Actor(B)), None);
}

#[test]
fn mandatory_death_drops_keep_value_when_geometry_refuses_body_admission() {
    let mut scenario = Scenario::default();
    scenario.bounds([-5.0, -5.0], [5.0, 5.0]);
    add_actor(&mut scenario, A, 0.0);
    add_actor(&mut scenario, C, 10.0);
    add_actor(&mut scenario, B, -20.0);
    scenario.state.actors.get_mut(&B).unwrap().kit = Some(Kit::Warden);
    let victim = scenario.state.actors.get_mut(&A).unwrap();
    victim.hp = 6.0;
    victim.inventory.reserves = [5, 0, 0];
    equip(&mut scenario, A, 0, 20, cell(80));
    let mut game = scenario.start(21, 10);
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
    let mut rules = Combat::default();
    rules.items.reloading = true;
    rules.items.drops.ground_capacity = 0;
    rules.items.drops.body_capacity = 3; // One free slot cannot admit an overlapping fallback.
    let tick = game.step(&rules).unwrap();
    assert!(has(&tick, Fact::Eliminated { actor: A }));
    assert!(has(
        &tick,
        Fact::Placed {
            source: Entity::Actor(A),
            placed: Entity::Item(ItemId(20))
        }
    ));
    assert!(has(
        &tick,
        Fact::Placed {
            source: Entity::Actor(A),
            placed: Entity::Item(ItemId(21))
        }
    ));
    let items = &game.state().items;
    assert_eq!(items[&ItemId(20)].loot, loot(cell(80)));
    assert_eq!(
        items[&ItemId(21)].loot,
        Loot::Ammo {
            family: AmmoFamily::Pistol,
            count: 5
        }
    );
    assert!(
        items
            .values()
            .all(|item| item.unplaced_at == Some([0.0, 0.0]))
    );
    assert_eq!(game.state().actors[&A].inventory, Inventory::default());
    let next = game.step(&rules).unwrap();
    assert!(
        !next
            .changes
            .events
            .iter()
            .any(|event| matches!(event.fact, Fact::Pickup { .. }))
    );
    assert_eq!(game.state().items.len(), 2);
}

#[test]
fn a_utility_charge_is_spent_before_damage_and_heal_merge() {
    let mut scenario = Scenario::default();
    add_actor(&mut scenario, A, 20.0);
    add_actor(&mut scenario, B, 0.0);
    scenario.state.actors.get_mut(&A).unwrap().hp = 10.0;
    scenario.state.actors.get_mut(&B).unwrap().kit = Some(Kit::Warden);
    equip(&mut scenario, A, 0, 10, stack(1));
    let mut game = scenario.start(50, 10);
    for id in [A, B] {
        submit(
            &mut game,
            id,
            1,
            1,
            Input {
                attack: true,
                ..Input::default()
            },
        );
    }
    let tick = game.step(&Combat::default()).unwrap();
    assert!(has(
        &tick,
        Fact::UtilityUsed {
            actor: A,
            utility: Utility::Medkit
        }
    ));
    assert!(has(
        &tick,
        Fact::Hit {
            source: Entity::Actor(B),
            target: A
        }
    ));
    assert!(game.state().active(A));
    assert_eq!(game.state().actors[&A].hp, 26.0);
    assert!(game.state().actors[&A].inventory.selected_item().is_none());
}
