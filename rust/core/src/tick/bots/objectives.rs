use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Goal {
    Cell(u32),
    Item(ItemId),
}

#[derive(Default)]
pub(super) struct Pursuit {
    cell: Option<u32>,
    entered: Option<Tick>,
    abandoned: BTreeSet<u32>,
    ignored: BTreeMap<ItemId, Tick>,
    goal: Option<Goal>,
    closest: f64,
    progressed: Tick,
    seen: BTreeSet<u32>,
    seen_count: usize,
    frontier: Vec<u32>,
}

impl Pursuit {
    pub fn abandon(&mut self) {
        if let Some(cell) = self.cell.take() {
            self.abandoned.insert(cell);
        }
    }

    pub fn ignore(&mut self, item: ItemId, tick: Tick) {
        self.ignored.insert(item, tick.saturating_add(600));
    }

    fn stalled(&mut self, tick: Tick, goal: Goal, d: f64) -> bool {
        if self.goal == Some(goal) && d >= self.closest - 16.0 {
            return tick - self.progressed > 120;
        }
        self.goal = Some(goal);
        self.closest = d;
        self.progressed = tick;
        false
    }

    pub fn track_item(&mut self, tick: Tick, pos: Point, item: Option<(ItemId, Point)>) -> bool {
        self.cell = None;
        if let Some((item, at)) = item {
            if item.0 != 0 && self.stalled(tick, Goal::Item(item), distance(pos, at)) {
                self.ignore(item, tick);
                return true;
            }
        } else {
            self.goal = None;
        }
        false
    }

    fn refresh_frontier(&mut self, known: &[u32], cols: usize, rows: usize) {
        for &cell in &known[self.seen_count..] {
            if !self.seen.insert(cell) {
                continue;
            }
            self.frontier.retain(|&candidate| candidate != cell);
            let (col, row) = (cell as usize % cols, cell as usize / cols);
            let neighbors = [
                (col + 1 < cols).then_some(cell + 1),
                (row + 1 < rows).then_some(cell + cols as u32),
                (row > 0).then(|| cell - cols as u32),
                (col > 0).then(|| cell - 1),
            ];
            for next in neighbors.into_iter().flatten() {
                if !self.seen.contains(&next) && !self.frontier.contains(&next) {
                    self.frontier.push(next);
                }
            }
        }
        self.seen_count = known.len();
    }

    fn explore(
        &mut self,
        ctx: &Context<'_>,
        collision: Option<&CollisionMap>,
        memory: &Memory,
        pos: Point,
        avoid: &[Cue],
    ) -> Option<Point> {
        let tick = ctx.view.tick;
        let ground = |cell: u32, [x, y]: Point| {
            !memory.surveyed.contains(&cell) || collision.is_none_or(|map| map.inside(x, y, 0.0))
        };
        let loud = |at| avoid.iter().any(|cue| distance(cue.at, at) < 900.0);
        if self.cell.is_some_and(|cell| loud(ctx.centre(cell))) {
            self.cell = None;
        }
        if let Some(cell) = self.cell {
            let at = ctx.centre(cell);
            let settled =
                memory.seen.contains(&cell) || at[0] <= ctx.wall() + 300.0 || !ground(cell, at);
            let inside = ctx.cell_at(pos) == Some(cell);
            let arrived = if inside {
                tick - *self.entered.get_or_insert(tick) > DISCOVERY_INTERVAL
            } else {
                self.entered = None;
                false
            };
            if !settled && !arrived && !self.stalled(tick, Goal::Cell(cell), distance(pos, at)) {
                return Some(at);
            }
            if !memory.seen.contains(&cell) {
                self.abandoned.insert(cell);
            }
            self.cell = None;
        }
        let crate::navigation::Grid { cols, rows, .. } = ctx.grid();
        if cols == 0 || rows == 0 {
            return None;
        }
        self.refresh_frontier(&memory.seen_order, cols, rows);
        let best = self
            .frontier
            .iter()
            .filter_map(|&cell| {
                let at = ctx.centre(cell);
                (!self.abandoned.contains(&cell)
                    && at[0] > ctx.wall() + 300.0
                    && ground(cell, at)
                    && !loud(at))
                .then(|| (cell, at, distance(pos, at) - (at[0] - pos[0]) * 0.5))
            })
            .min_by(|a, b| a.2.total_cmp(&b.2))?;
        self.cell = Some(best.0);
        self.entered = None;
        Some(best.1)
    }
}

pub(super) struct EquipmentIntent {
    pub input: Input,
    pub cell: Option<u32>,
    inventory: Inventory,
    selected: Option<u8>,
    hp: f64,
}

impl EquipmentIntent {
    pub fn new(ctx: &Context<'_>, id: ActorId, has_inventory: bool) -> Self {
        let actor = &ctx.view.state.actors[&id];
        let tick = ctx.view.tick;
        let mut view = Self {
            input: Input::default(),
            cell: None,
            inventory: actor.inventory,
            selected: None,
            hp: actor.hp,
        };
        view.cell = actor
            .inventory
            .slots
            .iter()
            .flatten()
            .find_map(|item| cell_charge(item.equipment.kind));
        if !has_inventory {
            return view;
        }
        let slots = &actor.inventory.slots;
        let utility = slots.iter().position(|item| {
            item.is_some_and(|item| match item.equipment.kind {
                EquipmentKind::Stack {
                    kind: Utility::Medkit,
                    ..
                } => actor.hp < 65.0,
                EquipmentKind::Stack {
                    kind: Utility::Shield,
                    ..
                } => actor.shield < 45.0,
                _ => false,
            })
        });
        let loaded = slots.iter().position(|item| {
            item.is_some_and(|item|
            matches!(item.equipment.kind, EquipmentKind::Firearm { rounds, .. } if rounds > 0))
        });
        let selected = utility
            .or(loaded)
            .or_else(|| {
                slots.iter().position(|item| {
                    item.is_some_and(|item| reloadable(ctx, &actor.inventory, item.equipment.kind))
                })
            })
            .unwrap_or(0) as u8;
        view.selected = Some(selected);
        if selected != actor.inventory.selected {
            view.input.slot = Some(selected);
        }
        if let Some(utility) = utility
            && actor.deadlines.weapon_ready_at <= tick
            && id.kind == ActorKind::Contestant
            && let EquipmentKind::Stack { kind, count } = slots[utility].unwrap().equipment.kind
        {
            let applies = match kind {
                Utility::Medkit => actor.hp < actor.max_hp,
                Utility::Shield => actor.shield < actor.max_shield,
            };
            if applies {
                view.input.utility_slot = Some(utility as u8);
                if kind == Utility::Medkit {
                    view.hp = (view.hp + 40.0).min(actor.max_hp);
                }
                if count <= 1 {
                    view.inventory.slots[utility] = None;
                }
            }
        }
        view
    }

    pub fn reload(&self, ctx: &Context<'_>, actor: &Actor, no_enemy: bool) -> bool {
        self.selected.and_then(|slot| actor.inventory.item(slot)).is_some_and(|held| {
            matches!(held.equipment.kind, EquipmentKind::Firearm { rounds, .. } if (rounds == 0 || no_enemy)
                && reloadable(ctx, &actor.inventory, held.equipment.kind))
        })
    }
}

fn cell_charge(kind: EquipmentKind) -> Option<u32> {
    if let EquipmentKind::Cell { charge } = kind {
        Some(charge)
    } else {
        None
    }
}

fn is_cell(loot: Loot) -> bool {
    matches!(
        loot,
        Loot::Equipment(Equipment {
            kind: EquipmentKind::Cell { .. },
            ..
        })
    )
}

fn reloadable(ctx: &Context<'_>, inventory: &Inventory, item: EquipmentKind) -> bool {
    ctx.rules.items.reloading
        && matches!(item, EquipmentKind::Firearm { kind, rounds }
        if inventory.reloadable_rounds(kind, rounds) > 0)
}

fn accessible(ctx: &Context<'_>, memory: Option<&Memory>, item: &GroundItem, keys: u32) -> bool {
    keys > 0
        || item.building.is_none_or(|building| {
            memory.is_none_or(|memory| {
                !memory.gates.iter().any(|(id, seen)| {
                    seen.locked
                        && !seen.open
                        && ctx
                            .view
                            .state
                            .gates
                            .get(id)
                            .is_some_and(|gate| gate.building == Some(building))
                })
            })
        })
}

fn wants_loot(ctx: &Context<'_>, equip: &EquipmentIntent, loot: Loot) -> bool {
    let inventory = &equip.inventory;
    let refill = |kind: WeaponKind, rounds| {
        if ctx.rules.items.reloading {
            inventory.reserve_room(kind.family()) > 0
        } else {
            rounds < inventory::weapon_capacity(kind)
        }
    };
    match loot {
        Loot::AccessKey => true,
        Loot::Ammo { family, .. } => {
            ctx.rules.items.reloading && inventory.reserve_room(family) > 0
        }
        Loot::Equipment(source) => {
            let empty = inventory.slots.iter().any(Option::is_none);
            let matches = inventory
                .slots
                .iter()
                .flatten()
                .filter(|item| item.equipment.quality == source.quality);
            match source.kind {
                EquipmentKind::Stack { kind, .. } => {
                    (kind != Utility::Medkit || equip.hp < 75.0)
                        && (empty
                            || matches.clone().any(|i| {
                                matches!(i.equipment.kind,
                        EquipmentKind::Stack { kind: held, count } if held == kind && count < 3)
                            }))
                }
                EquipmentKind::Firearm { kind, rounds } => {
                    let mut matched = matches.filter_map(|i| match i.equipment.kind {
                        EquipmentKind::Firearm { kind: held, rounds } if held == kind => {
                            Some(rounds)
                        }
                        _ => None,
                    });
                    rounds != 0
                        && !matched.clone().any(|r| !refill(kind, r))
                        && (empty || matched.any(|r| refill(kind, r)))
                }
                EquipmentKind::Cell { .. } => false,
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn choose(
    ctx: &Context<'_>,
    collision: Option<&CollisionMap>,
    id: ActorId,
    pos: Point,
    lead: Option<Point>,
    opportunistic: bool,
    enemy: Option<f64>,
    pursuit: &mut Pursuit,
    equip: &mut EquipmentIntent,
) -> (Point, bool, Option<ItemId>) {
    let tick = ctx.view.tick;
    let memory = ctx.memory.get(&id);
    let actor = &ctx.view.state.actors[&id];
    let known =
        |at| memory.is_none_or(|m| ctx.cell_at(at).is_some_and(|i| m.discovered.contains(&i)));
    let mut items = Vec::new();
    if let Some(memory) = memory {
        items.extend(
            memory
                .item_order
                .iter()
                .map(|&id| (id, memory.items[&id].at, memory.items[&id].item)),
        );
    } else {
        items.extend(ctx.view.state.items.iter().filter_map(|(&id, item)| {
            item.position(ctx.bodies.position(BodyId::Item(id)))
                .map(|at| (id, at, *item))
        }));
    }
    let allowed = |id, at: Point, item: &GroundItem| {
        at[0] > ctx.wall() + 100.0
            && (memory.is_none() || pursuit.ignored.get(&id).is_none_or(|&until| until <= tick))
            && accessible(ctx, memory, item, actor.inventory.keys)
    };
    let exit = ctx.exit();
    let mut goal = (exit, false, None);
    let charged = equip
        .cell
        .is_some_and(|charge| charge >= ctx.rules.interactions.charge_ticks);
    let objective = if equip.cell.is_none() {
        items
            .iter()
            .filter(|&&(id, at, item)| is_cell(item.loot) && allowed(id, at, &item))
            .min_by(|a, b| distance(pos, a.1).total_cmp(&distance(pos, b.1)))
            .map(|&(id, at, _)| (at, false, Some(id)))
    } else if !charged {
        ctx.view
            .state
            .stations
            .values()
            .filter(|s| {
                s.kind == StationKind::Charging
                    && s.position[0] > ctx.wall() + 100.0
                    && known(s.position)
            })
            .min_by(|a, b| distance(pos, a.position).total_cmp(&distance(pos, b.position)))
            .map(|s| (s.position, false, None))
    } else {
        None
    };
    let loot = if actor.charging.is_none() && enemy.is_none_or(|d| d > 250.0) {
        if objective.is_some()
            && equip.cell.is_none()
            && equip.inventory.slots.iter().all(Option::is_some)
            && let Some(slot) = equip.inventory.slots.iter().position(|item| {
                item.is_some_and(|item| match item.equipment.kind {
                    EquipmentKind::Firearm { rounds, .. } => {
                        rounds == 0 && !reloadable(ctx, &actor.inventory, item.equipment.kind)
                    }
                    _ => true,
                })
            })
        {
            equip.input.drop = Some(DropSlot::Slot(slot as u8));
            equip.inventory.slots[slot] = None;
        }
        items
            .iter()
            .filter(|&&(id, at, item)| {
                at[0] >= pos[0] - 60.0
                    && distance(pos, at) < 210.0
                    && allowed(id, at, &item)
                    && wants_loot(ctx, equip, item.loot)
            })
            .min_by(|a, b| distance(pos, a.1).total_cmp(&distance(pos, b.1)))
            .map(|&(id, at, _)| (at, false, Some(id)))
    } else {
        if objective.is_some()
            && equip.cell.is_none()
            && equip.inventory.slots.iter().all(Option::is_some)
            && let Some(slot) = equip.inventory.slots.iter().position(|item| {
                item.is_some_and(|item| match item.equipment.kind {
                    EquipmentKind::Firearm { rounds, .. } => {
                        rounds == 0 && !reloadable(ctx, &actor.inventory, item.equipment.kind)
                    }
                    _ => true,
                })
            })
        {
            equip.input.drop = Some(DropSlot::Slot(slot as u8));
        }
        None
    };
    if let Some(objective) = objective {
        goal = objective;
    } else if let Some(memory) = memory
        && !(charged && known(exit))
    {
        if let Some(lead) = lead {
            goal.0 = lead;
        } else {
            let avoid = if ctx.settings.hearing && !opportunistic {
                ctx.cues.heard(id, tick)
            } else {
                Vec::new()
            };
            if let Some(at) = pursuit.explore(ctx, collision, memory, pos, &avoid) {
                goal = (at, true, None);
            } else if !known(exit) {
                goal.0 = pos;
            }
        }
    }
    loot.unwrap_or(goal)
}
