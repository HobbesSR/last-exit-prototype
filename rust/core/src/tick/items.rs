//! Inventory commands and item claims for the staged tick (27.2 R1, R3, R4 and R8).

use std::collections::BTreeSet;

use crate::math::hypot;
use crate::swept::Grid;

use super::placement::DropPlan;
use super::*;

const REACH: f64 = 45.0;
const OWNER_LOCKOUT: Tick = 20;
const UTILITY_COOLDOWN: Tick = 20;
const PICKUP_CONTEST: u64 = 0x7069_636b_0000_0000;

#[derive(Default)]
pub struct ItemRules {
    pub reloading: bool,
    pub quality_damage: bool,
    pub drops: DropTuning,
}

#[derive(Clone, Copy, Debug)]
pub enum ItemIntent {
    Utility { actor: ActorId, kind: Utility },
    Drop(DropRequest),
}

#[derive(Clone, Copy, Debug)]
enum DropSource {
    Slot { slot: u8, item: ItemId },
    Reserve { family: AmmoFamily, count: u32 },
}

#[derive(Clone, Copy, Debug)]
pub struct DropRequest {
    pub(super) owner: ActorId,
    source: DropSource,
    mandatory: bool,
}

impl DropRequest {
    pub(super) fn ordinal(self) -> u32 {
        match self.source {
            DropSource::Slot { slot, .. } => u32::from(slot) * 4,
            DropSource::Reserve { family, .. } => (SLOT_COUNT as u32 + family as u32) * 4,
        }
    }

    fn refusal(self) -> Rejection {
        match self.source {
            DropSource::Slot { .. } => Rejection::Drop,
            DropSource::Reserve { family, .. } => Rejection::DropAmmo(family),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ItemClaim {
    pub(super) item: ItemId,
    pub(super) distance: f64,
    explicit: bool,
    swap: Option<CarriedItem>,
}

fn reject(facts: &mut Vec<Fact>, actor: ActorId, reason: Rejection) {
    facts.push(Fact::Rejected { actor, reason });
}

impl ItemRules {
    pub(super) fn prepare(
        &self,
        view: &IntakeView<'_>,
        commands: &[Command],
        writes: &mut Intake,
    ) -> (Vec<ItemIntent>, BTreeSet<ActorId>) {
        let tick = view.start.tick;
        let mut intents = Vec::new();
        let mut attacks = BTreeSet::new();
        let mut commands = commands.iter().peekable();
        for (&id, actor) in &view.start.state.actors {
            let command = commands.next_if(|command| command.actor == id);
            if id.kind != ActorKind::Contestant || actor.presence != Presence::Active {
                continue;
            }
            let mut inventory = actor.inventory;
            let stunned = actor
                .statuses
                .get(&Status::Stun)
                .is_some_and(|window| window.contains(tick));
            if let Some((weapon, rounds)) = inventory.complete_reload(tick, stunned) {
                writes.facts.push(Fact::Reloaded {
                    actor: id,
                    weapon,
                    rounds,
                });
            }
            if let Some(command) = command {
                let attack = self.prepare_command(
                    command,
                    actor,
                    stunned,
                    &mut inventory,
                    &mut intents,
                    writes,
                );
                if attack {
                    attacks.insert(id);
                }
            }
            if inventory != actor.inventory {
                writes.inventories.insert(id, inventory);
            }
        }
        (intents, attacks)
    }

    fn prepare_command(
        &self,
        command: &Command,
        actor: &Actor,
        stunned: bool,
        inventory: &mut Inventory,
        intents: &mut Vec<ItemIntent>,
        writes: &mut Intake,
    ) -> bool {
        let Command {
            actor: id,
            tick,
            input,
            ..
        } = *command;
        let selected = inventory.selected;
        let drop_slot = input.drop.map(|drop| match drop {
            DropSlot::Selected => selected,
            DropSlot::Slot(slot) => slot,
        });
        if let Some(slot) = drop_slot {
            if let Some(item) = inventory.item(slot) {
                intents.push(ItemIntent::Drop(DropRequest {
                    owner: id,
                    source: DropSource::Slot {
                        slot,
                        item: item.id,
                    },
                    mandatory: false,
                }));
            } else {
                reject(&mut writes.facts, id, Rejection::Drop);
            }
        }
        if let Some((family, requested)) = input.drop_ammo {
            let count = requested.min(inventory.reserves[family as usize]);
            if self.reloading && count > 0 {
                intents.push(ItemIntent::Drop(DropRequest {
                    owner: id,
                    source: DropSource::Reserve { family, count },
                    mandatory: false,
                }));
            } else {
                reject(&mut writes.facts, id, Rejection::DropAmmo(family));
            }
        }
        let drops_selected = drop_slot == Some(selected);
        let drops_reload_family = input.drop_ammo.is_some_and(|(family, _)| {
            inventory
                .selected_weapon()
                .is_some_and(|(kind, _, _)| family == kind.family())
        });
        let reload_wins = input.reload && !drops_selected && !drops_reload_family;
        if input.reload {
            if reload_wins
                && let Some(reload) = inventory.start_reload(tick, stunned, self.reloading)
            {
                writes.facts.push(Fact::ReloadStarted {
                    actor: id,
                    ready_at: reload.ready_at,
                });
            } else {
                reject(&mut writes.facts, id, Rejection::Reload);
            }
        }

        let move_selected = input
            .move_slot
            .is_some_and(|(from, to)| from == selected || to == selected);
        let weapon_blocked = drops_selected || reload_wins;
        if let Some((from, to)) = input.move_slot
            && (move_selected && weapon_blocked
                || drop_slot.is_some_and(|slot| slot == from || slot == to)
                || !inventory.rearrange(from, to))
        {
            reject(&mut writes.facts, id, Rejection::MoveSlot);
        }
        if let Some(slot) = input.slot
            && (weapon_blocked || move_selected || !inventory.select(slot))
        {
            reject(&mut writes.facts, id, Rejection::SelectSlot);
        }
        if weapon_blocked
            || move_selected
            || input.slot.is_some()
            || tick < actor.deadlines.weapon_ready_at
            || inventory.reload.is_some()
        {
            return false;
        }
        let bot_utility = input
            .utility_slot
            .filter(|_| command.source == CommandSource::Bot);
        let utility_slot = bot_utility.or(input.attack.then_some(inventory.selected));
        if let Some(slot) = utility_slot
            && drop_slot != Some(slot)
            && let Some(item) = inventory.item(slot)
            && let EquipmentKind::Stack { kind, count } = item.equipment.kind
            && count > 0
            && match kind {
                Utility::Medkit => actor.hp < actor.max_hp,
                Utility::Shield => actor.shield < actor.max_shield,
            }
        {
            inventory.use_utility(slot as usize, kind, count);
            writes
                .weapon_ready_at
                .insert(id, tick.saturating_add(UTILITY_COOLDOWN));
            intents.push(ItemIntent::Utility { actor: id, kind });
            return false;
        }
        input.attack
    }

    pub fn resolve_into<C: From<ItemClaim>>(
        &self,
        view: &ResolveView<'_>,
        intents: impl Iterator<Item = ItemIntent>,
        effects: &mut Effects<C, DropRequest>,
    ) {
        for intent in intents {
            match intent {
                ItemIntent::Drop(request) => effects.placements.push(request),
                ItemIntent::Utility { actor, kind } => {
                    let effect = match kind {
                        Utility::Medkit => VitalEffect::Heal(40.0),
                        Utility::Shield => VitalEffect::Shield(30.0),
                    };
                    effects.vitals.push((actor, effect));
                    effects.facts.push(Fact::UtilityUsed {
                        actor,
                        utility: kind,
                    });
                }
            }
        }
        let items: Vec<_> = view
            .start
            .state
            .items
            .iter()
            .filter_map(|(&id, item)| {
                let position = item.position(view.solved.position(BodyId::Item(id)))?;
                Some((id, item, position))
            })
            .collect();
        let grid = Grid::for_bounds(
            items
                .iter()
                .map(|&(_, _, [x, y])| [x - REACH, y - REACH, 2.0 * REACH, 2.0 * REACH]),
        );
        for (&actor, record) in &view.start.state.actors {
            if actor.kind != ActorKind::Contestant || record.presence != Presence::Active {
                continue;
            }
            let Some(origin) = view.solved.position(BodyId::Actor(actor)) else {
                continue;
            };
            let current_view = view.current();
            let eligible = |item: &GroundItem, position: Point| {
                (item.dropped_by != Some(actor) || view.start.tick >= item.pickup_ready_at)
                    && !(record.bot
                        && record.inventory.has_cell()
                        && matches!(
                            item.loot,
                            Loot::Equipment(Equipment {
                                kind: EquipmentKind::Cell { .. },
                                ..
                            })
                        ))
                    && distance(origin, position) < REACH
            };
            for i in grid.at(origin[0], origin[1]) {
                let (id, item, position) = items[i as usize];
                if eligible(item, position) && current_view.reach_clear(origin, position) {
                    effects.claims.push((
                        actor,
                        ItemClaim {
                            item: id,
                            distance: distance(origin, position),
                            explicit: false,
                            swap: None,
                        }
                        .into(),
                    ));
                }
            }
        }
    }

    pub(super) fn explicit_candidates(
        &self,
        view: &ResolveView<'_>,
        rewind: &Rewound<'_>,
        actor: ActorId,
        origin: Point,
        nominated: Option<ItemId>,
    ) -> Vec<ItemClaim> {
        let Some(record) = view.start.state.actors.get(&actor) else {
            return Vec::new();
        };
        if actor.kind != ActorKind::Contestant || record.presence != Presence::Active {
            return Vec::new();
        }
        let full = record.inventory.slots.iter().all(Option::is_some);
        if nominated.is_none() && (!full || record.bot) {
            return Vec::new();
        }
        let items = &view.start.state.items;
        let candidates =
            items.range(nominated.unwrap_or(ItemId(0))..=nominated.unwrap_or(ItemId(u32::MAX)));
        candidates
            .filter_map(|(&id, item)| {
                if (item.dropped_by == Some(actor) && view.start.tick < item.pickup_ready_at)
                    || (record.bot
                        && record.inventory.has_cell()
                        && matches!(
                            item.loot,
                            Loot::Equipment(Equipment {
                                kind: EquipmentKind::Cell { .. },
                                ..
                            })
                        ))
                {
                    return None;
                }
                let current = item.position(view.solved.position(BodyId::Item(id)))?;
                let seen = rewind.item_position(id)?;
                if distance(origin, seen) >= REACH || !rewind.reach_clear(origin, seen) {
                    return None;
                }
                let mut draft = record.inventory;
                let fits = draft
                    .take(id, item.lineage.unwrap_or(id), item.loot, self.reloading)
                    .is_some();
                let swap = if full
                    && !record.bot
                    && matches!(item.loot, Loot::Equipment(_))
                    && self.swap_fits(record.inventory, id, *item)
                {
                    record.inventory.selected_item()
                } else {
                    None
                };
                // Unnominated interaction only offers the full-inventory swap tier.
                if (nominated.is_none() && swap.is_none())
                    || (nominated.is_some() && !fits && swap.is_none())
                {
                    return None;
                }
                Some(ItemClaim {
                    item: id,
                    distance: distance(origin, current),
                    explicit: true,
                    swap: if nominated.is_some() && fits {
                        None
                    } else {
                        swap
                    },
                })
            })
            .collect()
    }

    fn swap_fits(&self, mut draft: Inventory, id: ItemId, item: GroundItem) -> bool {
        draft.remove(draft.selected as usize);
        draft
            .take(id, item.lineage.unwrap_or(id), item.loot, self.reloading)
            .is_some_and(|transfer| transfer.remaining.is_none())
    }

    pub fn deaths(&self, view: View<'_>, deaths: &[Elimination], pending: &mut Vec<DropRequest>) {
        for death in deaths {
            let owner = death.actor;
            let inventory = &view.state.actors[&owner].inventory;
            for (slot, item) in inventory.slots.iter().enumerate() {
                if let Some(item) = item {
                    pending.push(DropRequest {
                        owner,
                        mandatory: true,
                        source: DropSource::Slot {
                            slot: slot as u8,
                            item: item.id,
                        },
                    });
                }
            }
            for family in [AmmoFamily::Pistol, AmmoFamily::Rifle, AmmoFamily::Shell] {
                let count = inventory.reserves[family as usize];
                if count > 0 {
                    pending.push(DropRequest {
                        owner,
                        mandatory: true,
                        source: DropSource::Reserve { family, count },
                    });
                }
            }
        }
    }

    pub fn settle_claims(
        &self,
        state: &mut State,
        view: ClaimView<'_>,
        mut claims: Vec<(ActorId, ItemClaim)>,
        placement: &mut Placement<DropRequest>,
        commit: &mut Commit,
    ) {
        let rank = |actor, claim: ItemClaim| {
            let key = PICKUP_CONTEST ^ u64::from(claim.item.0);
            (
                contest_score(view.seed, view.tick, key, actor_word(actor)),
                actor,
                claim.item,
            )
        };
        claims.sort_unstable_by(|&(a, left), &(b, right)| {
            right
                .explicit
                .cmp(&left.explicit)
                .then_with(|| left.distance.total_cmp(&right.distance))
                .then_with(|| rank(a, left).cmp(&rank(b, right)))
        });
        let mut awarded = BTreeSet::new();
        for (actor, claim) in claims {
            if awarded.contains(&(actor, claim.item)) {
                continue;
            }
            if self.award(state, view, actor, claim, &mut placement.reserved, commit) {
                awarded.insert((actor, claim.item));
            } else if claim.explicit {
                let reason = if claim.swap.is_some() {
                    Rejection::Swap(claim.item)
                } else {
                    Rejection::Pickup(claim.item)
                };
                reject(&mut commit.facts, actor, reason);
            }
        }
    }

    fn award(
        &self,
        state: &mut State,
        view: ClaimView<'_>,
        actor: ActorId,
        claim: ItemClaim,
        reserved: &mut BTreeMap<SpawnKey, Spawn>,
        commit: &mut Commit,
    ) -> bool {
        let Some(&item) = state.items.get(&claim.item) else {
            return false;
        };
        let mut draft = state.actors[&actor].inventory;
        if state.actors[&actor].bot
            && draft.has_cell()
            && matches!(
                item.loot,
                Loot::Equipment(Equipment {
                    kind: EquipmentKind::Cell { .. },
                    ..
                })
            )
        {
            return false;
        }
        let outgoing = claim.swap;
        let selected = draft.selected;
        if let Some(outgoing) = outgoing {
            if draft.selected_item() != Some(outgoing) {
                return false;
            }
            draft.remove(selected as usize);
        }
        let Some(transfer) = draft.take(
            claim.item,
            item.lineage.unwrap_or(claim.item),
            item.loot,
            self.reloading,
        ) else {
            return false;
        };
        if let Some(outgoing) = outgoing {
            let request = DropRequest {
                owner: actor,
                source: DropSource::Slot {
                    slot: selected,
                    item: outgoing.id,
                },
                mandatory: false,
            };
            if transfer.remaining.is_some()
                || !self.reserve_drop(state, view, request, Some(claim.item), reserved, commit)
            {
                return false;
            }
        }
        state.actors.get_mut(&actor).expect("claimant").inventory = draft;
        if let Some(remaining) = transfer.remaining {
            state
                .items
                .get_mut(&claim.item)
                .expect("partially picked up")
                .loot = remaining;
        } else {
            state.items.remove(&claim.item);
            commit.lifecycle.push(Lifecycle::RemoveItem(claim.item));
        }
        for slot in transfer.split_slots {
            let ordinal = u64::from(actor.seat) * SLOT_COUNT as u64 + slot as u64;
            reserved.insert(
                SpawnKey {
                    source: Entity::Item(claim.item),
                    ordinal,
                },
                Spawn::SplitItem { actor, slot },
            );
        }
        commit.facts.push(Fact::Pickup {
            actor,
            item: claim.item,
            count: transfer.count,
        });
        true
    }

    pub(super) fn place_drop(
        &self,
        state: &mut State,
        view: ClaimView<'_>,
        request: DropRequest,
        reserved: &mut BTreeMap<SpawnKey, Spawn>,
        commit: &mut Commit,
    ) {
        if !request.mandatory && !state.active(request.owner) {
            return;
        }
        if !self.reserve_drop(state, view, request, None, reserved, commit) {
            assert!(
                !request.mandatory,
                "a mandatory drop needs the actor's solved pose"
            );
            reject(&mut commit.facts, request.owner, request.refusal());
            return;
        }
        let inventory = &mut state
            .actors
            .get_mut(&request.owner)
            .expect("dropper")
            .inventory;
        match request.source {
            DropSource::Slot { slot, .. } => inventory.remove(slot as usize),
            DropSource::Reserve { family, count } => inventory.reserves[family as usize] -= count,
        }
    }

    fn reserve_drop(
        &self,
        state: &State,
        view: ClaimView<'_>,
        request: DropRequest,
        replacing: Option<ItemId>,
        reserved: &mut BTreeMap<SpawnKey, Spawn>,
        commit: &Commit,
    ) -> bool {
        let inventory = &state.actors[&request.owner].inventory;
        let (id, lineage, loot, copies) = match request.source {
            DropSource::Slot { slot, item } => {
                let Some(held) = inventory.item(slot).filter(|held| held.id == item) else {
                    return false;
                };
                let mut equipment = held.equipment;
                let copies = if let EquipmentKind::Stack { kind, count } = equipment.kind {
                    if !(1..=3).contains(&count) {
                        return false;
                    }
                    equipment.kind = EquipmentKind::Stack { kind, count: 1 };
                    count as usize
                } else {
                    1
                };
                (
                    Some(item),
                    Some(held.lineage),
                    Loot::Equipment(equipment),
                    copies,
                )
            }
            DropSource::Reserve { family, count } => {
                if inventory.reserves[family as usize] < count {
                    return false;
                }
                (None, None, Loot::Ammo { family, count }, 1)
            }
        };
        let ordinal = request.ordinal();
        let Some(spots) = self.drops.plan(DropPlan {
            state,
            view,
            reserved,
            commit,
            replacing,
            owner: request.owner,
            ordinal,
            copies,
            mandatory: request.mandatory,
        }) else {
            return false;
        };
        for (copy, spot) in spots.into_iter().enumerate() {
            let key = SpawnKey {
                source: Entity::Actor(request.owner),
                ordinal: u64::from(ordinal) + copy as u64,
            };
            let spawn = Spawn::Item {
                id: if copy == 0 { id } else { None },
                item: GroundItem {
                    loot,
                    lineage,
                    unplaced_at: spot.body.is_none().then_some(spot.position),
                    dropped_by: Some(request.owner),
                    pickup_ready_at: view.tick.saturating_add(OWNER_LOCKOUT),
                },
                body: spot.body,
            };
            assert!(
                reserved.insert(key, spawn).is_none(),
                "drop request already reserved"
            );
        }
        true
    }
}

fn distance(from: Point, to: Point) -> f64 {
    hypot(to[0] - from[0], to[1] - from[1])
}
