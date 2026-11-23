use super::{AmmoFamily, ItemId, Tick, WeaponKind};

pub const SLOT_COUNT: usize = 6;
const STACK_CAPACITY: u32 = 3;
const WEAPON_CAPACITY: [u32; 3] = [192, 360, 96];
const MAGAZINE_CAPACITY: [u32; 3] = [12, 30, 6];
const RESERVE_CAPACITY: [u32; 3] = [72, 120, 30];
const RELOAD_TICKS: [Tick; 3] = [20, 30, 30];

impl WeaponKind {
    pub fn family(self) -> AmmoFamily {
        match self {
            Self::Pistol => AmmoFamily::Pistol,
            Self::Rifle => AmmoFamily::Rifle,
            Self::Scattergun => AmmoFamily::Shell,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Utility {
    Medkit,
    Shield,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EquipmentKind {
    Firearm { kind: WeaponKind, rounds: u32 },
    Stack { kind: Utility, count: u32 },
    Cell { charge: u32 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Equipment {
    pub kind: EquipmentKind,
    /// Quality 1 is also the effective quality when content omits the field.
    pub quality: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CarriedItem {
    pub id: ItemId,
    pub lineage: ItemId,
    pub equipment: Equipment,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Loot {
    AccessKey,
    Equipment(Equipment),
    Ammo { family: AmmoFamily, count: u32 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Reload {
    pub slot: u8,
    pub item: ItemId,
    pub ready_at: Tick,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Inventory {
    pub slots: [Option<CarriedItem>; SLOT_COUNT],
    pub selected: u8,
    pub reserves: [u32; 3],
    pub keys: u32,
    pub reload: Option<Reload>,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct Transfer {
    pub count: u32,
    pub remaining: Option<Loot>,
    pub split_slots: Vec<usize>,
}

impl Transfer {
    fn whole(count: u32) -> Self {
        Self {
            count,
            remaining: None,
            split_slots: Vec::new(),
        }
    }

    fn partial(count: u32, remaining: Loot) -> Self {
        Self {
            remaining: Some(remaining),
            ..Self::whole(count)
        }
    }
}

impl Inventory {
    pub fn selected_item(&self) -> Option<CarriedItem> {
        self.item(self.selected)
    }

    pub(super) fn item(&self, slot: u8) -> Option<CarriedItem> {
        self.slots.get(usize::from(slot)).copied().flatten()
    }

    pub(super) fn selected_weapon(&self) -> Option<(WeaponKind, u32, u8)> {
        let item = self.selected_item()?;
        match item.equipment.kind {
            EquipmentKind::Firearm { kind, rounds } => Some((kind, rounds, item.equipment.quality)),
            _ => None,
        }
    }

    pub(super) fn spend_round(&mut self) {
        let item = self.slots[self.selected as usize]
            .as_mut()
            .expect("selected firearm");
        let EquipmentKind::Firearm { rounds, .. } = &mut item.equipment.kind else {
            unreachable!("firearm was validated");
        };
        *rounds -= 1;
    }

    pub(super) fn select(&mut self, slot: u8) -> bool {
        if usize::from(slot) >= SLOT_COUNT {
            return false;
        }
        self.selected = slot;
        self.cancel_changed_reload();
        true
    }

    pub(super) fn rearrange(&mut self, from: u8, to: u8) -> bool {
        let Some(mut source) = self.item(from) else {
            return false;
        };
        if from == to || usize::from(to) >= SLOT_COUNT {
            return false;
        }
        if let Some(target) = &mut self.slots[to as usize]
            && let Some((mut left, kind)) = matching_stacks(source.equipment, target.equipment)
        {
            let EquipmentKind::Stack { count, .. } = &mut target.equipment.kind else {
                unreachable!("matched stack");
            };
            let take = available(left, *count, STACK_CAPACITY);
            if take == 0 {
                return false;
            }
            *count += take;
            left -= take;
            source.equipment.kind = EquipmentKind::Stack { kind, count: left };
            self.slots[from as usize] = (left > 0).then_some(source);
            if left == 0 && self.selected == from {
                self.selected = to;
            }
        } else {
            self.slots.swap(from as usize, to as usize);
            self.selected = match self.selected {
                slot if slot == from => to,
                slot if slot == to => from,
                slot => slot,
            };
        }
        self.cancel_changed_reload();
        true
    }

    pub(super) fn remove(&mut self, slot: usize) {
        self.slots[slot] = None;
        self.cancel_changed_reload();
    }

    pub(super) fn use_utility(&mut self, slot: usize, kind: Utility, count: u32) {
        if count == 1 {
            self.remove(slot);
        } else {
            self.slots[slot]
                .as_mut()
                .expect("utility to spend")
                .equipment
                .kind = EquipmentKind::Stack {
                kind,
                count: count - 1,
            };
        }
    }

    fn cancel_changed_reload(&mut self) {
        if self.reload.is_some_and(|reload| {
            self.selected != reload.slot
                || self.selected_item().map(|item| item.id) != Some(reload.item)
        }) {
            self.reload = None;
        }
    }

    pub(super) fn complete_reload(
        &mut self,
        tick: Tick,
        stunned: bool,
    ) -> Option<(WeaponKind, u32)> {
        self.cancel_changed_reload();
        if stunned {
            self.reload = None;
        }
        let reload = self.reload.filter(|reload| tick >= reload.ready_at)?;
        self.reload = None;
        let item = self.slots[reload.slot as usize]
            .as_mut()
            .expect("validated reload");
        let EquipmentKind::Firearm { kind, rounds } = &mut item.equipment.kind else {
            return None;
        };
        let reserve = &mut self.reserves[kind.family() as usize];
        let take = available(*reserve, *rounds, MAGAZINE_CAPACITY[*kind as usize]);
        *reserve -= take;
        *rounds += take;
        Some((*kind, take))
    }

    pub(super) fn start_reload(
        &mut self,
        tick: Tick,
        stunned: bool,
        enabled: bool,
    ) -> Option<Reload> {
        let (kind, rounds, _) = self.selected_weapon()?;
        if !enabled
            || stunned
            || self.reload.is_some()
            || rounds >= MAGAZINE_CAPACITY[kind as usize]
            || self.reserves[kind.family() as usize] == 0
        {
            return None;
        }
        let reload = Reload {
            slot: self.selected,
            item: self.selected_item()?.id,
            ready_at: tick.saturating_add(RELOAD_TICKS[kind as usize]),
        };
        self.reload = Some(reload);
        Some(reload)
    }

    pub(super) fn has_cell(&self) -> bool {
        self.slots
            .iter()
            .flatten()
            .any(|item| matches!(item.equipment.kind, EquipmentKind::Cell { .. }))
    }

    pub(super) fn take(
        &mut self,
        id: ItemId,
        lineage: ItemId,
        loot: Loot,
        reloading: bool,
    ) -> Option<Transfer> {
        let equipment = match loot {
            Loot::AccessKey => {
                self.keys = self.keys.checked_add(1)?;
                return Some(Transfer::whole(1));
            }
            Loot::Ammo { family, count } => {
                let taken = self.take_reserve(family, count, reloading)?;
                return Some(if taken == count {
                    Transfer::whole(taken)
                } else {
                    Transfer::partial(
                        taken,
                        Loot::Ammo {
                            family,
                            count: count - taken,
                        },
                    )
                });
            }
            Loot::Equipment(equipment) => equipment,
        };
        if let EquipmentKind::Firearm { kind, rounds } = equipment.kind
            && let Some(existing) = self.slots.iter_mut().flatten().find(|item| {
                item.equipment.quality == equipment.quality
                    && matches!(item.equipment.kind, EquipmentKind::Firearm { kind: held, .. } if held == kind)
            })
        {
            let taken = if reloading {
                self.take_reserve(kind.family(), rounds, true)?
            } else {
                let EquipmentKind::Firearm { rounds: held, .. } = &mut existing.equipment.kind else {
                    unreachable!("matched firearm");
                };
                let take = available(rounds, *held, WEAPON_CAPACITY[kind as usize]);
                *held += take;
                take
            };
            return (taken > 0).then(|| {
                if taken == rounds {
                    Transfer::whole(taken)
                } else {
                    Transfer::partial(taken, Loot::Equipment(Equipment {
                        kind: EquipmentKind::Firearm { kind, rounds: rounds - taken },
                        ..equipment
                    }))
                }
            });
        }
        if let EquipmentKind::Stack { kind, count } = equipment.kind {
            if count == 0 {
                return None;
            }
            let mut remaining = count;
            for item in self.slots.iter_mut().flatten() {
                if matching_stacks(equipment, item.equipment).is_some()
                    && let EquipmentKind::Stack { count: held, .. } = &mut item.equipment.kind
                {
                    let take = available(remaining, *held, STACK_CAPACITY);
                    *held += take;
                    remaining -= take;
                }
            }
            if remaining == 0 {
                return Some(Transfer::whole(count));
            }
            let mut split_slots = Vec::new();
            while remaining > 0
                && let Some(slot) = self.slots.iter().position(Option::is_none)
            {
                let take = remaining.min(STACK_CAPACITY);
                self.insert(
                    slot,
                    id,
                    lineage,
                    Equipment {
                        kind: EquipmentKind::Stack { kind, count: take },
                        ..equipment
                    },
                );
                remaining -= take;
                if remaining > 0 {
                    split_slots.push(slot);
                }
            }
            let remaining_loot = if remaining == 0 {
                None
            } else {
                Some(Loot::Equipment(Equipment {
                    kind: EquipmentKind::Stack {
                        kind,
                        count: remaining,
                    },
                    ..equipment
                }))
            };
            return (remaining < count).then_some(Transfer {
                count: count - remaining,
                remaining: remaining_loot,
                split_slots,
            });
        }
        let slot = self.slots.iter().position(Option::is_none)?;
        self.insert(slot, id, lineage, equipment);
        Some(Transfer::whole(1))
    }

    fn insert(&mut self, slot: usize, id: ItemId, lineage: ItemId, equipment: Equipment) {
        let select = self.selected_item().is_none()
            || matches!(equipment.kind, EquipmentKind::Firearm { .. })
                && self.selected_weapon().is_none();
        self.slots[slot] = Some(CarriedItem {
            id,
            lineage,
            equipment,
        });
        if select {
            self.selected = slot as u8;
            self.cancel_changed_reload();
        }
    }

    fn take_reserve(&mut self, family: AmmoFamily, count: u32, enabled: bool) -> Option<u32> {
        let index = family as usize;
        let reserve = &mut self.reserves[index];
        let take = available(count, *reserve, RESERVE_CAPACITY[index]);
        if !enabled || take == 0 {
            return None;
        }
        *reserve += take;
        Some(take)
    }
}

fn matching_stacks(source: Equipment, target: Equipment) -> Option<(u32, Utility)> {
    match (source.kind, target.kind) {
        (EquipmentKind::Stack { kind, count }, EquipmentKind::Stack { kind: other, .. })
            if source.quality == target.quality && kind == other =>
        {
            Some((count, kind))
        }
        _ => None,
    }
}

fn available(incoming: u32, held: u32, capacity: u32) -> u32 {
    incoming.min(capacity.saturating_sub(held))
}
