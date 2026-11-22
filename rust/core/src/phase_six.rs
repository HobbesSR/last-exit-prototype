//! Tick phase 6's per-actor loop in the core (#1230, docs/27 "The state flip", step 5e.1): in `ordered(s)`
//! order, each active actor's `interact`, its chosen `transit`, `advanceCharging` and `automaticPickups`,
//! with the swap's staged pickup and drop. `shared/simulation/phase-six.ts` is the adapter.
//!
//! The records stay in JavaScript (D1). Each call packs the actors and the map's stations, chargers and sensors. The
//! ground an actor reads (its near records, a swap's candidates and spacing spots) comes from the world's ground store
//! and its grid (`read_ground`, #1214 stage 6d.6c.1); only a resumed pickup's rest still crosses.
//! The run writes nothing back as rows: every write comes back as an ordered fact, in the order the
//! TypeScript made it, because several create keys (`charging`, `selectedSlot`, a gladiator's `transit`)
//! whose position the frozen fixture hashes, and some are Node-owned (D4's table: `route`, `input`).
//!
//! **Stops sync inside the run** (#1214 stage 6d.6c.2). A pickup that takes a ground record whole, a swap that
//! commits and an instant transit's landing change the ground and sync where Node used to: the core writes its ground
//! store (`write_partial` for a partial take too), runs the body sync (`OP_SYNC`), applies the facts so far to the
//! player store, and reads the actors still to run as the call resuming there would (`prepare`; after a pickup, the
//! records still to visit by the TypeScript's rule). Where the run does not hold what that call would be given (an
//! identity it would register, or its label budget), the stop stays a stop, carried out, and Node resumes (`OP_REST`).
//! A call the adapter does not mark (`IN_RUN`) stops at each as before.
use crate::action_equipment::{equipped, sync_weapon, valid_payload};
use crate::action_types::{
    ABSENT_AMMO, ABSENT_CHARGE, ABSENT_INSTANCE, ABSENT_LINEAGE, ABSENT_QUALITY, ABSENT_WEAPON,
    Item, Player, Rules, safe, truthy,
};
use crate::collision::{CollisionMap, line_clear, reach_clear};
use crate::drop_planner::{self, Allocation, Context};
use crate::ground;
use crate::math::{hypot, js_max, js_min, js_round};
use crate::placement::{Disk, placement};
use crate::sight::{GateSet, SightIndex};
use crate::swept::SweptMap;
use crate::world::World;

/// A ground record's count was absent (`item.count ?? 1`), not NaN.
pub const ABSENT_COUNT: u32 = 64;

/// Input header, then per actor an `ACTOR_ROW`, its optional reserves, its inventory rows (ten words
/// each, as phase 3's), its swap candidates, swap's nearby records and ground IDs, and the ground
/// records near it; then the players, stations, chargers and sensors, the free label phases, the
/// registered IDs and the carried identities; then, when the header counts them, each gate's
/// `GATE_DETAIL` words, sent once per gate set. A gate's lock is read from the gate set's mask.
pub const HEADER: usize = 32;
const MODE: usize = 0;
const RESUME_ACTOR: usize = 1;
const RESUME_STEP: usize = 2;
const TICK: usize = 3;
const SERIAL: usize = 4;
const ITEM_SERIAL: usize = 5;
const SCATTER_SERIAL: usize = 6;
const SLOTS: usize = 7;
const HAZARD_X: usize = 8;
const CHARGE_TICKS: usize = 9;
const TRANSIT_TIME: usize = 10;
const TRANSIT_BASE: usize = 11;
const TRANSIT_PER_UNIT: usize = 12;
const GROUND_COUNT: usize = 13;
const RESERVE_ACTORS: usize = 14;
const EXIT_X: usize = 15;
const EXIT_Y: usize = 16;
const RESERVE_CAPACITY: usize = 17;
const ACTORS: usize = 20;
const PLAYERS: usize = 21;
const STATIONS: usize = 22;
const CHARGERS: usize = 23;
const SENSORS: usize = 24;
const PHASES: usize = 25;
const KNOWN: usize = 26;
const CARRIED: usize = 27;
const GATE_DETAILS: usize = 28;

/// Per actor: roster, role (0 contestant), status (0 active), bot, x, y, railCd, keys, cloak,
/// charging (charger index; -1 none; -2 an unknown charger), selectedSlot (NaN absent), weapon,
/// moved (path over the jitter tolerance), discovery memory, steps (1 interact, 2 transit choice,
/// 4 charging, 8 pickups), transit choice (NaN none, -1 unknown), sneak, reserves flag, inventory
/// length (-1 none), then the counts of swap candidates, swap's nearby records, swap's ground IDs
/// and near records. The core reads a swap's three lists (`FROM_STORE` in the first count) and the near records
/// (`FROM_STORE` in theirs) from its ground store (#1214 stage 6d.6c.1); a resumed pickup's rest still crosses.
pub const ACTOR_ROW: usize = 23;
/// The spiral's farthest spot and its spacing, with a unit spare (`scatter.rs`): a swap's drop reads records this near.
const SCATTER_REACH: f64 = 372.0 + 32.0 + 1.0;
/// Per gate, once per gate set: x, y, door.
pub const GATE_DETAIL: usize = 3;
/// Per ground record: id, x, y, dropped by this actor, pickupAfter, ammo family (-1 none), has a
/// body, label rank among the swap candidates, then phase 3's ten item words (token unused).
pub const GROUND_ROW: usize = 18;
/// Per player: status, x, y, radius.
pub const PLAYER_ROW: usize = 4;

/// Output header: length, serial, item serial, scatter serial, resume actor (-1 finished), resume
/// step, slots, registration count, log length, error code, error value.
pub const OUT_HEADER: usize = 11;

pub const OP_EFFECT: f64 = 1.0;
pub const OP_ESCAPE: f64 = 2.0;
pub const OP_CHARGED: f64 = 3.0;
pub const OP_ROUTE: f64 = 4.0;
pub const OP_CHARGING: f64 = 5.0;
pub const OP_TRANSIT: f64 = 6.0;
pub const OP_LAND: f64 = 7.0;
pub const OP_GATE: f64 = 8.0;
pub const OP_OBSERVE: f64 = 9.0;
pub const OP_CELL: f64 = 10.0;
pub const OP_KEYS: f64 = 11.0;
pub const OP_INVENTORY: f64 = 12.0;
pub const OP_ITEM: f64 = 13.0;
pub const OP_REMOVE: f64 = 14.0;
pub const OP_SWAP: f64 = 15.0;
pub const OP_REVEALED: f64 = 16.0;

const STEP_INTERACT: u32 = 1;
const STEP_TRANSIT: u32 = 2;
const STEP_CHARGING: u32 = 4;
const STEP_PICKUPS: u32 = 8;

const KIND_WEAPON: f64 = 0.0;
const KIND_CELL: f64 = 3.0;
const KIND_ACCESS: f64 = 4.0;
const KIND_AMMO: f64 = 5.0;
const STATUS_ACTIVE: f64 = 0.0;
const STATUS_ESCAPED: f64 = 3.0;
const STATUS_TRANSIT: f64 = 5.0;
const EFFECT_LOOT: f64 = 3.0;
const EFFECT_RAIL: f64 = 5.0;
const EFFECT_CHARGE: f64 = 6.0;

const GATE_REACH: f64 = 85.0;
const EXTRACTION_REACH: f64 = 65.0;
const CHARGE_REACH: f64 = 70.0;
const PICKUP_REACH: f64 = 45.0;
const TRANSIT_REACH: f64 = 70.0;
const AUTOMATIC_REACH: f64 = 38.0;
const SENSOR_REACH: f64 = 180.0;
const TILE: f64 = 40.0;
const RAIL_COOLDOWN: f64 = 180.0;

#[derive(Default)]
pub struct PhaseSix {
    pub input: Vec<f64>,
    pub output: Vec<f64>,
}

#[derive(Clone)]
struct Ground {
    id: f64,
    x: f64,
    y: f64,
    mine: bool,
    pickup_after: f64,
    family: f64,
    body: bool,
    rank: f64,
    item: Item,
}

#[derive(Clone, Copy)]
struct Gate {
    index: usize,
    x: f64,
    y: f64,
    door: bool,
    locked: f64,
    open: bool,
}

struct Actor {
    p: Player,
    /// The adapter asked for this actor's inventory from the player store (`phase_three::FROM_STORE`).
    inventory_from_store: bool,
    bot: bool,
    rail_cd: f64,
    keys: f64,
    charging: f64,
    moved: bool,
    discovery: bool,
    steps: u32,
    choice: f64,
    sneak: bool,
    swap: Vec<Ground>,
    swap_taken: Vec<[f64; 3]>,
    swap_ground: Vec<f64>,
    near: Vec<Ground>,
    /// The swap's lists and the near records come from the ground store (6d.6c.1).
    swap_from_store: bool,
    near_from_store: bool,
    /// The near records crossed: a resumed pickup's rest.
    rested: bool,
    /// The near records are the rest a pickup carried out inside the run left (6d.6c.2).
    rested_after_stop: bool,
}

#[derive(Clone, Copy)]
struct Other {
    status: f64,
    x: f64,
    y: f64,
    radius: f64,
}

struct Reader<'a> {
    v: &'a [f64],
    at: usize,
}
impl Reader<'_> {
    fn row<const N: usize>(&mut self) -> [f64; N] {
        let mut a = [0.0; N];
        a.copy_from_slice(&self.v[self.at..self.at + N]);
        self.at += N;
        a
    }
    fn vec(&mut self, n: usize) -> Vec<f64> {
        let a = self.v[self.at..self.at + n].to_vec();
        self.at += n;
        a
    }
    fn ground(&mut self) -> Ground {
        let a: [f64; GROUND_ROW] = self.row();
        Ground {
            id: a[0],
            x: a[1],
            y: a[2],
            mine: a[3] != 0.0,
            pickup_after: a[4],
            family: a[5],
            body: a[6] != 0.0,
            rank: a[7],
            item: Item::read(&a[8..18]),
        }
    }
}

fn read_actor(r: &mut Reader<'_>) -> Actor {
    let a: [f64; ACTOR_ROW] = r.row();
    let reserves = if a[17] != 0.0 { Some(r.row()) } else { None };
    let inventory = (a[18] >= 0.0).then(|| {
        (0..a[18] as usize)
            .map(|_| {
                let row: [f64; 10] = r.row();
                (row[0] != -1.0).then(|| Item::read(&row))
            })
            .collect()
    });
    let from_store = crate::phase_three::FROM_STORE;
    let (swap_from_store, near_from_store) = (a[19] == from_store, a[22] == from_store);
    let count = |n: f64| if n == from_store { 0 } else { n as usize };
    let swap = (0..count(a[19])).map(|_| r.ground()).collect();
    let swap_taken = (0..count(a[20])).map(|_| r.row()).collect();
    let swap_ground = r.vec(count(a[21]));
    let near = (0..count(a[22])).map(|_| r.ground()).collect();
    Actor {
        p: Player {
            roster: a[0] as usize,
            key: 0,
            role: a[1],
            status: a[2],
            kit: 0,
            x: a[4],
            y: a[5],
            heading: 0.0,
            hp: 0.0,
            max_hp: 0.0,
            shield: 0.0,
            selected: a[10],
            weapon: a[11],
            attack_cd: 0.0,
            cooldown: 0.0,
            cloak: a[8],
            revealed: 0.0,
            boost: 0.0,
            stun: 0.0,
            level: 0.0,
            inventory,
            reserves,
            reload: None,
            retired: Vec::new(),
        },
        inventory_from_store: a[18] == crate::phase_three::FROM_STORE,
        bot: a[3] != 0.0,
        rail_cd: a[6],
        keys: a[7],
        charging: a[9],
        moved: a[12] != 0.0,
        discovery: a[13] != 0.0,
        steps: a[14] as u32,
        choice: a[15],
        sneak: a[16] != 0.0,
        swap,
        swap_taken,
        swap_ground,
        near,
        swap_from_store,
        near_from_store,
        rested: a[22] >= 0.0,
        rested_after_stop: false,
    }
}

/// A ground store record as the adapter packed it (`putGround`): the dropper compared with `roster`, the item's seven
/// absence bits, no token.
fn ground_of(w: &[f64; ground::RECORD], roster: usize, rank: f64, body: bool) -> Ground {
    Ground {
        id: w[0],
        x: w[ground::X],
        y: w[ground::Y],
        mine: w[13] == roster as f64,
        pickup_after: w[14],
        family: w[9],
        body,
        rank,
        item: Item {
            kind: w[4],
            weapon: w[5],
            ammo: w[6],
            count: w[7],
            charge: w[8],
            instance: w[10],
            lineage: w[11],
            quality: w[12],
            token: f64::NAN,
            absent: (w[15] as u32) & 127,
        },
    }
}

/// The ground an actor reads, from the world's store (#1214 stage 6d.6c.1), as the adapter packed it:
/// - **near records**: `inReach(itemsNear(s, p, 38), p)`, the records in a box one unit past `automaticPickups`' reach
///   (a coordinate that is NaN passes), in the list's order;
/// - **a swap's candidates**: those `itemsNear(s, p, PICKUP_REACH)` offers, each with whether its body is held and its
///   label's rank among them (the keys' ID order is the labels'), unranked when unlabelled;
/// - **a swap's spacing spots** (`itemsNear(s, p, SCATTER_REACH)`), and the outgoing item's identity if the ground holds
///   it.
///
/// The grid offers a superset; the rules' own distance tests decide, so a superset differing from JavaScript's changes no
/// ruling, and ranks keep their relative order.
/// `inReach`'s box: one unit past `automaticPickups`' reach; a NaN coordinate passes.
fn in_reach(r: &ground::Record, x: f64, y: f64) -> bool {
    let box_reach = AUTOMATIC_REACH + 1.0;
    !((r.words[ground::X] - x).abs() > box_reach || (r.words[ground::Y] - y).abs() > box_reach)
}

/// An actor's near records from the store, as `inReach(itemsNear(s, p, AUTOMATIC_REACH), p)` gives them.
fn near_list(world: &World, x: f64, y: f64, roster: usize) -> Vec<Ground> {
    world
        .ground
        .near(x, y, AUTOMATIC_REACH + 1.0)
        .iter()
        .filter(|r| in_reach(r, x, y))
        .map(|r| ground_of(&r.words, roster, 0.0, false))
        .collect()
}

/// An actor as a call reads it from the stores, deciding as the adapter decides (#1214 stage 6d.6c.2): the store's
/// fields and equipment; its near records (or `rest`, a pickup's records still to visit); whether it can swap; and its
/// inventory only where a rule can read it (`readable` in `phase-six.ts`). A run that syncs inside itself reads the
/// actors this way at its start and again after each stop, as the call that resumed there would.
fn prepare(a: &mut Actor, world: &World, rest: Option<Vec<Ground>>) {
    let roster = a.p.roster;
    let (s, e, q) = (
        &world.players.rows[roster],
        &world.players.extra[roster],
        &world.players.equip[roster],
    );
    (a.p.role, a.p.status, a.p.x, a.p.y, a.p.cloak, a.rail_cd) =
        (s.role, s.status, s.x, s.y, e.cloak, e.rail_cd);
    (a.p.selected, a.p.weapon, a.p.reserves, a.keys, a.charging) =
        (q.selected, q.weapon, q.reserves, q.keys, q.charging);
    let interact = a.steps & STEP_INTERACT != 0;
    let pickups = a.steps & STEP_PICKUPS != 0 && a.p.role == 0.0;
    let list = match rest {
        Some(rest) => rest,
        None if pickups => near_list(world, a.p.x, a.p.y, roster),
        None => Vec::new(),
    };
    let inventory = &q.inventory;
    let swap = interact
        && !a.bot
        && inventory
            .as_ref()
            .is_some_and(|v| v.iter().all(Option::is_some));
    let readable = !list.is_empty()
        || swap
        || a.charging != -1.0
        || interact
            && inventory
                .iter()
                .flatten()
                .flatten()
                .any(|i| i.kind == KIND_CELL);
    a.p.inventory = if readable { inventory.clone() } else { None };
    a.near = list;
    a.near_from_store = false;
    (a.swap, a.swap_taken, a.swap_ground) = (Vec::new(), Vec::new(), Vec::new());
    a.swap_from_store = swap;
    read_ground(a, world);
}

fn read_ground(a: &mut Actor, world: &World) {
    let (x, y, roster) = (a.p.x, a.p.y, a.p.roster);
    let ground = &world.ground;
    if a.near_from_store {
        a.near = near_list(world, x, y, roster);
    }
    if a.swap_from_store {
        let candidates = ground.near(x, y, PICKUP_REACH);
        let key = |r: &ground::Record| {
            let k = r.words[1];
            (k.is_finite() && k >= 0.0).then_some(k as crate::world::Key)
        };
        let mut labelled: Vec<crate::world::Key> = candidates.iter().filter_map(key).collect();
        labelled.sort_by(|&p, &q| world.id_order(p, q));
        a.swap = candidates
            .iter()
            .map(|r| {
                let k = key(r);
                let rank = k.map_or(f64::NAN, |k| {
                    labelled.iter().position(|&l| l == k).unwrap_or(0) as f64
                });
                ground_of(&r.words, roster, rank, k.is_some_and(|k| world.has_body(k)))
            })
            .collect();
        a.swap_taken = ground
            .near(x, y, SCATTER_REACH)
            .iter()
            .map(|r| [r.words[0], r.words[ground::X], r.words[ground::Y]])
            .collect();
        let selected = if a.p.selected.is_nan() {
            0
        } else {
            a.p.selected as usize
        };
        let outgoing =
            a.p.inventory
                .as_ref()
                .and_then(|i| i.get(selected))
                .and_then(Option::as_ref);
        a.swap_ground = outgoing
            .filter(|o| {
                !o.missing(ABSENT_INSTANCE) && truthy(o.instance) && ground.holds_id(o.instance)
            })
            .map(|o| vec![o.instance])
            .unwrap_or_default();
    }
}

fn distance(a: (f64, f64), b: (f64, f64)) -> f64 {
    hypot(a.0 - b.0, a.1 - b.1)
}

/// The comparator `d || tie`: a zero or NaN difference falls through to `tie`.
fn order(d: f64, tie: std::cmp::Ordering) -> std::cmp::Ordering {
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        tie
    }
}

/// `a > b`, false for NaN: the TypeScript's tests negate it.
fn later(a: f64, b: f64) -> bool {
    a > b
}

fn valid_id(n: f64) -> bool {
    safe(n) && n > 0.0
}

/// `validateItemPayload` for a ground record: unlike a carried one, it has an `id`, so access and
/// ammo records are legal and a stack's count is not capped at three.
fn valid_ground_payload(g: &Ground, rules: &Rules) -> bool {
    let item = &g.item;
    match item.kind {
        0.0 | 3.0 => return valid_payload(item, rules),
        1.0 | 2.0 | 4.0 | 5.0 => {}
        _ => return false,
    }
    if !(item.missing(ABSENT_QUALITY)
        || item.quality.fract() == 0.0 && (1.0..=5.0).contains(&item.quality))
        || !item.missing(ABSENT_INSTANCE) && !valid_id(item.instance)
        || !item.missing(ABSENT_LINEAGE) && !valid_id(item.lineage)
    {
        return false;
    }
    let count = |fallback: f64| item.value(ABSENT_COUNT, item.count, fallback);
    match item.kind {
        1.0 | 2.0 => valid_id(count(1.0)),
        5.0 => rules.reloading && (0.0..3.0).contains(&g.family) && valid_id(count(f64::NAN)),
        _ => true,
    }
}

/// `validIdentityState` with a ground record (`equipment.ts`).
fn valid_identity_state(p: &Player, g: &Ground, rules: &Rules, allocation: &Allocation) -> bool {
    if !safe(rules.ground_capacity)
        || rules.ground_capacity < 0.0
        || !safe(allocation.item_serial)
        || allocation.item_serial < 0.0
    {
        return false;
    }
    let Some(inventory) = &p.inventory else {
        return false;
    };
    if inventory.len() != 6
        || !valid_id(g.id)
        || !g.item.missing(ABSENT_INSTANCE) && g.item.instance != g.id
        || !valid_ground_payload(g, rules)
    {
        return false;
    }
    let mut ids = vec![g.id];
    for item in inventory.iter().flatten() {
        if !valid_payload(item, rules) || truthy(item.instance) && ids.contains(&item.instance) {
            return false;
        }
        if truthy(item.instance) {
            ids.push(item.instance);
        }
    }
    true
}

fn prepare_carried(p: &mut Player, allocation: &mut Allocation) -> Result<(), (i32, f64)> {
    for item in p.inventory.iter_mut().flatten().flatten() {
        allocation.ensure_checked(item)?;
    }
    Ok(())
}

fn same_quality(a: &Item, b: &Item) -> bool {
    a.value(ABSENT_QUALITY, a.quality, 1.0) == b.value(ABSENT_QUALITY, b.quality, 1.0)
}

/// `collectRounds`: what fits of a record's rounds into a reserve. True when none remain.
fn collect_rounds(
    p: &mut Player,
    capacity: &[f64; 3],
    family: usize,
    item: &mut Item,
    ammo: bool,
) -> bool {
    let Some(reserves) = p.reserves.as_mut() else {
        return false;
    };
    let incoming = if ammo {
        item.value(ABSENT_AMMO, item.ammo, 0.0)
    } else {
        item.value(ABSENT_COUNT, item.count, 0.0)
    };
    if !safe(incoming) || incoming < 0.0 {
        return false;
    }
    let transfer = js_min(incoming, capacity[family] - reserves[family]);
    // `transfer <= 0` is false for NaN, which went on to write NaN.
    if transfer <= 0.0 {
        return false;
    }
    reserves[family] += transfer;
    let left = incoming - transfer;
    if ammo {
        item.ammo = left;
        item.absent &= !ABSENT_AMMO;
    } else {
        item.count = left;
        item.absent &= !ABSENT_COUNT;
    }
    left == 0.0
}

/// `collectAmmo`: an L2 ammo pickup adds to its family reserve.
fn collect_ammo(
    p: &mut Player,
    g: &mut Ground,
    rules: &Rules,
    capacity: &[f64; 3],
    allocation: &Allocation,
) -> bool {
    if g.item.kind != KIND_AMMO
        || !rules.reloading
        || !valid_identity_state(p, g, rules, allocation)
    {
        return false;
    }
    collect_rounds(p, capacity, g.family as usize, &mut g.item, false)
}

/// `collectInstanceEquipment`: an L0 transfer. True means the whole ground record may go; a partial
/// take writes to `g`, the draft of the published record. Errors are the TypeScript's throws.
fn collect_equipment(
    p: &mut Player,
    g: &mut Ground,
    rules: &Rules,
    capacity: &[f64; 3],
    allocation: &mut Allocation,
) -> Result<bool, (i32, f64)> {
    if !valid_identity_state(p, g, rules, allocation)
        || g.item.kind == KIND_ACCESS
        || g.item.kind == KIND_AMMO
    {
        return Ok(false);
    }
    let root = g.item.value(ABSENT_LINEAGE, g.item.lineage, g.id);
    let kind = g.item.kind;
    let stack = kind == 1.0 || kind == 2.0;
    let weapon_type = g.item.value(ABSENT_WEAPON, g.item.weapon, 0.0);
    if kind == KIND_WEAPON {
        let spec = &rules.weapons[weapon_type as usize];
        let existing = p.inventory.as_ref().unwrap().iter().position(|slot| {
            slot.as_ref().is_some_and(|slot| {
                slot.kind == KIND_WEAPON
                    && !slot.missing(ABSENT_WEAPON)
                    && slot.weapon == weapon_type
                    && same_quality(slot, &g.item)
            })
        });
        if let Some(e) = existing {
            // Under L2 a duplicate's loaded rounds go to the family reserve; its magazine never merges.
            if rules.reloading {
                let family = spec.reload.map_or(f64::NAN, |rule| rule[0]);
                return Ok(collect_rounds(
                    p,
                    capacity,
                    family as usize,
                    &mut g.item,
                    true,
                ));
            }
            let slot = p.inventory.as_ref().unwrap()[e].as_ref().unwrap();
            let current = slot.value(ABSENT_AMMO, slot.ammo, spec.ammo);
            let incoming = g.item.value(ABSENT_AMMO, g.item.ammo, spec.ammo);
            let transfer = js_min(incoming, spec.max_ammo - current);
            if transfer <= 0.0 {
                return Ok(false);
            }
            prepare_carried(p, allocation)?;
            let slot = p.inventory.as_mut().unwrap()[e].as_mut().unwrap();
            slot.ammo = current + transfer;
            slot.absent &= !ABSENT_AMMO;
            g.item.ammo = incoming - transfer;
            g.item.absent &= !ABSENT_AMMO;
            return Ok(g.item.ammo == 0.0);
        }
    } else if stack {
        let target = p.inventory.as_ref().unwrap().iter().position(|slot| {
            slot.as_ref().is_some_and(|slot| {
                (slot.kind == 1.0 || slot.kind == 2.0)
                    && slot.kind == kind
                    && same_quality(slot, &g.item)
                    && slot.count < 3.0
            })
        });
        if let Some(t) = target {
            let count = g.item.value(ABSENT_COUNT, g.item.count, 1.0);
            let target_count = p.inventory.as_ref().unwrap()[t].as_ref().unwrap().count;
            let transfer = js_min(count, 3.0 - target_count);
            prepare_carried(p, allocation)?;
            p.inventory.as_mut().unwrap()[t].as_mut().unwrap().count += transfer;
            if transfer == count {
                return Ok(true);
            }
            g.item.count = count - transfer;
            g.item.absent &= !ABSENT_COUNT;
            return Ok(false);
        }
    }
    let Some(index) = p
        .inventory
        .as_ref()
        .unwrap()
        .iter()
        .position(Option::is_none)
    else {
        return Ok(false);
    };
    let count = if stack {
        g.item.value(ABSENT_COUNT, g.item.count, 1.0)
    } else {
        1.0
    };
    let taken = js_min(count, 3.0);
    prepare_carried(p, allocation)?;
    let id = if taken < count {
        if !safe(allocation.scatter_serial) || allocation.scatter_serial < 0.0 {
            return Err((-101, 0.0));
        }
        allocation.allocate().ok_or((-102, 0.0))?
    } else {
        g.id
    };
    let mut item = Item {
        kind,
        weapon: f64::NAN,
        ammo: f64::NAN,
        count: f64::NAN,
        charge: f64::NAN,
        instance: id,
        lineage: root,
        quality: g.item.quality,
        // A new object: JavaScript builds it in the TypeScript's key order.
        token: -1.0,
        absent: ABSENT_AMMO | ABSENT_CHARGE | ABSENT_WEAPON | (g.item.absent & ABSENT_QUALITY),
    };
    if kind == KIND_WEAPON {
        item.weapon = weapon_type;
        item.ammo = g.item.value(
            ABSENT_AMMO,
            g.item.ammo,
            rules.weapons[weapon_type as usize].ammo,
        );
        item.absent &= !(ABSENT_AMMO | ABSENT_WEAPON);
    } else if kind == KIND_CELL {
        item.charge = g.item.value(ABSENT_CHARGE, g.item.charge, 0.0);
        item.absent &= !ABSENT_CHARGE;
    } else {
        item.count = taken;
    }
    p.inventory.as_mut().unwrap()[index] = Some(item);
    if taken < count {
        g.item.count = count - taken;
        g.item.absent &= !ABSENT_COUNT;
    }
    let equipped_kind = equipped(p).map(|e| e.kind);
    if equipped_kind.is_none() || kind == KIND_WEAPON && equipped_kind != Some(KIND_WEAPON) {
        p.selected = index as f64;
    }
    sync_weapon(p, rules);
    Ok(taken == count)
}

/// `carriedCell`: the equipped cell, else the first carried.
fn carried_cell(p: &Player) -> Option<usize> {
    let inventory = p.inventory.as_ref()?;
    if equipped(p).is_some_and(|e| e.kind == KIND_CELL) {
        let s = if truthy(p.selected) { p.selected } else { 0.0 };
        return Some(s as usize);
    }
    inventory
        .iter()
        .position(|i| i.as_ref().is_some_and(|i| i.kind == KIND_CELL))
}

fn op(log: &mut Vec<f64>, kind: f64, row: &[f64]) {
    log.extend_from_slice(&[kind, row.len() as f64]);
    log.extend_from_slice(row);
}

fn inventory_row(row: &mut Vec<f64>, p: &Player) {
    row.extend_from_slice(&[p.selected, p.weapon]);
    match p.reserves {
        Some(r) => row.extend_from_slice(&[1.0, r[0], r[1], r[2]]),
        None => row.extend_from_slice(&[0.0, f64::NAN, f64::NAN, f64::NAN]),
    }
    let inventory = p.inventory.as_deref().unwrap_or(&[]);
    row.push(inventory.len() as f64);
    for item in inventory {
        row.extend_from_slice(&item.as_ref().map_or([-1.0; 10], Item::row));
    }
}

struct Run<'a> {
    rules: &'a Rules,
    world: &'a mut World,
    map: &'a mut CollisionMap,
    index: &'a SightIndex,
    gates: &'a mut GateSet,
    tick: f64,
    serial: f64,
    slots: f64,
    allocation: Allocation,
    log: Vec<f64>,
    players: Vec<Other>,
    stations: Vec<[f64; 2]>,
    chargers: Vec<[f64; 2]>,
    sensors: Vec<[f64; 2]>,
    carried: Vec<[f64; 2]>,
    /// Ground records this run changed without taking: id, the draft's item words.
    item_writes: Vec<(f64, Item)>,
    h: [f64; HEADER],
    /// What the run needs to sync its stops inside itself (#1214 stage 6d.6c.2), when the adapter sent it.
    in_run: Option<InRun<'a>>,
    /// The stop the last step made, for the run to carry out inside itself.
    stop: Option<StopKind>,
}

/// What a run needs to sync inside itself (#1214 stage 6d.6c.2), packed after the gates' details when header word
/// `IN_RUN` is set: the markers' capacity, the roster's size, the loot's drop speed, whether any actor may swap, the
/// markers' count and keys; then, when one may swap, each free label phase's body key (parallel to the phases) and each
/// carried identity's (parallel to the carried pairs), which Node interns, since the core interns no strings.
struct InRun<'s> {
    swept: &'s SweptMap,
    capacity: f64,
    roster: f64,
    drop_speed: f64,
    swaps: bool,
    phase_keys: Vec<(f64, f64)>,
    carried_keys: Vec<(f64, f64)>,
}

/// How a stop carried out inside the run ended.
enum Carried {
    /// The run goes on at the same actor's next step.
    Continued,
    /// The run stops there, as before 6d.6c.2, with the stop carried out (`OP_REST` gives Node the rest).
    Stopped,
    /// The sync refused: the run ends, as Node's throw did.
    Refused,
}

/// The records a pickup's actor had still to visit, by id, when a stop carried out inside the run stays a stop.
pub const OP_REST: f64 = 18.0;

/// A stop the run carries out inside itself.
enum StopKind {
    /// A record taken whole, and the records the actor had still to visit.
    Pickup { id: f64, listed: Vec<Ground> },
    /// A committed swap: the pickup's id and the drop's records.
    Swap {
        pickup: f64,
        records: Vec<drop_planner::Record>,
    },
    /// An instant transit's landing.
    Land,
}

/// The sync's log a stop leaves in the output, applied by Node as its own sync's (`boundary::synchronize`).
pub const OP_SYNC: f64 = 17.0;
/// Header word: the call syncs its stops inside the run (6d.6c.2).
const IN_RUN: usize = 29;

/// Where the call stopped, and the step of the same actor it resumes at.
type Stop = Option<u32>;

impl Run<'_> {
    /// A partial take's write to the ground store, as Node's `replaceItem` of `settledItem(current, draft)` writes it
    /// through: the field takes its value and is present; an unchanged record is not written.
    fn write_partial(&mut self, id: f64, (field, value): (f64, f64)) {
        let Some((at, _)) = self.world.ground.find_id(id) else {
            return;
        };
        let mut words = self.world.ground.records[at].words;
        let (word, bit) = if field == 0.0 {
            (6, ABSENT_AMMO)
        } else {
            (7, ABSENT_COUNT)
        };
        let absent = words[15] as u32;
        if absent & bit == 0 && words[word].to_bits() == value.to_bits() {
            return;
        }
        words[word] = value;
        words[15] = f64::from(absent & !bit);
        self.world.replace_ground(at, &words);
    }

    /// A drop record's body key: a newly allocated identity's from its label phase, else the outgoing item's own.
    fn record_key(&self, record: &drop_planner::Record) -> f64 {
        let Some(sync) = self.in_run.as_ref() else {
            return f64::NAN;
        };
        let phase = self
            .allocation
            .facts
            .iter()
            .find(|f| f[0] == record.id)
            .map(|f| f[1]);
        let by_phase = phase.and_then(|phase| sync.phase_keys.iter().find(|k| k.0 == phase));
        let by_token = || sync.carried_keys.iter().find(|k| k.0 == record.item.token);
        by_phase.or_else(by_token).map_or(f64::NAN, |k| k.1)
    }

    /// Carry out a stop inside the run, as Node did between calls, then read the actors from `at` on as the call that
    /// resumed there would (#1214 stage 6d.6c.2). The facts so far reach the player store first, as Node applied them
    /// before its sync.
    ///
    /// The run goes on only where it holds what that call would: every identity it would register, and the label
    /// phases it would be given (its budget, to which the run's are cut). Otherwise the stop stays a stop
    /// (`Carried::Stopped`): the ground and the sync are done, and Node resumes with the rest (`OP_REST`).
    fn carry_out(
        &mut self,
        kind: StopKind,
        actors: &mut [Actor],
        at: usize,
        cursor: &mut usize,
    ) -> Carried {
        self.world
            .players
            .apply_interaction_log(&self.log[*cursor..]);
        *cursor = self.log.len();
        let roster = actors[at].p.roster;
        let sync = self
            .in_run
            .as_ref()
            .expect("a run that syncs inside itself");
        let (swept, capacity, size, speed, swaps) = (
            sync.swept,
            sync.capacity,
            sync.roster,
            sync.drop_speed,
            sync.swaps,
        );
        let mut rest = None;
        let synced = match kind {
            StopKind::Pickup { id, listed } => {
                // `removeItem`, then the sync; the records still to visit are the rest of the list, or, when the sync
                // placed the actor again, those after the taken one near where it now stands.
                let pose = |w: &World| (w.players.rows[roster].x, w.players.rows[roster].y);
                let before = pose(self.world);
                let (found, seq) = self.world.ground.find_id(id).expect("the taken record");
                self.world.remove_ground(found);
                let out = crate::boundary::synchronize_in_run(
                    self.world, self.map, self.gates, swept, self.tick, capacity, size,
                );
                let after = pose(self.world);
                let moved = before.0.to_bits() != after.0.to_bits()
                    || before.1.to_bits() != after.1.to_bits();
                let ground = &self.world.ground;
                rest = Some(if moved {
                    ground
                        .near_after(after.0, after.1, AUTOMATIC_REACH + 1.0, seq)
                        .iter()
                        .filter(|r| in_reach(r, after.0, after.1))
                        .map(|r| ground_of(&r.words, roster, 0.0, false))
                        .collect()
                } else {
                    // `groundItem(s, item.id) ?? item`.
                    listed
                        .into_iter()
                        .map(|g| {
                            ground
                                .by_id(g.id)
                                .map_or(g, |r| ground_of(&r.words, roster, 0.0, false))
                        })
                        .collect()
                });
                Some(out)
            }
            StopKind::Swap { pickup, records } => {
                // `removeItem(pickup)`, `addItems(records)`, then `launchPhysicalDrops` and its sync.
                let (found, _) = self
                    .world
                    .ground
                    .find_id(pickup)
                    .expect("the swap's pickup");
                self.world.remove_ground(found);
                let from = (
                    self.world.players.rows[roster].x,
                    self.world.players.rows[roster].y,
                );
                let keys: Vec<f64> = records.iter().map(|r| self.record_key(r)).collect();
                let words: Vec<f64> = records
                    .iter()
                    .zip(&keys)
                    .flat_map(|(r, &key)| {
                        crate::phase_three::ground_words(
                            self.rules,
                            r,
                            key,
                            roster as f64,
                            self.tick,
                        )
                    })
                    .collect();
                self.world.add_ground(&words);
                for (r, &key) in records.iter().zip(&keys) {
                    crate::phase_three::launch(self.world, key, r, from, speed);
                }
                Some(crate::boundary::synchronize_in_run(
                    self.world, self.map, self.gates, swept, self.tick, capacity, size,
                ))
            }
            StopKind::Land => None,
        };
        if let Some(out) = synced {
            let refused = out[0] < 0.0;
            op(&mut self.log, OP_SYNC, &out);
            *cursor = self.log.len();
            if refused {
                return Carried::Refused;
            }
            self.h[RESERVE_ACTORS] = (size as usize).saturating_sub(self.world.sync_actors) as f64;
        }
        // What the next call repacked: the actors from here on, the players, the ground's count and, where a swap may
        // happen, the carried identities. The partial takes' overlay is the store's now.
        let rested = rest.is_some();
        for (j, a) in actors.iter_mut().enumerate().skip(at) {
            prepare(a, self.world, if j == at { rest.take() } else { None });
            a.rested_after_stop = j == at && rested;
        }
        for (k, o) in self.players.iter_mut().enumerate() {
            let s = &self.world.players.rows[k];
            (o.status, o.x, o.y) = (s.status, s.x, s.y);
        }
        self.h[GROUND_COUNT] = self.world.ground.len() as f64;
        if swaps {
            self.carried = self
                .world
                .players
                .equip
                .iter()
                .flat_map(|q| q.inventory.iter().flatten().flatten())
                .filter(|i| !i.missing(ABSENT_INSTANCE) && truthy(i.instance))
                .map(|i| [i.token, i.instance])
                .collect();
        }
        self.item_writes.clear();
        if self.holds_resumed_call(&actors[at..]) {
            return Carried::Continued;
        }
        // A pickup's actor resumes at its rest; after a swap or a landing the resumed call reads a fresh list.
        if actors[at].rested_after_stop {
            let mut row = vec![actors[at].near.len() as f64];
            row.extend(actors[at].near.iter().map(|g| g.id));
            op(&mut self.log, OP_REST, &row);
        }
        Carried::Stopped
    }

    /// Whether the run holds what the call resuming at these actors would be given: the registered identities of each
    /// actor's carried items where it has near records or may swap (`known` in `phase-six.ts`), and at least the label
    /// phases of that call's budget as it was before the run synced inside itself (the near records, ten a swap and one
    /// an unidentified carried item), which the run's are then cut to.
    fn holds_resumed_call(&mut self, actors: &[Actor]) -> bool {
        let mut budget = 0usize;
        let mut swaps = false;
        for a in actors {
            let (list, swap) = (a.near.len(), a.swap_from_store);
            swaps |= swap;
            if list == 0 && !swap {
                continue;
            }
            budget += list + if swap { 10 } else { 0 };
            for item in a.p.inventory.iter().flatten().flatten() {
                if item.missing(ABSENT_INSTANCE) {
                    budget += 1;
                } else if !self.allocation.registered.contains(&item.instance) {
                    return false;
                }
                if !item.missing(ABSENT_LINEAGE)
                    && !self.allocation.registered.contains(&item.lineage)
                {
                    return false;
                }
            }
        }
        // The budget is the call's before 6d.6c.2 (`phase-six.ts` adds more where a swap may happen, so the run can hold it).
        let _ = swaps;
        let serial = self.allocation.scatter_serial;
        if budget == 0 || !(safe(serial) && serial >= 0.0) {
            self.allocation.phases.clear();
            return true;
        }
        let left: Vec<f64> = self
            .allocation
            .phases
            .iter()
            .copied()
            .filter(|&p| p >= serial)
            .collect();
        if left.len() < budget {
            return false;
        }
        self.allocation.phases = left[..budget].to_vec();
        true
    }

    fn effect(&mut self, x: f64, y: f64, kind: f64, radius: f64) {
        op(&mut self.log, OP_EFFECT, &[self.serial, x, y, kind, radius]);
        self.serial += 1.0;
    }

    fn line_clear(&self, a: (f64, f64), b: (f64, f64)) -> bool {
        line_clear(self.index, self.gates, a, b).0
    }

    /// A ground record as this run has left it.
    fn current(&self, g: &Ground) -> Ground {
        let mut g = g.clone();
        if let Some((_, item)) = self.item_writes.iter().rev().find(|w| w.0 == g.id) {
            g.item = item.clone();
        }
        g
    }

    /// `gatesNear` over the gate set's own buckets, which are `gateIndex`'s: the gates whose boxes may touch the box
    /// within `GATE_REACH` of `at`, in map order, as they stand now.
    fn gates_near(&mut self, at: (f64, f64)) -> Vec<Gate> {
        if !at.0.is_finite() || !at.1.is_finite() {
            return Vec::new();
        }
        let mut found = Vec::new();
        let set = &mut *self.gates;
        set.visited.begin();
        let (grid, visited) = (&set.grid, &mut set.visited);
        grid.each_cell_in(
            at.0 - GATE_REACH,
            at.1 - GATE_REACH,
            at.0 + GATE_REACH,
            at.1 + GATE_REACH,
            |list| {
                for &i in list {
                    if visited.first(i as usize) {
                        found.push(i as usize);
                    }
                }
            },
        );
        found.sort_unstable();
        found
            .into_iter()
            .map(|index| {
                let [x, y, door] = self.gates.details[index];
                Gate {
                    index,
                    x,
                    y,
                    door: door != 0.0,
                    locked: match self.gates.locked[index] {
                        0 => f64::NAN,
                        1 => 1.0,
                        _ => 0.0,
                    },
                    open: self.gates.open[index] != 0,
                }
            })
            .collect()
    }

    fn set_charging(&mut self, a: &mut Actor, charger: f64) {
        a.charging = charger;
        op(&mut self.log, OP_CHARGING, &[a.p.roster as f64, charger]);
    }

    fn interact(&mut self, a: &mut Actor) -> Result<Stop, (i32, f64)> {
        let ticks = self.h[CHARGE_TICKS];
        let cell = carried_cell(&a.p);
        let charged = a.p.inventory.as_ref().and_then(|inv| {
            inv.iter().position(|i| {
                i.as_ref()
                    .is_some_and(|i| i.kind == KIND_CELL && i.charge >= ticks)
            })
        });
        let at = (a.p.x, a.p.y);
        let exit = (self.h[EXIT_X], self.h[EXIT_Y]);
        if a.p.role == 0.0
            && distance(at, exit) < EXTRACTION_REACH
            && self.slots > 0.0
            && let Some(slot) = charged
            && self.line_clear(at, exit)
        {
            self.slots -= 1.0;
            a.p.inventory.as_mut().unwrap()[slot] = None;
            sync_weapon(&mut a.p, self.rules);
            a.charging = -1.0;
            a.p.status = STATUS_ESCAPED;
            self.players[a.p.roster].status = STATUS_ESCAPED;
            op(
                &mut self.log,
                OP_ESCAPE,
                &[
                    a.p.roster as f64,
                    slot as f64,
                    a.p.weapon,
                    self.serial,
                    self.slots,
                ],
            );
            self.serial += 1.0;
            return Ok(None);
        }
        if let Some(c) = cell
            && a.p.inventory.as_ref().unwrap()[c].as_ref().unwrap().charge < ticks
            && let Some(station) = (0..self.chargers.len()).find(|&i| {
                let st = (self.chargers[i][0], self.chargers[i][1]);
                distance(at, st) < CHARGE_REACH && self.line_clear(at, st)
            })
        {
            self.set_charging(a, station as f64);
            return Ok(None);
        }
        let full =
            a.p.inventory
                .as_ref()
                .is_some_and(|i| i.iter().all(Option::is_some));
        if !a.bot && full {
            let mut candidates: Vec<Ground> = a
                .swap
                .iter()
                .map(|g| self.current(g))
                .filter(|g| {
                    (0.0..=3.0).contains(&g.item.kind)
                        && distance(at, (g.x, g.y)) < PICKUP_REACH
                        && reach_clear(self.index, self.gates, at, (g.x, g.y)).0
                        && (!g.mine || !later(g.pickup_after, self.tick))
                })
                .collect();
            candidates.sort_by(|x, y| {
                order(
                    distance(at, (x.x, x.y)) - distance(at, (y.x, y.y)),
                    x.rank.total_cmp(&y.rank),
                )
            });
            if let Some(pickup) = candidates.into_iter().next() {
                return self.swap(a, pickup);
            }
        }
        // The nearest gate takes the interaction even when it cannot be used; it never falls through to transit.
        let mut near: Vec<Gate> = Vec::new();
        for g in self.gates_near(at) {
            if distance(at, (g.x, g.y)) < GATE_REACH && (!a.bot || !g.open) {
                // `lineClear` ignoring this gate: written open for the query.
                let was = self.gates.open[g.index];
                self.gates.open[g.index] = 1;
                let clear = self.line_clear(at, (g.x, g.y));
                self.gates.open[g.index] = was;
                if clear {
                    near.push(g);
                }
            }
        }
        near.sort_by(|x, y| {
            order(
                distance(at, (x.x, x.y)) - distance(at, (y.x, y.y)),
                std::cmp::Ordering::Equal,
            )
        });
        if let Some(gate) = near.first().copied() {
            let locked = if gate.locked.is_nan() {
                !gate.door
            } else {
                gate.locked != 0.0
            };
            if !gate.open && (!locked || a.keys > 0.0) {
                if locked {
                    a.keys -= 1.0;
                }
                if locked {
                    self.gates.locked[gate.index] = 2;
                }
                self.gates.open[gate.index] = 1;
                op(
                    &mut self.log,
                    OP_GATE,
                    &[
                        a.p.roster as f64,
                        gate.index as f64,
                        1.0,
                        f64::from(u8::from(locked)),
                    ],
                );
            } else if gate.open && gate.door && !a.bot {
                let [bx, by, bw, bh] = self.gates.boxes[gate.index];
                // Players are tested directly as well as bodies: a transit earlier this phase has moved
                // its player but not yet its body.
                let occupied = self.players.iter().any(|o| {
                    o.status == STATUS_ACTIVE
                        && hypot(
                            o.x - js_max(bx, js_min(bx + bw, o.x)),
                            o.y - js_max(by, js_min(by + bh, o.y)),
                        ) < o.radius
                }) || self.world.overlaps_dynamic_box(
                    bw / 2.0,
                    bh / 2.0,
                    bx + bw / 2.0,
                    by + bh / 2.0,
                );
                if !occupied {
                    self.gates.open[gate.index] = 0;
                    op(
                        &mut self.log,
                        OP_GATE,
                        &[a.p.roster as f64, gate.index as f64, 0.0, 0.0],
                    );
                }
            }
            // Trying a door shows how it stands, locked or not (22.6, "Doors").
            if a.discovery {
                op(
                    &mut self.log,
                    OP_OBSERVE,
                    &[a.p.roster as f64, gate.index as f64],
                );
            }
            return Ok(None);
        }
        if a.p.role == 1.0 {
            return Ok(self.transit(a, f64::NAN, STEP_TRANSIT));
        }
        Ok(None)
    }

    /// `swapInstanceEquipment`: the pickup is staged into a draft of the player, the outgoing item's
    /// drop planned around the ground without the pickup; only a complete swap commits.
    fn swap(&mut self, a: &mut Actor, pickup: Ground) -> Result<Stop, (i32, f64)> {
        let slot = if a.p.selected.is_nan() {
            0.0
        } else {
            a.p.selected
        };
        let inventory = a.p.inventory.as_ref().unwrap();
        let Some(outgoing) = (slot >= 0.0 && slot.fract() == 0.0)
            .then(|| inventory.get(slot as usize).cloned().flatten())
            .flatten()
        else {
            return Ok(None);
        };
        let mut draft = a.p.clone();
        draft.inventory.as_mut().unwrap()[slot as usize] = None;
        let mut incoming = pickup.clone();
        let mut staged = self.allocation.clone();
        let capacity = [
            self.h[RESERVE_CAPACITY],
            self.h[RESERVE_CAPACITY + 1],
            self.h[RESERVE_CAPACITY + 2],
        ];
        if !collect_equipment(
            &mut draft,
            &mut incoming,
            self.rules,
            &capacity,
            &mut staged,
        )? {
            return Ok(None);
        }
        let disks: Vec<Disk> = self
            .players
            .iter()
            .filter(|o| o.status == STATUS_ACTIVE)
            .map(|o| [o.x, o.y, o.radius])
            .collect();
        let taken: Vec<[f64; 2]> = a
            .swap_taken
            .iter()
            .filter(|t| t[0] != pickup.id)
            .map(|t| [t[1], t[2]])
            .collect();
        let ground_ids: Vec<f64> = a
            .swap_ground
            .iter()
            .copied()
            .filter(|&id| id != pickup.id)
            .collect();
        let carried_ids: Vec<f64> = self
            .carried
            .iter()
            .filter(|c| c[0] != outgoing.token)
            .map(|c| c[1])
            .collect();
        let mut ctx = Context {
            world: self.world,
            map: self.map,
            index: self.index,
            gates: self.gates,
            actors: &disks,
            taken: &taken,
            ground_ids: &ground_ids,
            carried_ids: &carried_ids,
            ground_count: (self.h[GROUND_COUNT] as usize).saturating_sub(1),
        };
        let Some(plan) = drop_planner::plan_drop(
            &mut ctx,
            self.rules,
            (a.p.x, a.p.y),
            &outgoing,
            false,
            &staged,
        ) else {
            return Ok(None);
        };
        let released = usize::from(pickup.body);
        let reserve = self.h[RESERVE_ACTORS] as usize;
        if !self
            .world
            .can_add_bodies(plan.records.len().saturating_sub(released) + reserve)
        {
            return Ok(None);
        }
        self.allocation = plan.allocation.clone();
        a.p.inventory = draft.inventory;
        a.p.selected = draft.selected;
        a.p.reserves = draft.reserves;
        a.charging = -1.0;
        sync_weapon(&mut a.p, self.rules);
        let mut row = vec![a.p.roster as f64, pickup.id];
        inventory_row(&mut row, &a.p);
        row.push(plan.records.len() as f64);
        for r in &plan.records {
            row.extend_from_slice(&r.item.row());
            row.extend_from_slice(&[r.id, r.x, r.y, r.family]);
        }
        op(&mut self.log, OP_SWAP, &row);
        self.stop = Some(StopKind::Swap {
            pickup: pickup.id,
            records: plan.records,
        });
        Ok(Some(STEP_TRANSIT))
    }

    /// `transit`: to the chosen station (NaN: the next ahead; -1: none known). A delayed transit takes
    /// the gladiator out of the world; an instant one lands now and stops the call at `resume`.
    fn transit(&mut self, a: &mut Actor, choice: f64, resume: u32) -> Stop {
        if a.p.role != 1.0 || a.p.status != STATUS_ACTIVE || a.rail_cd != 0.0 {
            return None;
        }
        let at = (a.p.x, a.p.y);
        let from = self
            .stations
            .iter()
            .position(|st| distance(at, (st[0], st[1])) < TRANSIT_REACH)?;
        let wall = self.h[HAZARD_X] + TILE;
        let ahead: Vec<usize> = (0..self.stations.len())
            .filter(|&i| self.stations[i][0] > wall && i != from)
            .collect();
        let next = ahead
            .iter()
            .copied()
            .find(|&i| self.stations[i][0] > a.p.x + TILE)
            .or_else(|| ahead.first().copied())?;
        let to = if choice.is_nan() {
            next
        } else {
            ahead.iter().copied().find(|&i| i as f64 == choice)?
        };
        let station = (self.stations[to][0], self.stations[to][1]);
        let admitted: Vec<Disk> = self
            .players
            .iter()
            .enumerate()
            .filter(|(i, o)| *i != a.p.roster && o.status == STATUS_ACTIVE)
            .map(|(_, o)| [o.x, o.y, o.radius])
            .collect();
        let radius = self.rules.radii[1];
        let landing = placement(self.world, self.map, self.gates, radius, station, &admitted)?;
        self.effect(a.p.x, a.p.y, EFFECT_RAIL, 60.0);
        op(&mut self.log, OP_ROUTE, &[a.p.roster as f64]);
        let ticks = if self.h[TRANSIT_TIME] != 0.0 {
            js_max(
                0.0,
                js_round(self.h[TRANSIT_BASE] + self.h[TRANSIT_PER_UNIT] * distance(at, station)),
            )
        } else {
            0.0
        };
        if ticks > 0.0 {
            a.p.status = STATUS_TRANSIT;
            self.players[a.p.roster].status = STATUS_TRANSIT;
            a.charging = -1.0;
            op(
                &mut self.log,
                OP_TRANSIT,
                &[a.p.roster as f64, to as f64, self.tick + ticks],
            );
            return None;
        }
        a.p.x = landing.0;
        a.p.y = landing.1;
        a.rail_cd = RAIL_COOLDOWN;
        self.players[a.p.roster].x = landing.0;
        self.players[a.p.roster].y = landing.1;
        op(
            &mut self.log,
            OP_LAND,
            &[a.p.roster as f64, landing.0, landing.1, RAIL_COOLDOWN],
        );
        self.effect(landing.0, landing.1, EFFECT_RAIL, 60.0);
        self.stop = Some(StopKind::Land);
        Some(resume)
    }

    fn charging(&mut self, a: &mut Actor) {
        if a.charging == -1.0 {
            return;
        }
        let ticks = self.h[CHARGE_TICKS];
        let at = (a.p.x, a.p.y);
        let cell = carried_cell(&a.p);
        let station = (a.charging >= 0.0).then(|| {
            let st = self.chargers[a.charging as usize];
            (st[0], st[1])
        });
        let charge = cell.map(|c| a.p.inventory.as_ref().unwrap()[c].as_ref().unwrap().charge);
        if cell.is_none()
            || charge.unwrap() >= ticks
            || a.moved
            || station.is_none_or(|st| distance(at, st) >= CHARGE_REACH || !self.line_clear(at, st))
        {
            self.set_charging(a, -1.0);
            return;
        }
        let c = cell.unwrap();
        let item = a.p.inventory.as_mut().unwrap()[c].as_mut().unwrap();
        // `++cell.charge`: an absent charge becomes NaN.
        item.charge = if item.missing(ABSENT_CHARGE) {
            f64::NAN
        } else {
            item.charge + 1.0
        };
        item.absent &= !ABSENT_CHARGE;
        let charge = item.charge;
        op(
            &mut self.log,
            OP_CELL,
            &[a.p.roster as f64, c as f64, charge],
        );
        if charge >= ticks {
            self.set_charging(a, -1.0);
            op(&mut self.log, OP_CHARGED, &[a.p.roster as f64, self.serial]);
            self.serial += 1.0;
            self.effect(a.p.x, a.p.y, EFFECT_CHARGE, 70.0);
        }
    }

    fn inventory(&mut self, p: &Player) {
        let mut row = vec![p.roster as f64];
        inventory_row(&mut row, p);
        op(&mut self.log, OP_INVENTORY, &row);
    }

    /// `automaticPickups`; returns whether a record was taken whole, which stops the call.
    fn pickups(&mut self, a: &mut Actor) -> Result<Stop, (i32, f64)> {
        if a.p.role != 0.0 {
            return Ok(None);
        }
        let capacity = [
            self.h[RESERVE_CAPACITY],
            self.h[RESERVE_CAPACITY + 1],
            self.h[RESERVE_CAPACITY + 2],
        ];
        let at = (a.p.x, a.p.y);
        let near = std::mem::take(&mut a.near);
        for (index, listed) in near.iter().enumerate() {
            let item = self.current(listed);
            if distance(at, (item.x, item.y)) > AUTOMATIC_REACH
                || !reach_clear(self.index, self.gates, at, (item.x, item.y)).0
                || item.mine && item.pickup_after > self.tick
                || a.bot && item.item.kind == KIND_CELL && carried_cell(&a.p).is_some()
            {
                continue;
            }
            let mut draft = item.clone();
            let kind = item.item.kind;
            if kind == KIND_ACCESS {
                a.keys += 1.0;
                op(&mut self.log, OP_KEYS, &[a.p.roster as f64, a.keys]);
            }
            let before = a.p.clone();
            let taken = if kind == KIND_AMMO {
                let taken = collect_ammo(
                    &mut a.p,
                    &mut draft,
                    self.rules,
                    &capacity,
                    &self.allocation,
                );
                if a.p.reserves != before.reserves {
                    self.inventory(&a.p);
                }
                Some(taken)
            } else if (0.0..=3.0).contains(&kind) {
                let taken = collect_equipment(
                    &mut a.p,
                    &mut draft,
                    self.rules,
                    &capacity,
                    &mut self.allocation,
                );
                if !same_player(&before, &a.p) {
                    self.inventory(&a.p);
                }
                Some(taken?)
            } else {
                None
            };
            if taken == Some(false) {
                if !same_item(&draft.item, &item.item) {
                    self.item_writes.push((item.id, draft.item.clone()));
                    let field = if draft.item.ammo.to_bits() != item.item.ammo.to_bits()
                        || (draft.item.absent ^ item.item.absent) & ABSENT_AMMO != 0
                    {
                        (0.0, draft.item.ammo)
                    } else {
                        (1.0, draft.item.count)
                    };
                    op(&mut self.log, OP_ITEM, &[item.id, field.0, field.1]);
                    if self.in_run.is_some() {
                        self.write_partial(item.id, field);
                    }
                }
                continue;
            }
            if kind == KIND_CELL {
                op(&mut self.log, OP_ROUTE, &[a.p.roster as f64]);
            }
            self.effect(a.p.x, a.p.y, EFFECT_LOOT, 30.0);
            op(&mut self.log, OP_REMOVE, &[a.p.roster as f64, item.id]);
            self.stop = Some(StopKind::Pickup {
                id: item.id,
                listed: near[index + 1..].to_vec(),
            });
            return Ok(Some(STEP_PICKUPS));
        }
        if !a.sneak
            && !truthy(a.p.cloak)
            && self
                .sensors
                .iter()
                .any(|s| distance(at, (s[0], s[1])) < SENSOR_REACH)
        {
            op(&mut self.log, OP_REVEALED, &[a.p.roster as f64, 65.0]);
        }
        Ok(None)
    }
}

fn same_item(a: &Item, b: &Item) -> bool {
    a.row()
        .iter()
        .zip(b.row())
        .all(|(x, y)| x.to_bits() == y.to_bits())
}

fn same_player(a: &Player, b: &Player) -> bool {
    a.selected.to_bits() == b.selected.to_bits()
        && a.weapon.to_bits() == b.weapon.to_bits()
        && a.reserves == b.reserves
        && match (&a.inventory, &b.inventory) {
            (Some(x), Some(y)) => {
                x.len() == y.len()
                    && x.iter().zip(y).all(|(x, y)| match (x, y) {
                        (Some(x), Some(y)) => same_item(x, y),
                        (None, None) => true,
                        _ => false,
                    })
            }
            (None, None) => true,
            _ => false,
        }
}

impl PhaseSix {
    pub fn run(
        &mut self,
        rules: &Rules,
        world: &mut World,
        map: &mut CollisionMap,
        index: &SightIndex,
        gates: &mut GateSet,
        swept: Option<&SweptMap>,
    ) {
        let input = std::mem::take(&mut self.input);
        let mut h = [0.0; HEADER];
        h.copy_from_slice(&input[..HEADER]);
        let mut r = Reader {
            v: &input,
            at: HEADER,
        };
        let mut actors: Vec<Actor> = (0..h[ACTORS] as usize)
            .map(|_| read_actor(&mut r))
            .collect();
        // The store's fields come from the core's player store (#1214 stage 6c.3b): only those the adapter packed before,
        // so the fields phase 6 never read stay as they were. The adapter leaves those words 0.
        let store = &world.players;
        for a in &mut actors {
            let (s, e) = (&store.rows[a.p.roster], &store.extra[a.p.roster]);
            (a.p.role, a.p.status, a.p.x, a.p.y, a.p.cloak, a.rail_cd) =
                (s.role, s.status, s.x, s.y, e.cloak, e.rail_cd);
            // The equipment too (6c.3c.2): selection, weapon, keys, charging and reserves, and the inventory where the
            // adapter asked for it. A reload is not phase 6's, so it stays absent, as the adapter packed it.
            let q = &store.equip[a.p.roster];
            (a.p.selected, a.p.weapon, a.p.reserves, a.keys, a.charging) =
                (q.selected, q.weapon, q.reserves, q.keys, q.charging);
            if a.inventory_from_store {
                a.p.inventory = q.inventory.clone();
            }
        }
        for a in &mut actors {
            read_ground(a, world);
        }
        let store = &world.players;
        let players = (0..h[PLAYERS] as usize)
            .map(|i| {
                let a: [f64; PLAYER_ROW] = r.row();
                let s = &store.rows[i];
                Other {
                    status: s.status,
                    x: s.x,
                    y: s.y,
                    radius: a[3],
                }
            })
            .collect();
        let stations = (0..h[STATIONS] as usize).map(|_| r.row()).collect();
        let chargers = (0..h[CHARGERS] as usize).map(|_| r.row()).collect();
        let sensors = (0..h[SENSORS] as usize).map(|_| r.row()).collect();
        let phases = r.vec(h[PHASES] as usize);
        let registered = r.vec(h[KNOWN] as usize);
        let carried = (0..h[CARRIED] as usize).map(|_| r.row()).collect();
        if h[GATE_DETAILS] > 0.0 {
            gates.details = (0..h[GATE_DETAILS] as usize).map(|_| r.row()).collect();
        }
        let in_run = (h[IN_RUN] != 0.0).then(|| {
            let [capacity, roster, drop_speed, swaps, markers] = r.row();
            world.markers = r.vec(markers as usize).iter().map(|&k| k as u32).collect();
            let swaps = swaps != 0.0;
            let phase_keys = if swaps {
                phases.iter().copied().zip(r.vec(phases.len())).collect()
            } else {
                Vec::new()
            };
            let carried_keys = if swaps {
                let carried: &Vec<[f64; 2]> = &carried;
                carried
                    .iter()
                    .map(|c| c[0])
                    .zip(r.vec(carried.len()))
                    .collect()
            } else {
                Vec::new()
            };
            InRun {
                swept: swept.expect("a run that syncs inside itself needs the swept map"),
                capacity,
                roster,
                drop_speed,
                swaps,
                phase_keys,
                carried_keys,
            }
        });
        // A run that syncs inside itself decides what each actor reads, as the adapter did (6d.6c.2).
        if in_run.is_some() {
            for a in &mut actors {
                let rest = a.rested.then(|| std::mem::take(&mut a.near));
                prepare(a, world, rest);
            }
        }
        let mut run = Run {
            rules,
            world,
            map,
            index,
            gates,
            tick: h[TICK],
            serial: h[SERIAL],
            slots: h[SLOTS],
            allocation: Allocation {
                item_serial: h[ITEM_SERIAL],
                scatter_serial: h[SCATTER_SERIAL],
                phases,
                registered,
                facts: Vec::new(),
            },
            log: Vec::new(),
            players,
            stations,
            chargers,
            sensors,
            carried,
            item_writes: Vec::new(),
            h,
            in_run,
            stop: None,
        };
        let tick_mode = h[MODE] == 0.0;
        let mut resume = (-1.0, 0.0);
        let mut error = (0.0, 0.0);
        let first = h[RESUME_ACTOR] as usize;
        let mut cursor = 0;
        let (mut i, mut from) = (first, h[RESUME_STEP] as u32);
        'actors: while i < actors.len() {
            let mut resumed = None;
            for step in [STEP_INTERACT, STEP_TRANSIT, STEP_CHARGING, STEP_PICKUPS] {
                let a = &mut actors[i];
                if step < from || a.steps & step == 0 {
                    continue;
                }
                // Dead, extracted or departed actors cannot charge or pick up.
                if tick_mode && step >= STEP_CHARGING && a.p.status != STATUS_ACTIVE {
                    break;
                }
                let stop = match step {
                    STEP_INTERACT => run.interact(a),
                    STEP_TRANSIT => Ok(run.transit(a, a.choice, STEP_CHARGING)),
                    STEP_CHARGING => {
                        run.charging(a);
                        Ok(None)
                    }
                    _ => run.pickups(a),
                };
                match stop {
                    Ok(Some(next)) if run.in_run.is_some() => {
                        let kind = run.stop.take().expect("a stop's kind");
                        match run.carry_out(kind, &mut actors, i, &mut cursor) {
                            Carried::Continued => {}
                            Carried::Stopped => {
                                resume = (i as f64, f64::from(next));
                                break 'actors;
                            }
                            Carried::Refused => break 'actors,
                        }
                        resumed = Some(next);
                        break;
                    }
                    Ok(Some(next)) => {
                        resume = (i as f64, f64::from(next));
                        break 'actors;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        error = (f64::from(e.0), e.1);
                        break 'actors;
                    }
                }
            }
            // A stop carried out inside the run resumes the same actor at its next step; otherwise the next actor.
            match resumed {
                Some(next) => from = next,
                None => (i, from) = (i + 1, 0),
            }
        }
        // The facts reach the player store (#1214 stage 6c.2), those a stop has not applied already.
        run.world.players.apply_interaction_log(&run.log[cursor..]);
        let mut out = std::mem::take(&mut self.output);
        out.clear();
        out.extend_from_slice(&[
            0.0,
            run.serial,
            run.allocation.item_serial,
            run.allocation.scatter_serial,
            resume.0,
            resume.1,
            run.slots,
            run.allocation.facts.len() as f64,
            run.log.len() as f64,
            error.0,
            error.1,
        ]);
        for a in &run.allocation.facts {
            out.extend_from_slice(a);
        }
        out.extend_from_slice(&run.log);
        out[0] = out.len() as f64;
        self.output = out;
        self.input = input;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        Rules {
            weapons: vec![crate::action_types::Weapon {
                ammo: 12.0,
                max_ammo: 24.0,
                cooldown: 0.0,
                speed: 0.0,
                life: 0.0,
                damage: 0.0,
                spread: Vec::new(),
                reload: None,
                hearing: 0.0,
            }],
            ground_capacity: 100.0,
            reloading: false,
            quality_damage: Vec::new(),
            kit_cooldown: Vec::new(),
            kit_damage: Vec::new(),
            acceleration: 0.0,
            braking: 0.0,
            surfaces: Vec::new(),
            radii: [10.0, 14.0],
            loot_radius: 6.0,
            hearing_ticks: 0.0,
            discovery_cell: 40.0,
            map_width: 1000.0,
            map_height: 1000.0,
            hook_cooldown: 0.0,
            hz: 20.0,
            movement: [0.0; 6],
            utility: [0.0; 3],
        }
    }

    fn item(kind: f64, count: f64) -> Item {
        Item {
            kind,
            weapon: f64::NAN,
            ammo: f64::NAN,
            count,
            charge: f64::NAN,
            instance: f64::NAN,
            lineage: f64::NAN,
            quality: f64::NAN,
            token: 0.0,
            absent: ABSENT_AMMO
                | ABSENT_CHARGE
                | ABSENT_INSTANCE
                | ABSENT_LINEAGE
                | ABSENT_QUALITY
                | ABSENT_WEAPON,
        }
    }

    fn player(inventory: Vec<Option<Item>>) -> Player {
        Player {
            roster: 0,
            key: 0,
            role: 0.0,
            status: 0.0,
            kit: 0,
            x: 0.0,
            y: 0.0,
            heading: 0.0,
            hp: 0.0,
            max_hp: 0.0,
            shield: 0.0,
            selected: 0.0,
            weapon: 0.0,
            attack_cd: 0.0,
            cooldown: 0.0,
            cloak: 0.0,
            revealed: 0.0,
            boost: 0.0,
            stun: 0.0,
            level: 0.0,
            inventory: Some(inventory),
            reserves: None,
            reload: None,
            retired: Vec::new(),
        }
    }

    fn ground(id: f64, item: Item) -> Ground {
        Ground {
            id,
            x: 0.0,
            y: 0.0,
            mine: false,
            pickup_after: f64::NAN,
            family: -1.0,
            body: false,
            rank: 0.0,
            item,
        }
    }

    fn allocation() -> Allocation {
        Allocation {
            item_serial: 10.0,
            scatter_serial: 0.0,
            phases: vec![0.0, 1.0, 2.0],
            registered: vec![1.0, 2.0],
            facts: Vec::new(),
        }
    }

    #[test]
    fn a_large_stack_is_split_into_a_new_identity() {
        let mut carried = item(1.0, 1.0);
        carried.instance = 1.0;
        carried.lineage = 1.0;
        carried.absent &= !(ABSENT_INSTANCE | ABSENT_LINEAGE);
        let mut p = player(vec![Some(carried), None, None, None, None, None]);
        // The carried stack takes two of five, then the first empty slot three, under a new ID.
        let mut g = ground(2.0, item(1.0, 5.0));
        g.item.absent &= !ABSENT_COUNT;
        let mut alloc = allocation();
        let taken = collect_equipment(&mut p, &mut g, &rules(), &[0.0; 3], &mut alloc);
        assert_eq!(taken, Ok(false));
        assert_eq!(
            p.inventory.as_ref().unwrap()[0].as_ref().unwrap().count,
            3.0
        );
        assert_eq!(g.item.count, 3.0);
        let taken = collect_equipment(&mut p, &mut g, &rules(), &[0.0; 3], &mut alloc);
        assert_eq!(taken, Ok(true), "three fit the empty slot");
        let new = p.inventory.as_ref().unwrap()[1].as_ref().unwrap();
        assert_eq!(
            (new.count, new.instance, new.lineage, new.token),
            (3.0, 2.0, 2.0, -1.0)
        );
    }

    #[test]
    fn a_ground_stack_count_is_not_capped_but_a_carried_one_is() {
        let r = rules();
        let mut g = ground(2.0, item(1.0, 9.0));
        g.item.absent &= !ABSENT_COUNT;
        assert!(valid_ground_payload(&g, &r));
        assert!(!valid_payload(&g.item, &r));
        g.item.absent |= ABSENT_COUNT;
        g.item.count = f64::NAN;
        assert!(valid_ground_payload(&g, &r), "an absent count reads as one");
    }
}
