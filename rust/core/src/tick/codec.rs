//! The word layout between the new tick and JavaScript (27.2 "Live adapter (3d.1)"), and the live
//! match the WASM exports wrap. `shared/simulation/tick-codec.ts` mirrors this file: this module is
//! the layout's one owner.
//!
//! # Rules
//!
//! Everything is a flat `f64` word (27, rule 1).
//! - Integers are exact. A `u64` that is a sequence number, an event ID or a revision stays at or
//!   below 2^53, and a debug build asserts it. A `u32` or smaller reads back through a range check.
//! - A bool is 0 or 1. Any other word is a decode error.
//! - A row is fixed length per kind, with a `pub const` stride. An absent optional or enum payload
//!   is zero padded, so a reader steps by stride.
//! - An **Option** is a presence word, then its words (zeros when absent).
//! - Every word is finite. No NaN or infinity stands for a missing value, and a decoder refuses
//!   one wherever it appears.
//! - An **enum** is a tag word, then its payload padded to the widest variant. The tag numbers are
//!   the variants' declaration order, except where a table below says otherwise.
//! - A **section** is a count word, then that many rows.
//! - An **actor** is one word, [`actor_word`](super::actor_word): `(kind << 32) | seat`.
//! - An **entity** is `(tag, value)`, a **body** the same with the tags that name a body.
//!   Entity tags: Actor 0 (value: actor word), Item 1, Projectile 2, Hook 3, Gate 4, Trap 5,
//!   Station 6, Prop 7, Geometry 8, Match 9 (value 0). A body uses Actor, Item, Gate, Prop and
//!   Geometry, with the same numbers.
//! - A **point** is `x, y`.
//! - **Fieldless enums** are the index in their declaration order: presence (Pending, Active,
//!   Eliminated, Escaped, Transit, Stranded), kit (Warden, Specter, Striker, Hook), weapon (Pistol,
//!   Rifle, Scattergun), ammo family (Pistol, Rifle, Shell), utility (Medkit, Shield), station kind
//!   (Charging, Transit), command source (Player, Bot), contact kind (Started, Stopped), hook
//!   release (Cancelled, Expired, Obstructed, FriendlyContact, Range, Standoff, Separation,
//!   EndpointGone, Relocated).
//!
//! # State rows
//!
//! | Row | Stride | Words |
//! | --- | --- | --- |
//! | Equipment | [`EQUIPMENT_WORDS`] 4 | tag (Firearm 0, Stack 1, Cell 2), p1, p2, quality. Firearm: weapon, rounds. Stack: utility, count. Cell: charge, 0 |
//! | Inventory | [`INVENTORY_WORDS`] 51 | 6 slots of (present, id, lineage, equipment) = 42, selected, 3 reserves, keys, reload option (present, slot, item, ready_at) |
//! | Loot | [`LOOT_WORDS`] 5 | tag (AccessKey 0, Equipment 1, Ammo 2), then equipment (4), or family and count, zero padded |
//! | Actor | [`ACTOR_STRIDE`] 93 | actor word, presence, kit option (2), level, kills, hp, max_hp, shield, max_shield, aim, sneak, view_lag, inventory (51), charging option (present, station, cell), respawn_at option (2), transit option (present, destination, origin x, y, arrive_at), bot, aggression option (present, source actor word, expires_at), deadlines (skill, weapon, transit), statuses (Boost, Cloak, Reveal, Stun: each present, active_from, expires_at) |
//! | Ground item | [`ITEM_STRIDE`] 14 | id, loot (5), lineage option (2), unplaced_at option (3), dropped_by option (2), pickup_ready_at |
//! | Projectile | [`PROJECTILE_STRIDE`] 10 | id, source entity (2), position, velocity, damage, active_from, expires_at |
//! | Hook | [`HOOK_STRIDE`] 9 | id, owner, phase tag (Flying 0, Pulling 1), payload (5: Flying position, direction, travelled; Pulling target actor word, length), expires_at |
//! | Gate | [`GATE_STRIDE`] 6 | id, open, locked, door, position |
//! | Trap | [`TRAP_STRIDE`] 10 | id, position, heading, ready_at, kind tag (Mine 0, Turret 1, Flame 2, Spider 3), payload (4: Mine spent; Turret aiming; Flame offset, warning, firing; Spider home (2), target option (2)) |
//! | Station | [`STATION_STRIDE`] 4 | id, kind, position |
//! | Extraction option | [`EXTRACTION_WORDS`] 4 | present, position, slots |
//!
//! # State tables
//!
//! The one table encoding, shared by setup, the change list and the snapshot: actors, ground
//! items, projectiles, hooks, gates, traps and stations (each a section), the extraction option,
//! the sensors (a section of points) and the `hazard_x` option. A snapshot's tables therefore decode as a
//! valid setup's tables.
//!
//! # Setup
//!
//! `seed_high, seed_low` (two `u32` words), `time_limit`, the state tables, then
//! - **bodies**, a section of rows: body (2 words), kind, map geometry, shape, a, b,
//!   `x, y, angle, vx, vy, omega`, mass, friction, restitution, the linear and angular damping
//!   options (2 each), groups, loot, speed limit, tip radius, vertex count, then the vertices'
//!   `x, y`. This is the one variable-length row ([`BODY_HEADER`] 25
//!   words before the vertices), so a reader steps by its own count. The loot word is derived on
//!   encode (a prop in the loot group) and ignored on decode, which derives it again;
//! - **motor surfaces**, a section of [`SURFACE_ROW`] 11 words: key, priority, origin, size, speed,
//!   traction, braking, drag option (2);
//! - **floor drag bases**: loot linear, loot angular, prop linear, prop angular (4);
//! - **hazard areas**, a section of boxes `x, y, w, h`;
//! - the **wall** option: present, `map_width`, `grace_ticks` (3);
//! - the **bounds** option: present, `min x, min y, max x, max y` (5);
//! - the **tuning** ([`TUNING_WORDS`] words, no section): motor (`base_speed` 2, `boost` 2, stun,
//!   sneak, acceleration, braking), hook (range, speed, max force, stiffness, damping, pull speed,
//!   duration, cooldown, standoff, target distance, break distance), boost duration and cooldown,
//!   three weapons (damage, speed, life, cooldown, spread count, then [`MAX_SPREAD`] spread words),
//!   four melee damages, Warden, Specter and respawn ticks, the hearing option (present, three
//!   ranges, ticks, width, height), item rules (reloading, quality damage, ground, optional and
//!   body capacity, drop reserve), interaction rules (charge ticks, transit base, transit per unit), then mine
//!   (trigger, blast, damage, world impulse, actor impulse limit), turret (range, cooldown, speed,
//!   damage, life), flame (cycle, warn, fire, interval, range, cone, damage) and spider (leash,
//!   acquire, step, grapple, cooldown, stun, damage).
//!
//! Spread is a count word plus a fixed [`MAX_SPREAD`] of 8 words, not a count-prefixed list, so the
//! tuning stays one fixed-length block a reader can step over. A weapon with more entries fails to
//! encode.
//!
//! **Motor surface IDs.** `MotorSurface.id` is a string, and only the order it gives matters:
//! equal priorities tie by the UTF-16 order of the ID (`surface_order`). JavaScript supplies each
//! surface's *rank* in that order as the key word, so no string crosses and the order is
//! preserved. Decode rebuilds the ID as the key zero padded to ten digits, which sorts the same way
//! as the number.
//!
//! # Outputs
//!
//! | Value | Words |
//! | --- | --- |
//! | Snapshot | tick, state tables, poses (a section of [`POSE_STRIDE`] 4: body, position) |
//! | Changes | actors, items, projectiles, hooks, gates, traps (sections of the state rows), extraction option, `hazard_x` option (present, value), removed (a section of entities), poses, events (a section of [`EVENT_STRIDE`] 9) |
//! | Event | id, tick, fact tag, fact payload ([`FACT_PAYLOAD`] 6) |
//! | Inbound | [`INBOUND_STRIDE`] 32: tag (Command 0, Observation 1, Carried 2), payload (31) |
//! | Command payload | actor, source, tick, seq, input ([`INPUT_WORDS`] 27) |
//! | Observation payload | tag (ViewLag 0, InputLead 1, Join 2, Leave 3, Teleport 4), then actor and ticks; actor; actor; body and `to` |
//! | Carried payload | tag (Impulse 0, KillReward 1, GateObserved 2), then body and impulse; actor; actor, gate, open, locked |
//! | Input | movement, aim option (2), sneak, attack, utility slot option (2), skill, interact, target option (present, tag Extraction 0, Station 1, Gate 2, Item 3, value), slot option (2), move slot option (present, from, to), drop option (present, tag Selected 0 or Slot 1, slot), reload, drop-ammo option (present, family, count), transit option (2) |
//! | Discontinuity | [`DISCONTINUITY_STRIDE`] 3: tag (Placed 0, Warped 1, Removed 2), body |
//! | Gate observation | [`GATE_OBSERVATION_STRIDE`] 4: actor, gate, open, locked |
//! | Discovery sample | [`SAMPLE_STRIDE`] 3: actor, eye |
//! | Discovery | a section of gate observations, a section of samples |
//! | Completed tick | tick, inbound section, changes, discontinuities section, discovery. The solved paths stay in Rust |
//! | Memory | presence word (0 for no memory), then `discovered`, `seen`, `surveyed` (sections of cell words), items (a section of [`REMEMBERED_ITEM_STRIDE`] 16: position, ground item row), gates (a section of [`DOOR_MEMORY_STRIDE`] 3: gate, open, locked), revision |
//! | Cue | [`CUE_STRIDE`] 4: `at`, tick, until. Heard is a section of cues, oldest first |
//!
//! The fact payloads, by tag (words after the tag, zero padded to 6): 0 Hit (source entity, target);
//! 1 Rejected (actor, reason tag, 3 payload words); 2 Eliminated (actor); 3 Respawned (actor);
//! 4 KillCredited (actor, target); 5 Assisted (actor, target); 6 KillRewarded (actor); 7 Placed
//! (source entity, placed entity); 8 Boosted (actor); 9 ShotFired (actor, weapon); 10 ReloadStarted
//! (actor, ready_at); 11 Reloaded (actor, weapon, rounds); 12 Pickup (actor, item, count);
//! 13 Escaped (actor, cell); 14 ChargingStarted, 15 ChargingStopped, 16 CellCharged (actor,
//! station); 17 GateChanged (actor, gate, open); 18 GateObserved (actor, gate, open, locked);
//! 19 TransitDeparted, 20 TransitLanded (actor, station); 21 UtilityUsed (actor, utility);
//! 22 MeleeSwung, 23 WardenPulsed, 24 SpecterScanned (actor); 25 HookFired (owner);
//! 26 HookAttached (owner, target); 27 HookReleased (owner, reason); 28 MineExploded (trap);
//! 29 SpiderGrappled (trap, target, at x, y); 30 Heard (listener, at x, y, until); 31 Contact
//! (substep, body a, body b, kind); 32 Finished. A rejection's reason tags are: SkillCooldown 0,
//! HookCapacity 1, Drop 2, DropAmmo 3 (family), Reload 4, SelectSlot 5, MoveSlot 6, Pickup 7
//! (item), Swap 8 (item), Interaction 9 (present, target tag, value), GateLocked 10,
//! GateOccupied 11, GateContested 12 (gate), Transit 13 (station).

use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::discovery::DiscoveryMap;
use crate::physics::{self, BodyParams, KIND_PROP, LOOT_GROUP};
use crate::sight::{GateSet, SightIndex};

pub const EQUIPMENT_WORDS: usize = 4;
pub const INVENTORY_WORDS: usize = SLOT_COUNT * (3 + EQUIPMENT_WORDS) + 1 + 3 + 1 + 4;
pub const LOOT_WORDS: usize = 1 + EQUIPMENT_WORDS;
pub const ACTOR_STRIDE: usize = 93;
pub const ITEM_STRIDE: usize = 1 + LOOT_WORDS + 2 + 3 + 2 + 1;
pub const PROJECTILE_STRIDE: usize = 10;
pub const HOOK_STRIDE: usize = 9;
pub const GATE_STRIDE: usize = 6;
pub const TRAP_STRIDE: usize = 10;
pub const STATION_STRIDE: usize = 4;
pub const EXTRACTION_WORDS: usize = 4;
pub const POSE_STRIDE: usize = 4;
pub const FACT_PAYLOAD: usize = 6;
pub const EVENT_STRIDE: usize = 3 + FACT_PAYLOAD;
pub const INPUT_WORDS: usize = 27;
pub const INBOUND_STRIDE: usize = 1 + 4 + INPUT_WORDS;
pub const DISCONTINUITY_STRIDE: usize = 3;
pub const GATE_OBSERVATION_STRIDE: usize = 4;
pub const SAMPLE_STRIDE: usize = 3;
pub const REMEMBERED_ITEM_STRIDE: usize = 2 + ITEM_STRIDE;
pub const DOOR_MEMORY_STRIDE: usize = 3;
pub const CUE_STRIDE: usize = 4;
/// A body row's words before its vertices: the body (2), then 23 words up to the vertex count.
pub const BODY_HEADER: usize = 2 + 23;
pub const SURFACE_ROW: usize = 11;
pub const MAX_SPREAD: usize = 8;
const WEAPON_TUNING_WORDS: usize = 5 + MAX_SPREAD;
pub const TUNING_WORDS: usize =
    8 + 11 + 2 + 3 * WEAPON_TUNING_WORDS + 4 + 3 + 7 + 6 + 3 + 5 + 5 + 7 + 7;

/// Why a buffer did not decode: the word it stopped at and what was wrong.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CodecError {
    pub at: usize,
    pub what: &'static str,
}

pub type Result<T> = std::result::Result<T, CodecError>;

const SAFE_INTEGER: u64 = 1 << 53;

/// Reads words front to back. Every failure is an error, never a panic.
pub struct Reader<'a> {
    words: &'a [f64],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(words: &'a [f64]) -> Self {
        Self { words, at: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.at == self.words.len()
    }

    fn fail<T>(&self, what: &'static str) -> Result<T> {
        Err(CodecError { at: self.at, what })
    }

    fn word(&mut self) -> Result<f64> {
        let Some(&word) = self.words.get(self.at) else {
            return self.fail("truncated");
        };
        self.at += 1;
        Ok(word)
    }

    fn finite(&mut self) -> Result<f64> {
        let word = self.word()?;
        if word.is_finite() {
            Ok(word)
        } else {
            self.at -= 1;
            self.fail("not finite")
        }
    }

    fn u64(&mut self) -> Result<u64> {
        let word = self.word()?;
        if word >= 0.0 && word.fract() == 0.0 && word <= SAFE_INTEGER as f64 {
            Ok(word as u64)
        } else {
            self.at -= 1;
            self.fail("not an integer")
        }
    }

    fn u32(&mut self) -> Result<u32> {
        let word = self.u64()?;
        u32::try_from(word).or_else(|_| {
            self.at -= 1;
            self.fail("integer out of range")
        })
    }

    fn u8(&mut self) -> Result<u8> {
        let word = self.u64()?;
        u8::try_from(word).or_else(|_| {
            self.at -= 1;
            self.fail("integer out of range")
        })
    }

    fn bool(&mut self) -> Result<bool> {
        match self.word()? {
            0.0 => Ok(false),
            1.0 => Ok(true),
            _ => {
                self.at -= 1;
                self.fail("not a bool")
            }
        }
    }

    fn point(&mut self) -> Result<Point> {
        Ok([self.finite()?, self.finite()?])
    }

    /// A section's count, checked against the words left so a bad count cannot allocate.
    fn count(&mut self, stride: usize) -> Result<usize> {
        let count = self.u32()? as usize;
        if count.saturating_mul(stride) > self.words.len() - self.at {
            self.at -= 1;
            return self.fail("count exceeds the buffer");
        }
        Ok(count)
    }

    fn skip(&mut self, words: usize) -> Result<()> {
        if words > self.words.len() - self.at {
            return self.fail("truncated");
        }
        self.at += words;
        Ok(())
    }

    /// A table index: the word names one entry of `table`.
    fn pick<T: Copy>(&mut self, table: &[T]) -> Result<T> {
        let index = self.u32()? as usize;
        match table.get(index) {
            Some(&value) => Ok(value),
            None => {
                self.at -= 1;
                self.fail("unknown tag")
            }
        }
    }

    /// Reads a value in exactly `width` words, however many it uses.
    fn padded<T>(&mut self, width: usize, read: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        let end = self.at + width;
        if end > self.words.len() {
            return self.fail("truncated");
        }
        let value = read(self)?;
        if self.at > end {
            return self.fail("payload overruns its row");
        }
        self.at = end;
        Ok(value)
    }

    fn option<T>(
        &mut self,
        width: usize,
        read: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<Option<T>> {
        if self.bool()? {
            read(self).map(Some)
        } else {
            self.skip(width)?;
            Ok(None)
        }
    }

    fn actor(&mut self) -> Result<ActorId> {
        let word = self.u64()?;
        match actor_from_word(word) {
            Some(actor) => Ok(actor),
            None => {
                self.at -= 1;
                self.fail("not an actor")
            }
        }
    }

    fn entity(&mut self) -> Result<Entity> {
        let tag = self.u32()?;
        let value = self.u64()?;
        let id = |r: &Self| u32::try_from(value).or_else(|_| r.fail("integer out of range"));
        Ok(match tag {
            0 => Entity::Actor(self.actor_from(value)?),
            1 => Entity::Item(ItemId(id(self)?)),
            2 => Entity::Projectile(ProjectileId(id(self)?)),
            3 => Entity::Hook(HookId(id(self)?)),
            4 => Entity::Gate(GateId(id(self)?)),
            5 => Entity::Trap(TrapId(id(self)?)),
            6 => Entity::Station(StationId(id(self)?)),
            7 => Entity::Prop(id(self)?),
            8 => Entity::Geometry(id(self)?),
            9 => Entity::Match,
            _ => return self.fail("unknown entity tag"),
        })
    }

    fn actor_from(&self, value: u64) -> Result<ActorId> {
        actor_from_word(value).map_or_else(|| self.fail("not an actor"), Ok)
    }

    fn body(&mut self) -> Result<BodyId> {
        Ok(match self.entity()? {
            Entity::Actor(id) => BodyId::Actor(id),
            Entity::Item(id) => BodyId::Item(id),
            Entity::Prop(id) => BodyId::Prop(id),
            Entity::Gate(id) => BodyId::Gate(id),
            Entity::Geometry(id) => BodyId::Geometry(id),
            _ => return self.fail("not a body"),
        })
    }
}

trait Put {
    fn int(&mut self, value: impl Into<u64>);
    fn size(&mut self, value: usize);
    fn flag(&mut self, value: bool);
    fn point(&mut self, value: Point);
    fn actor(&mut self, value: ActorId);
    fn entity(&mut self, value: Entity);
    fn body(&mut self, value: BodyId);
    fn pad_to(&mut self, end: usize);
}

impl Put for Vec<f64> {
    fn int(&mut self, value: impl Into<u64>) {
        let value = value.into();
        debug_assert!(value <= SAFE_INTEGER, "{value} does not fit a word exactly");
        self.push(value as f64);
    }

    fn size(&mut self, value: usize) {
        self.int(value as u64);
    }

    fn flag(&mut self, value: bool) {
        self.push(f64::from(u8::from(value)));
    }

    fn point(&mut self, value: Point) {
        self.extend(value);
    }

    fn actor(&mut self, value: ActorId) {
        self.int(actor_word(value));
    }

    fn entity(&mut self, value: Entity) {
        let (tag, id): (u32, u64) = match value {
            Entity::Actor(id) => (0, actor_word(id)),
            Entity::Item(id) => (1, id.0.into()),
            Entity::Projectile(id) => (2, id.0.into()),
            Entity::Hook(id) => (3, id.0.into()),
            Entity::Gate(id) => (4, id.0.into()),
            Entity::Trap(id) => (5, id.0.into()),
            Entity::Station(id) => (6, id.0.into()),
            Entity::Prop(id) => (7, id.into()),
            Entity::Geometry(id) => (8, id.into()),
            Entity::Match => (9, 0),
        };
        self.int(tag);
        self.int(id);
    }

    fn body(&mut self, value: BodyId) {
        self.entity(value.into());
    }

    fn pad_to(&mut self, end: usize) {
        debug_assert!(self.len() <= end, "a payload overran its row");
        self.resize(end, 0.0);
    }
}

/// Writes an option: presence, then the words, or zeros for `width` words.
fn put_option<T>(
    w: &mut Vec<f64>,
    width: usize,
    value: Option<T>,
    write: impl FnOnce(&mut Vec<f64>, T),
) {
    let start = w.len();
    match value {
        Some(value) => {
            w.flag(true);
            write(w, value);
        }
        None => w.flag(false),
    }
    w.pad_to(start + 1 + width);
}

fn put_pick<T: PartialEq>(w: &mut Vec<f64>, table: &[T], value: &T) {
    let index = table
        .iter()
        .position(|entry| entry == value)
        .expect("every variant is in its table");
    w.int(index as u64);
}

const PRESENCE: [Presence; 6] = [
    Presence::Pending,
    Presence::Active,
    Presence::Eliminated,
    Presence::Escaped,
    Presence::Transit,
    Presence::Stranded,
];
const KITS: [Kit; 4] = [Kit::Warden, Kit::Specter, Kit::Striker, Kit::Hook];
const WEAPONS: [WeaponKind; 3] = [
    WeaponKind::Pistol,
    WeaponKind::Rifle,
    WeaponKind::Scattergun,
];
const FAMILIES: [AmmoFamily; 3] = [AmmoFamily::Pistol, AmmoFamily::Rifle, AmmoFamily::Shell];
const UTILITIES: [Utility; 2] = [Utility::Medkit, Utility::Shield];
const STATION_KINDS: [StationKind; 2] = [StationKind::Charging, StationKind::Transit];
const SOURCES: [CommandSource; 2] = [CommandSource::Player, CommandSource::Bot];
const CONTACTS: [ContactKind; 2] = [ContactKind::Started, ContactKind::Stopped];
const STATUSES: [Status; 4] = [Status::Boost, Status::Cloak, Status::Reveal, Status::Stun];
const RELEASES: [HookRelease; 9] = [
    HookRelease::Cancelled,
    HookRelease::Expired,
    HookRelease::Obstructed,
    HookRelease::FriendlyContact,
    HookRelease::Range,
    HookRelease::Standoff,
    HookRelease::Separation,
    HookRelease::EndpointGone,
    HookRelease::Relocated,
];

// ---- Inventory and loot

fn put_equipment(w: &mut Vec<f64>, equipment: Equipment) {
    match equipment.kind {
        EquipmentKind::Firearm { kind, rounds } => {
            w.int(0u32);
            put_pick(w, &WEAPONS, &kind);
            w.int(rounds);
        }
        EquipmentKind::Stack { kind, count } => {
            w.int(1u32);
            put_pick(w, &UTILITIES, &kind);
            w.int(count);
        }
        EquipmentKind::Cell { charge } => {
            w.int(2u32);
            w.int(charge);
            w.int(0u32);
        }
    }
    w.int(equipment.quality);
}

fn get_equipment(r: &mut Reader) -> Result<Equipment> {
    let tag = r.u32()?;
    let kind = match tag {
        0 => EquipmentKind::Firearm {
            kind: r.pick(&WEAPONS)?,
            rounds: r.u32()?,
        },
        1 => EquipmentKind::Stack {
            kind: r.pick(&UTILITIES)?,
            count: r.u32()?,
        },
        2 => {
            let charge = r.u32()?;
            r.skip(1)?;
            EquipmentKind::Cell { charge }
        }
        _ => return r.fail("unknown equipment tag"),
    };
    Ok(Equipment {
        kind,
        quality: r.u8()?,
    })
}

fn put_loot(w: &mut Vec<f64>, loot: Loot) {
    let start = w.len();
    match loot {
        Loot::AccessKey => w.int(0u32),
        Loot::Equipment(equipment) => {
            w.int(1u32);
            put_equipment(w, equipment);
        }
        Loot::Ammo { family, count } => {
            w.int(2u32);
            put_pick(w, &FAMILIES, &family);
            w.int(count);
        }
    }
    w.pad_to(start + LOOT_WORDS);
}

fn get_loot(r: &mut Reader) -> Result<Loot> {
    r.padded(LOOT_WORDS, |r| {
        Ok(match r.u32()? {
            0 => Loot::AccessKey,
            1 => Loot::Equipment(get_equipment(r)?),
            2 => Loot::Ammo {
                family: r.pick(&FAMILIES)?,
                count: r.u32()?,
            },
            _ => return r.fail("unknown loot tag"),
        })
    })
}

fn put_inventory(w: &mut Vec<f64>, inventory: &Inventory) {
    let start = w.len();
    for slot in &inventory.slots {
        put_option(w, 2 + EQUIPMENT_WORDS, *slot, |w, item| {
            w.int(item.id.0);
            w.int(item.lineage.0);
            put_equipment(w, item.equipment);
        });
    }
    w.int(inventory.selected);
    for reserve in inventory.reserves {
        w.int(reserve);
    }
    w.int(inventory.keys);
    put_option(w, 3, inventory.reload, |w, reload| {
        w.int(reload.slot);
        w.int(reload.item.0);
        w.int(reload.ready_at);
    });
    debug_assert_eq!(w.len() - start, INVENTORY_WORDS);
}

fn get_inventory(r: &mut Reader) -> Result<Inventory> {
    let mut inventory = Inventory::default();
    for slot in &mut inventory.slots {
        *slot = r.option(2 + EQUIPMENT_WORDS, |r| {
            Ok(CarriedItem {
                id: ItemId(r.u32()?),
                lineage: ItemId(r.u32()?),
                equipment: get_equipment(r)?,
            })
        })?;
    }
    inventory.selected = r.u8()?;
    for reserve in &mut inventory.reserves {
        *reserve = r.u32()?;
    }
    inventory.keys = r.u32()?;
    inventory.reload = r.option(3, |r| {
        Ok(Reload {
            slot: r.u8()?,
            item: ItemId(r.u32()?),
            ready_at: r.u32()?,
        })
    })?;
    Ok(inventory)
}

// ---- State rows

fn put_actor(w: &mut Vec<f64>, id: ActorId, actor: &Actor) {
    let start = w.len();
    w.actor(id);
    put_pick(w, &PRESENCE, &actor.presence);
    put_option(w, 1, actor.kit, |w, kit| put_pick(w, &KITS, &kit));
    w.int(actor.level);
    w.int(actor.kills);
    w.extend([
        actor.hp,
        actor.max_hp,
        actor.shield,
        actor.max_shield,
        actor.aim,
    ]);
    w.flag(actor.sneak);
    w.int(actor.view_lag);
    put_inventory(w, &actor.inventory);
    put_option(w, 2, actor.charging, |w, charging| {
        w.int(charging.station.0);
        w.int(charging.cell.0);
    });
    put_option(w, 1, actor.respawn_at, |w, at| w.int(at));
    put_option(w, 4, actor.transit, |w, transit| {
        w.int(transit.destination.0);
        w.point(transit.origin);
        w.int(transit.arrive_at);
    });
    w.flag(actor.bot);
    put_option(w, 2, actor.aggression, |w, aggression| {
        w.actor(aggression.source);
        w.int(aggression.expires_at);
    });
    w.int(actor.deadlines.skill_ready_at);
    w.int(actor.deadlines.weapon_ready_at);
    w.int(actor.deadlines.transit_ready_at);
    for status in STATUSES {
        put_option(w, 2, actor.statuses.get(&status), |w, window| {
            w.int(window.active_from);
            w.int(window.expires_at);
        });
    }
    debug_assert_eq!(w.len() - start, ACTOR_STRIDE);
}

fn get_actor(r: &mut Reader) -> Result<(ActorId, Actor)> {
    let id = r.actor()?;
    let presence = r.pick(&PRESENCE)?;
    let kit = r.option(1, |r| r.pick(&KITS))?;
    let level = r.u8()?;
    let kills = r.u32()?;
    let (hp, max_hp, shield, max_shield, aim) = (
        r.finite()?,
        r.finite()?,
        r.finite()?,
        r.finite()?,
        r.finite()?,
    );
    let sneak = r.bool()?;
    let view_lag = r.u32()?;
    let inventory = get_inventory(r)?;
    let charging = r.option(2, |r| {
        Ok(Charging {
            station: StationId(r.u32()?),
            cell: ItemId(r.u32()?),
        })
    })?;
    let respawn_at = r.option(1, |r| r.u32())?;
    let transit = r.option(4, |r| {
        Ok(Transit {
            destination: StationId(r.u32()?),
            origin: r.point()?,
            arrive_at: r.u32()?,
        })
    })?;
    let bot = r.bool()?;
    let aggression = r.option(2, |r| {
        Ok(Aggression {
            source: r.actor()?,
            expires_at: r.u32()?,
        })
    })?;
    let deadlines = Deadlines {
        skill_ready_at: r.u32()?,
        weapon_ready_at: r.u32()?,
        transit_ready_at: r.u32()?,
    };
    let mut statuses = BTreeMap::new();
    for status in STATUSES {
        let window = r.option(2, |r| {
            Ok(Window {
                active_from: r.u32()?,
                expires_at: r.u32()?,
            })
        })?;
        if let Some(window) = window {
            statuses.insert(status, window);
        }
    }
    let actor = Actor {
        presence,
        kit,
        level,
        kills,
        hp,
        max_hp,
        shield,
        max_shield,
        aim,
        sneak,
        view_lag,
        inventory,
        charging,
        respawn_at,
        transit,
        bot,
        aggression,
        deadlines,
        statuses,
    };
    Ok((id, actor))
}

fn put_item(w: &mut Vec<f64>, id: ItemId, item: &GroundItem) {
    let start = w.len();
    w.int(id.0);
    put_loot(w, item.loot);
    put_option(w, 1, item.lineage, |w, lineage| w.int(lineage.0));
    put_option(w, 2, item.unplaced_at, |w, at| w.point(at));
    put_option(w, 1, item.dropped_by, |w, actor| w.actor(actor));
    w.int(item.pickup_ready_at);
    debug_assert_eq!(w.len() - start, ITEM_STRIDE);
}

fn get_item(r: &mut Reader) -> Result<(ItemId, GroundItem)> {
    let id = ItemId(r.u32()?);
    let item = GroundItem {
        loot: get_loot(r)?,
        lineage: r.option(1, |r| Ok(ItemId(r.u32()?)))?,
        unplaced_at: r.option(2, |r| r.point())?,
        dropped_by: r.option(1, |r| r.actor())?,
        pickup_ready_at: r.u32()?,
    };
    Ok((id, item))
}

fn put_projectile(w: &mut Vec<f64>, id: ProjectileId, p: &Projectile) {
    w.int(id.0);
    w.entity(p.source);
    w.point(p.position);
    w.point(p.velocity);
    w.push(p.damage);
    w.int(p.active_from);
    w.int(p.expires_at);
}

fn get_projectile(r: &mut Reader) -> Result<(ProjectileId, Projectile)> {
    Ok((
        ProjectileId(r.u32()?),
        Projectile {
            source: r.entity()?,
            position: r.point()?,
            velocity: r.point()?,
            damage: r.finite()?,
            active_from: r.u32()?,
            expires_at: r.u32()?,
        },
    ))
}

fn put_hook(w: &mut Vec<f64>, id: HookId, hook: &Hook) {
    w.int(id.0);
    w.actor(hook.owner);
    let start = w.len();
    match hook.phase {
        HookPhase::Flying {
            position,
            direction,
            travelled,
        } => {
            w.int(0u32);
            w.point(position);
            w.point(direction);
            w.push(travelled);
        }
        HookPhase::Pulling { target, length } => {
            w.int(1u32);
            w.actor(target);
            w.push(length);
        }
    }
    w.pad_to(start + 6);
    w.int(hook.expires_at);
}

fn get_hook(r: &mut Reader) -> Result<(HookId, Hook)> {
    let id = HookId(r.u32()?);
    let owner = r.actor()?;
    let tag = r.u32()?;
    let phase = r.padded(5, |r| {
        Ok(match tag {
            0 => HookPhase::Flying {
                position: r.point()?,
                direction: r.point()?,
                travelled: r.finite()?,
            },
            1 => HookPhase::Pulling {
                target: r.actor()?,
                length: r.finite()?,
            },
            _ => return r.fail("unknown hook phase"),
        })
    })?;
    Ok((
        id,
        Hook {
            owner,
            phase,
            expires_at: r.u32()?,
        },
    ))
}

fn put_gate(w: &mut Vec<f64>, id: GateId, gate: &Gate) {
    w.int(id.0);
    w.flag(gate.open);
    w.flag(gate.locked);
    w.flag(gate.door);
    w.point(gate.position);
}

fn get_gate(r: &mut Reader) -> Result<(GateId, Gate)> {
    Ok((
        GateId(r.u32()?),
        Gate {
            open: r.bool()?,
            locked: r.bool()?,
            door: r.bool()?,
            position: r.point()?,
        },
    ))
}

fn put_trap(w: &mut Vec<f64>, id: TrapId, trap: &Trap) {
    w.int(id.0);
    w.point(trap.position);
    w.push(trap.heading);
    w.int(trap.ready_at);
    let start = w.len();
    match trap.kind {
        TrapKind::Mine { spent } => {
            w.int(0u32);
            w.flag(spent);
        }
        TrapKind::Turret { aiming } => {
            w.int(1u32);
            w.flag(aiming);
        }
        TrapKind::Flame {
            offset,
            warning,
            firing,
        } => {
            w.int(2u32);
            w.int(offset);
            w.flag(warning);
            w.flag(firing);
        }
        TrapKind::Spider { home, target } => {
            w.int(3u32);
            w.point(home);
            put_option(w, 1, target, |w, actor| w.actor(actor));
        }
    }
    w.pad_to(start + 5);
}

fn get_trap(r: &mut Reader) -> Result<(TrapId, Trap)> {
    let id = TrapId(r.u32()?);
    let position = r.point()?;
    let heading = r.finite()?;
    let ready_at = r.u32()?;
    let tag = r.u32()?;
    let kind = r.padded(4, |r| {
        Ok(match tag {
            0 => TrapKind::Mine { spent: r.bool()? },
            1 => TrapKind::Turret { aiming: r.bool()? },
            2 => TrapKind::Flame {
                offset: r.u32()?,
                warning: r.bool()?,
                firing: r.bool()?,
            },
            3 => TrapKind::Spider {
                home: r.point()?,
                target: r.option(1, |r| r.actor())?,
            },
            _ => return r.fail("unknown trap kind"),
        })
    })?;
    Ok((
        id,
        Trap {
            position,
            heading,
            ready_at,
            kind,
        },
    ))
}

fn put_station(w: &mut Vec<f64>, id: StationId, station: &Station) {
    w.int(id.0);
    put_pick(w, &STATION_KINDS, &station.kind);
    w.point(station.position);
}

fn get_station(r: &mut Reader) -> Result<(StationId, Station)> {
    Ok((
        StationId(r.u32()?),
        Station {
            kind: r.pick(&STATION_KINDS)?,
            position: r.point()?,
        },
    ))
}

fn put_extraction(w: &mut Vec<f64>, extraction: Option<Extraction>) {
    put_option(w, EXTRACTION_WORDS - 1, extraction, |w, e| {
        w.point(e.position);
        w.int(e.slots);
    });
}

fn get_extraction(r: &mut Reader) -> Result<Option<Extraction>> {
    r.option(EXTRACTION_WORDS - 1, |r| {
        Ok(Extraction {
            position: r.point()?,
            slots: r.u32()?,
        })
    })
}

/// A section of table rows: a count, then each record.
fn put_table<K: Copy, V>(
    w: &mut Vec<f64>,
    table: &BTreeMap<K, V>,
    put: impl Fn(&mut Vec<f64>, K, &V),
) {
    w.size(table.len());
    for (&id, record) in table {
        put(w, id, record);
    }
}

fn get_table<K: Ord, V>(
    r: &mut Reader,
    stride: usize,
    get: impl Fn(&mut Reader) -> Result<(K, V)>,
) -> Result<BTreeMap<K, V>> {
    let count = r.count(stride)?;
    let mut table = BTreeMap::new();
    for _ in 0..count {
        let (id, record) = get(r)?;
        if table.insert(id, record).is_some() {
            return r.fail("duplicate row ID");
        }
    }
    Ok(table)
}

/// The state tables, in the order the module documentation gives.
pub fn put_state(w: &mut Vec<f64>, state: &State) {
    put_table(w, &state.actors, put_actor);
    put_table(w, &state.items, put_item);
    put_table(w, &state.projectiles, put_projectile);
    put_table(w, &state.hooks, put_hook);
    put_table(w, &state.gates, put_gate);
    put_table(w, &state.traps, put_trap);
    put_table(w, &state.stations, put_station);
    put_extraction(w, state.extraction);
    w.size(state.sensors.len());
    for &sensor in &state.sensors {
        w.point(sensor);
    }
    put_option(w, 1, state.hazard_x, |w, x| w.push(x));
}

pub fn get_state(r: &mut Reader) -> Result<State> {
    let actors = get_table(r, ACTOR_STRIDE, get_actor)?;
    let items = get_table(r, ITEM_STRIDE, get_item)?;
    let projectiles = get_table(r, PROJECTILE_STRIDE, get_projectile)?;
    let hooks = get_table(r, HOOK_STRIDE, get_hook)?;
    let gates = get_table(r, GATE_STRIDE, get_gate)?;
    let traps = get_table(r, TRAP_STRIDE, get_trap)?;
    let stations = get_table(r, STATION_STRIDE, get_station)?;
    let extraction = get_extraction(r)?;
    let count = r.count(2)?;
    let sensors = (0..count).map(|_| r.point()).collect::<Result<Vec<_>>>()?;
    Ok(State {
        actors,
        items,
        projectiles,
        hooks,
        gates,
        traps,
        stations,
        extraction,
        sensors,
        hazard_x: r.option(1, |r| r.finite())?,
    })
}

fn put_poses(w: &mut Vec<f64>, poses: &BTreeMap<BodyId, Point>) {
    w.size(poses.len());
    for (&body, &at) in poses {
        w.body(body);
        w.point(at);
    }
}

fn get_poses(r: &mut Reader) -> Result<BTreeMap<BodyId, Point>> {
    let count = r.count(POSE_STRIDE)?;
    let mut poses = BTreeMap::new();
    for _ in 0..count {
        poses.insert(r.body()?, r.point()?);
    }
    Ok(poses)
}

pub fn put_snapshot(w: &mut Vec<f64>, snapshot: &Snapshot) {
    w.int(snapshot.tick);
    put_state(w, &snapshot.state);
    put_poses(w, &snapshot.poses);
}

pub fn get_snapshot(r: &mut Reader) -> Result<Snapshot> {
    Ok(Snapshot {
        tick: r.u32()?,
        state: get_state(r)?,
        poses: get_poses(r)?,
    })
}

// ---- Changes and events

fn put_rejection(w: &mut Vec<f64>, reason: Rejection) {
    let start = w.len();
    match reason {
        Rejection::SkillCooldown => w.int(0u32),
        Rejection::HookCapacity => w.int(1u32),
        Rejection::Drop => w.int(2u32),
        Rejection::DropAmmo(family) => {
            w.int(3u32);
            put_pick(w, &FAMILIES, &family);
        }
        Rejection::Reload => w.int(4u32),
        Rejection::SelectSlot => w.int(5u32),
        Rejection::MoveSlot => w.int(6u32),
        Rejection::Pickup(item) => {
            w.int(7u32);
            w.int(item.0);
        }
        Rejection::Swap(item) => {
            w.int(8u32);
            w.int(item.0);
        }
        Rejection::Interaction(target) => {
            w.int(9u32);
            put_option(w, 2, target, put_target);
        }
        Rejection::GateLocked(gate) => {
            w.int(10u32);
            w.int(gate.0);
        }
        Rejection::GateOccupied(gate) => {
            w.int(11u32);
            w.int(gate.0);
        }
        Rejection::GateContested(gate) => {
            w.int(12u32);
            w.int(gate.0);
        }
        Rejection::Transit(station) => {
            w.int(13u32);
            w.int(station.0);
        }
    }
    w.pad_to(start + 4);
}

fn get_rejection(r: &mut Reader) -> Result<Rejection> {
    let tag = r.u32()?;
    r.padded(3, |r| {
        Ok(match tag {
            0 => Rejection::SkillCooldown,
            1 => Rejection::HookCapacity,
            2 => Rejection::Drop,
            3 => Rejection::DropAmmo(r.pick(&FAMILIES)?),
            4 => Rejection::Reload,
            5 => Rejection::SelectSlot,
            6 => Rejection::MoveSlot,
            7 => Rejection::Pickup(ItemId(r.u32()?)),
            8 => Rejection::Swap(ItemId(r.u32()?)),
            9 => Rejection::Interaction(r.option(2, get_target)?),
            10 => Rejection::GateLocked(GateId(r.u32()?)),
            11 => Rejection::GateOccupied(GateId(r.u32()?)),
            12 => Rejection::GateContested(GateId(r.u32()?)),
            13 => Rejection::Transit(StationId(r.u32()?)),
            _ => return r.fail("unknown rejection tag"),
        })
    })
}

fn put_fact(w: &mut Vec<f64>, fact: Fact) {
    let start = w.len();
    match fact {
        Fact::Hit { source, target } => {
            w.int(0u32);
            w.entity(source);
            w.actor(target);
        }
        Fact::Rejected { actor, reason } => {
            w.int(1u32);
            w.actor(actor);
            put_rejection(w, reason);
        }
        Fact::Eliminated { actor } => {
            w.int(2u32);
            w.actor(actor);
        }
        Fact::Respawned { actor } => {
            w.int(3u32);
            w.actor(actor);
        }
        Fact::KillCredited { actor, target } => {
            w.int(4u32);
            w.actor(actor);
            w.actor(target);
        }
        Fact::Assisted { actor, target } => {
            w.int(5u32);
            w.actor(actor);
            w.actor(target);
        }
        Fact::KillRewarded { actor } => {
            w.int(6u32);
            w.actor(actor);
        }
        Fact::Placed { source, placed } => {
            w.int(7u32);
            w.entity(source);
            w.entity(placed);
        }
        Fact::Boosted { actor } => {
            w.int(8u32);
            w.actor(actor);
        }
        Fact::ShotFired { actor, weapon } => {
            w.int(9u32);
            w.actor(actor);
            put_pick(w, &WEAPONS, &weapon);
        }
        Fact::ReloadStarted { actor, ready_at } => {
            w.int(10u32);
            w.actor(actor);
            w.int(ready_at);
        }
        Fact::Reloaded {
            actor,
            weapon,
            rounds,
        } => {
            w.int(11u32);
            w.actor(actor);
            put_pick(w, &WEAPONS, &weapon);
            w.int(rounds);
        }
        Fact::Pickup { actor, item, count } => {
            w.int(12u32);
            w.actor(actor);
            w.int(item.0);
            w.int(count);
        }
        Fact::Escaped { actor, cell } => {
            w.int(13u32);
            w.actor(actor);
            w.int(cell.0);
        }
        Fact::ChargingStarted { actor, station }
        | Fact::ChargingStopped { actor, station }
        | Fact::CellCharged { actor, station }
        | Fact::TransitDeparted {
            actor,
            destination: station,
        }
        | Fact::TransitLanded {
            actor,
            destination: station,
        } => {
            w.int(match fact {
                Fact::ChargingStarted { .. } => 14u32,
                Fact::ChargingStopped { .. } => 15,
                Fact::CellCharged { .. } => 16,
                Fact::TransitDeparted { .. } => 19,
                _ => 20,
            });
            w.actor(actor);
            w.int(station.0);
        }
        Fact::GateChanged { actor, gate, open } => {
            w.int(17u32);
            w.actor(actor);
            w.int(gate.0);
            w.flag(open);
        }
        Fact::GateObserved {
            actor,
            gate,
            open,
            locked,
        } => {
            w.int(18u32);
            w.actor(actor);
            w.int(gate.0);
            w.flag(open);
            w.flag(locked);
        }
        Fact::UtilityUsed { actor, utility } => {
            w.int(21u32);
            w.actor(actor);
            put_pick(w, &UTILITIES, &utility);
        }
        Fact::MeleeSwung { actor } => {
            w.int(22u32);
            w.actor(actor);
        }
        Fact::WardenPulsed { actor } => {
            w.int(23u32);
            w.actor(actor);
        }
        Fact::SpecterScanned { actor } => {
            w.int(24u32);
            w.actor(actor);
        }
        Fact::HookFired { owner } => {
            w.int(25u32);
            w.actor(owner);
        }
        Fact::HookAttached { owner, target } => {
            w.int(26u32);
            w.actor(owner);
            w.actor(target);
        }
        Fact::HookReleased { owner, reason } => {
            w.int(27u32);
            w.actor(owner);
            put_pick(w, &RELEASES, &reason);
        }
        Fact::MineExploded { trap } => {
            w.int(28u32);
            w.int(trap.0);
        }
        Fact::SpiderGrappled { trap, target, at } => {
            w.int(29u32);
            w.int(trap.0);
            w.actor(target);
            w.point(at.position());
        }
        Fact::Heard {
            listener,
            at,
            until,
        } => {
            w.int(30u32);
            w.actor(listener);
            w.point(at.position());
            w.int(until);
        }
        Fact::Contact(contact) => {
            w.int(31u32);
            w.int(contact.substep);
            w.body(contact.a);
            w.body(contact.b);
            put_pick(w, &CONTACTS, &contact.kind);
        }
        Fact::Finished => w.int(32u32),
    }
    w.pad_to(start + 1 + FACT_PAYLOAD);
}

fn get_fact(r: &mut Reader) -> Result<Fact> {
    let tag = r.u32()?;
    r.padded(FACT_PAYLOAD, |r| {
        Ok(match tag {
            0 => Fact::Hit {
                source: r.entity()?,
                target: r.actor()?,
            },
            1 => Fact::Rejected {
                actor: r.actor()?,
                reason: get_rejection(r)?,
            },
            2 => Fact::Eliminated { actor: r.actor()? },
            3 => Fact::Respawned { actor: r.actor()? },
            4 => Fact::KillCredited {
                actor: r.actor()?,
                target: r.actor()?,
            },
            5 => Fact::Assisted {
                actor: r.actor()?,
                target: r.actor()?,
            },
            6 => Fact::KillRewarded { actor: r.actor()? },
            7 => Fact::Placed {
                source: r.entity()?,
                placed: r.entity()?,
            },
            8 => Fact::Boosted { actor: r.actor()? },
            9 => Fact::ShotFired {
                actor: r.actor()?,
                weapon: r.pick(&WEAPONS)?,
            },
            10 => Fact::ReloadStarted {
                actor: r.actor()?,
                ready_at: r.u32()?,
            },
            11 => Fact::Reloaded {
                actor: r.actor()?,
                weapon: r.pick(&WEAPONS)?,
                rounds: r.u32()?,
            },
            12 => Fact::Pickup {
                actor: r.actor()?,
                item: ItemId(r.u32()?),
                count: r.u32()?,
            },
            13 => Fact::Escaped {
                actor: r.actor()?,
                cell: ItemId(r.u32()?),
            },
            14 => Fact::ChargingStarted {
                actor: r.actor()?,
                station: StationId(r.u32()?),
            },
            15 => Fact::ChargingStopped {
                actor: r.actor()?,
                station: StationId(r.u32()?),
            },
            16 => Fact::CellCharged {
                actor: r.actor()?,
                station: StationId(r.u32()?),
            },
            17 => Fact::GateChanged {
                actor: r.actor()?,
                gate: GateId(r.u32()?),
                open: r.bool()?,
            },
            18 => Fact::GateObserved {
                actor: r.actor()?,
                gate: GateId(r.u32()?),
                open: r.bool()?,
                locked: r.bool()?,
            },
            19 => Fact::TransitDeparted {
                actor: r.actor()?,
                destination: StationId(r.u32()?),
            },
            20 => Fact::TransitLanded {
                actor: r.actor()?,
                destination: StationId(r.u32()?),
            },
            21 => Fact::UtilityUsed {
                actor: r.actor()?,
                utility: r.pick(&UTILITIES)?,
            },
            22 => Fact::MeleeSwung { actor: r.actor()? },
            23 => Fact::WardenPulsed { actor: r.actor()? },
            24 => Fact::SpecterScanned { actor: r.actor()? },
            25 => Fact::HookFired { owner: r.actor()? },
            26 => Fact::HookAttached {
                owner: r.actor()?,
                target: r.actor()?,
            },
            27 => Fact::HookReleased {
                owner: r.actor()?,
                reason: r.pick(&RELEASES)?,
            },
            28 => Fact::MineExploded {
                trap: TrapId(r.u32()?),
            },
            29 => Fact::SpiderGrappled {
                trap: TrapId(r.u32()?),
                target: r.actor()?,
                at: r.point()?.into(),
            },
            30 => Fact::Heard {
                listener: r.actor()?,
                at: r.point()?.into(),
                until: r.u32()?,
            },
            31 => Fact::Contact(Contact {
                substep: r.u8()?,
                a: r.body()?,
                b: r.body()?,
                kind: r.pick(&CONTACTS)?,
            }),
            32 => Fact::Finished,
            _ => return r.fail("unknown fact tag"),
        })
    })
}

fn put_event(w: &mut Vec<f64>, event: &Event) {
    w.int(event.id);
    w.int(event.tick);
    put_fact(w, event.fact);
}

fn get_event(r: &mut Reader) -> Result<Event> {
    Ok(Event {
        id: r.u64()?,
        tick: r.u32()?,
        fact: get_fact(r)?,
    })
}

pub fn put_changes(w: &mut Vec<f64>, changes: &Changes) {
    put_table(w, &changes.actors, put_actor);
    put_table(w, &changes.items, put_item);
    put_table(w, &changes.projectiles, put_projectile);
    put_table(w, &changes.hooks, put_hook);
    put_table(w, &changes.gates, put_gate);
    put_table(w, &changes.traps, put_trap);
    put_extraction(w, changes.extraction);
    put_option(w, 1, changes.hazard_x, |w, x| w.push(x));
    w.size(changes.removed.len());
    for &entity in &changes.removed {
        w.entity(entity);
    }
    put_poses(w, &changes.poses);
    w.size(changes.events.len());
    for event in &changes.events {
        put_event(w, event);
    }
}

pub fn get_changes(r: &mut Reader) -> Result<Changes> {
    let actors = get_table(r, ACTOR_STRIDE, get_actor)?;
    let items = get_table(r, ITEM_STRIDE, get_item)?;
    let projectiles = get_table(r, PROJECTILE_STRIDE, get_projectile)?;
    let hooks = get_table(r, HOOK_STRIDE, get_hook)?;
    let gates = get_table(r, GATE_STRIDE, get_gate)?;
    let traps = get_table(r, TRAP_STRIDE, get_trap)?;
    let extraction = get_extraction(r)?;
    let hazard_x = r.option(1, |r| r.finite())?;
    let count = r.count(2)?;
    let removed = (0..count).map(|_| r.entity()).collect::<Result<Vec<_>>>()?;
    let poses = get_poses(r)?;
    let count = r.count(EVENT_STRIDE)?;
    let events = (0..count)
        .map(|_| get_event(r))
        .collect::<Result<Vec<_>>>()?;
    Ok(Changes {
        actors,
        items,
        projectiles,
        hooks,
        gates,
        traps,
        extraction,
        hazard_x,
        removed,
        poses,
        events,
    })
}

// ---- Inbound

fn put_target(w: &mut Vec<f64>, target: Target) {
    let (tag, id) = match target {
        Target::Extraction => (0u32, 0),
        Target::Station(id) => (1, id.0),
        Target::Gate(id) => (2, id.0),
        Target::Item(id) => (3, id.0),
    };
    w.int(tag);
    w.int(id);
}

fn get_target(r: &mut Reader) -> Result<Target> {
    let tag = r.u32()?;
    let id = r.u32()?;
    Ok(match tag {
        0 => Target::Extraction,
        1 => Target::Station(StationId(id)),
        2 => Target::Gate(GateId(id)),
        3 => Target::Item(ItemId(id)),
        _ => return r.fail("unknown target tag"),
    })
}

fn put_input(w: &mut Vec<f64>, input: &Input) {
    let start = w.len();
    w.point(input.movement);
    put_option(w, 1, input.aim, |w, aim| w.push(aim));
    w.flag(input.sneak);
    w.flag(input.attack);
    put_option(w, 1, input.utility_slot, |w, slot| w.int(slot));
    w.flag(input.skill);
    w.flag(input.interact);
    put_option(w, 2, input.target, put_target);
    put_option(w, 1, input.slot, |w, slot| w.int(slot));
    put_option(w, 2, input.move_slot, |w, (from, to)| {
        w.int(from);
        w.int(to);
    });
    put_option(w, 2, input.drop, |w, drop| match drop {
        DropSlot::Selected => {
            w.int(0u32);
            w.int(0u32);
        }
        DropSlot::Slot(slot) => {
            w.int(1u32);
            w.int(slot);
        }
    });
    w.flag(input.reload);
    put_option(w, 2, input.drop_ammo, |w, (family, count)| {
        put_pick(w, &FAMILIES, &family);
        w.int(count);
    });
    put_option(w, 1, input.transit, |w, station| w.int(station.0));
    debug_assert_eq!(w.len() - start, INPUT_WORDS);
}

fn get_input(r: &mut Reader) -> Result<Input> {
    Ok(Input {
        movement: r.point()?,
        aim: r.option(1, |r| r.finite())?,
        sneak: r.bool()?,
        attack: r.bool()?,
        utility_slot: r.option(1, |r| r.u8())?,
        skill: r.bool()?,
        interact: r.bool()?,
        target: r.option(2, get_target)?,
        slot: r.option(1, |r| r.u8())?,
        move_slot: r.option(2, |r| Ok((r.u8()?, r.u8()?)))?,
        drop: r.option(2, |r| {
            let tag = r.u32()?;
            let slot = r.u8()?;
            Ok(match tag {
                0 => DropSlot::Selected,
                1 => DropSlot::Slot(slot),
                _ => return r.fail("unknown drop tag"),
            })
        })?,
        reload: r.bool()?,
        drop_ammo: r.option(2, |r| Ok((r.pick(&FAMILIES)?, r.u32()?)))?,
        transit: r.option(1, |r| Ok(StationId(r.u32()?)))?,
    })
}

pub fn put_inbound(w: &mut Vec<f64>, inbound: &Inbound) {
    let start = w.len();
    match inbound {
        Inbound::Command(command) => {
            w.int(0u32);
            w.actor(command.actor);
            put_pick(w, &SOURCES, &command.source);
            w.int(command.tick);
            w.int(command.seq);
            put_input(w, &command.input);
        }
        Inbound::Observation(observation) => {
            w.int(1u32);
            match *observation {
                Observation::ViewLag { actor, ticks } => {
                    w.int(0u32);
                    w.actor(actor);
                    w.int(ticks);
                }
                Observation::InputLead { actor, ticks } => {
                    w.int(1u32);
                    w.actor(actor);
                    w.int(ticks);
                }
                Observation::Join { actor } => {
                    w.int(2u32);
                    w.actor(actor);
                }
                Observation::Leave { actor } => {
                    w.int(3u32);
                    w.actor(actor);
                }
                Observation::Teleport { body, to } => {
                    w.int(4u32);
                    w.body(body);
                    w.point(to);
                }
            }
        }
        Inbound::Carried(carried) => {
            w.int(2u32);
            match *carried {
                Carried::Impulse { body, impulse } => {
                    w.int(0u32);
                    w.body(body);
                    w.point(impulse);
                }
                Carried::KillReward { actor } => {
                    w.int(1u32);
                    w.actor(actor);
                }
                Carried::GateObserved {
                    actor,
                    gate,
                    open,
                    locked,
                } => {
                    w.int(2u32);
                    w.actor(actor);
                    w.int(gate.0);
                    w.flag(open);
                    w.flag(locked);
                }
            }
        }
    }
    w.pad_to(start + INBOUND_STRIDE);
}

pub fn get_inbound(r: &mut Reader) -> Result<Inbound> {
    let tag = r.u32()?;
    r.padded(INBOUND_STRIDE - 1, |r| {
        Ok(match tag {
            0 => Inbound::Command(Command {
                actor: r.actor()?,
                source: r.pick(&SOURCES)?,
                tick: r.u32()?,
                seq: r.u64()?,
                input: get_input(r)?,
            }),
            1 => Inbound::Observation(match r.u32()? {
                0 => Observation::ViewLag {
                    actor: r.actor()?,
                    ticks: r.u32()?,
                },
                1 => Observation::InputLead {
                    actor: r.actor()?,
                    ticks: r.u32()?,
                },
                2 => Observation::Join { actor: r.actor()? },
                3 => Observation::Leave { actor: r.actor()? },
                4 => Observation::Teleport {
                    body: r.body()?,
                    to: r.point()?,
                },
                _ => return r.fail("unknown observation tag"),
            }),
            2 => Inbound::Carried(match r.u32()? {
                0 => Carried::Impulse {
                    body: r.body()?,
                    impulse: r.point()?,
                },
                1 => Carried::KillReward { actor: r.actor()? },
                2 => Carried::GateObserved {
                    actor: r.actor()?,
                    gate: GateId(r.u32()?),
                    open: r.bool()?,
                    locked: r.bool()?,
                },
                _ => return r.fail("unknown carried tag"),
            }),
            _ => return r.fail("unknown inbound tag"),
        })
    })
}

// ---- Discontinuities, discovery, memory and cues

pub fn put_discontinuity(w: &mut Vec<f64>, marker: Discontinuity) {
    let (tag, body) = match marker {
        Discontinuity::Placed(body) => (0u32, body),
        Discontinuity::Warped(body) => (1, body),
        Discontinuity::Removed(body) => (2, body),
    };
    w.int(tag);
    w.body(body);
}

pub fn get_discontinuity(r: &mut Reader) -> Result<Discontinuity> {
    let tag = r.u32()?;
    let body = r.body()?;
    Ok(match tag {
        0 => Discontinuity::Placed(body),
        1 => Discontinuity::Warped(body),
        2 => Discontinuity::Removed(body),
        _ => return r.fail("unknown discontinuity tag"),
    })
}

pub fn put_discovery(w: &mut Vec<f64>, discovery: &Discovery) {
    w.size(discovery.gates.len());
    for observation in &discovery.gates {
        w.actor(observation.actor);
        w.int(observation.gate.0);
        w.flag(observation.open);
        w.flag(observation.locked);
    }
    w.size(discovery.samples.len());
    for sample in &discovery.samples {
        w.actor(sample.actor);
        w.point(sample.eye);
    }
}

pub fn get_discovery(r: &mut Reader) -> Result<Discovery> {
    let count = r.count(GATE_OBSERVATION_STRIDE)?;
    let gates = (0..count)
        .map(|_| {
            Ok(GateObservation {
                actor: r.actor()?,
                gate: GateId(r.u32()?),
                open: r.bool()?,
                locked: r.bool()?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let count = r.count(SAMPLE_STRIDE)?;
    let samples = (0..count)
        .map(|_| {
            Ok(DiscoverySample {
                actor: r.actor()?,
                eye: r.point()?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Discovery { gates, samples })
}

fn put_cells(w: &mut Vec<f64>, cells: &BTreeSet<u32>) {
    w.size(cells.len());
    for &cell in cells {
        w.int(cell);
    }
}

fn get_cells(r: &mut Reader) -> Result<BTreeSet<u32>> {
    let count = r.count(1)?;
    (0..count).map(|_| r.u32()).collect()
}

/// A presence word, then the memory. `None` is the one word 0.
pub fn put_memory(w: &mut Vec<f64>, memory: Option<&Memory>) {
    let Some(memory) = memory else {
        w.flag(false);
        return;
    };
    w.flag(true);
    put_cells(w, &memory.discovered);
    put_cells(w, &memory.seen);
    put_cells(w, &memory.surveyed);
    w.size(memory.items.len());
    for (&id, remembered) in &memory.items {
        w.point(remembered.at);
        put_item(w, id, &remembered.item);
    }
    w.size(memory.gates.len());
    for (&gate, door) in &memory.gates {
        w.int(gate.0);
        w.flag(door.open);
        w.flag(door.locked);
    }
    w.int(memory.revision);
}

pub fn get_memory(r: &mut Reader) -> Result<Option<Memory>> {
    if !r.bool()? {
        return Ok(None);
    }
    let discovered = get_cells(r)?;
    let seen = get_cells(r)?;
    let surveyed = get_cells(r)?;
    let count = r.count(REMEMBERED_ITEM_STRIDE)?;
    let mut items = BTreeMap::new();
    for _ in 0..count {
        let at = r.point()?;
        let (id, item) = get_item(r)?;
        items.insert(id, RememberedItem { at, item });
    }
    let count = r.count(DOOR_MEMORY_STRIDE)?;
    let mut gates = BTreeMap::new();
    for _ in 0..count {
        gates.insert(
            GateId(r.u32()?),
            DoorMemory {
                open: r.bool()?,
                locked: r.bool()?,
            },
        );
    }
    Ok(Some(Memory {
        discovered,
        seen,
        surveyed,
        items,
        gates,
        revision: r.u64()?,
    }))
}

pub fn put_cues(w: &mut Vec<f64>, cues: &[Cue]) {
    w.size(cues.len());
    for cue in cues {
        w.point(cue.at);
        w.int(cue.tick);
        w.int(cue.until);
    }
}

pub fn get_cues(r: &mut Reader) -> Result<Vec<Cue>> {
    let count = r.count(CUE_STRIDE)?;
    (0..count)
        .map(|_| {
            Ok(Cue {
                at: r.point()?,
                tick: r.u32()?,
                until: r.u32()?,
            })
        })
        .collect()
}

/// A completed tick as the live adapter sends it. The solved paths stay in Rust.
#[derive(Debug, PartialEq)]
pub struct DecodedTick {
    pub tick: Tick,
    pub inbound: Vec<Inbound>,
    pub changes: Changes,
    pub discontinuities: Vec<Discontinuity>,
    pub discovery: Discovery,
}

pub fn put_completed(w: &mut Vec<f64>, tick: &CompletedTick) {
    w.int(tick.tick);
    w.size(tick.inbound.len());
    for inbound in &tick.inbound {
        put_inbound(w, inbound);
    }
    put_changes(w, &tick.changes);
    w.size(tick.discontinuities.len());
    for &marker in &tick.discontinuities {
        put_discontinuity(w, marker);
    }
    put_discovery(w, &tick.discovery);
}

pub fn get_completed(r: &mut Reader) -> Result<DecodedTick> {
    let tick = r.u32()?;
    let count = r.count(INBOUND_STRIDE)?;
    let inbound = (0..count)
        .map(|_| get_inbound(r))
        .collect::<Result<Vec<_>>>()?;
    let changes = get_changes(r)?;
    let count = r.count(DISCONTINUITY_STRIDE)?;
    let discontinuities = (0..count)
        .map(|_| get_discontinuity(r))
        .collect::<Result<Vec<_>>>()?;
    Ok(DecodedTick {
        tick,
        inbound,
        changes,
        discontinuities,
        discovery: get_discovery(r)?,
    })
}

// ---- Setup

/// Everything a match start takes besides the map's handles.
pub struct Setup {
    pub seed: u64,
    pub time_limit: Tick,
    pub state: State,
    pub bodies: Vec<(BodyId, BodySpec)>,
    /// Loot linear and angular drag, then prop linear and angular drag.
    pub floor: [f64; 4],
    pub hazard_areas: Vec<[f64; 4]>,
    pub wall: Option<(f64, Tick)>,
    pub bounds: Option<[f64; 4]>,
    pub combat: Combat,
}

/// The map's handles, which JavaScript owns and the core copies.
#[derive(Clone, Copy, Default)]
pub struct Handles<'a> {
    pub swept: Option<&'a crate::swept::SweptMap>,
    pub sight: Option<(&'a SightIndex, &'a GateSet)>,
    pub discovery: Option<(&'a DiscoveryMap, &'a SightIndex, &'a GateSet)>,
}

fn put_surface(w: &mut Vec<f64>, surface: &MotorSurface) {
    let key: u32 = surface
        .id
        .parse()
        .expect("a codec surface ID is its numeric key");
    w.int(key);
    w.push(surface.priority);
    w.point(surface.origin);
    w.point(surface.size);
    w.extend([surface.speed, surface.traction, surface.braking]);
    put_option(w, 1, surface.drag, |w, drag| w.push(drag));
}

fn get_surface(r: &mut Reader) -> Result<MotorSurface> {
    Ok(MotorSurface {
        id: format!("{:010}", r.u32()?),
        priority: r.finite()?,
        origin: r.point()?,
        size: r.point()?,
        speed: r.finite()?,
        traction: r.finite()?,
        braking: r.finite()?,
        drag: r.option(1, |r| r.finite())?,
    })
}

fn put_body(w: &mut Vec<f64>, id: BodyId, spec: &BodySpec) {
    let p = &spec.params;
    w.body(id);
    w.int(p.kind);
    w.flag(p.map_geometry);
    w.int(spec.shape);
    w.extend(spec.dimensions);
    w.extend(p.pose);
    w.extend(p.material);
    for damping in p.damping {
        put_option(w, 1, damping, |w, value| w.push(value));
    }
    w.int(p.groups);
    w.flag(p.kind == KIND_PROP && p.groups >> 16 == LOOT_GROUP);
    w.push(spec.speed_limit);
    w.push(spec.tip_radius);
    w.size(spec.vertices.len() / 2);
    w.extend(&spec.vertices);
}

fn get_body_spec(r: &mut Reader) -> Result<(BodyId, BodySpec)> {
    let id = r.body()?;
    let kind = r.u32()?;
    let map_geometry = r.bool()?;
    let shape = r.u32()?;
    let dimensions = [r.finite()?, r.finite()?];
    let mut pose = [0.0; 6];
    for word in &mut pose {
        *word = r.finite()?;
    }
    let mut material = [0.0; 3];
    for word in &mut material {
        *word = r.finite()?;
    }
    let damping = [r.option(1, |r| r.finite())?, r.option(1, |r| r.finite())?];
    let groups = r.u32()?;
    r.bool()?;
    let speed_limit = r.finite()?;
    let tip_radius = r.finite()?;
    let count = r.count(2)?;
    let mut vertices = Vec::with_capacity(count * 2);
    for _ in 0..count * 2 {
        vertices.push(r.finite()?);
    }
    if !physics::shape_valid(shape, dimensions[0], dimensions[1], &vertices) {
        return r.fail("not a valid body shape");
    }
    Ok((
        id,
        BodySpec {
            params: BodyParams {
                kind,
                map_geometry,
                pose,
                material,
                damping,
                groups,
            },
            shape,
            dimensions,
            vertices,
            speed_limit,
            tip_radius,
        },
    ))
}

fn put_tuning(w: &mut Vec<f64>, combat: &Combat) {
    let start = w.len();
    let m = &combat.movement;
    w.extend(m.motor.base_speed);
    w.extend(m.motor.boost);
    w.extend([
        m.motor.stun,
        m.motor.sneak,
        m.motor.acceleration,
        m.motor.braking,
    ]);
    let h = &m.hook;
    w.extend([
        h.range,
        h.speed,
        h.max_force,
        h.stiffness,
        h.damping,
        h.pull_speed,
    ]);
    w.int(h.duration);
    w.int(h.cooldown);
    w.extend([h.standoff, h.target_distance, h.break_distance]);
    w.int(m.boost_duration);
    w.int(m.boost_cooldown);
    let rules = &combat.rules;
    for weapon in &rules.weapons {
        assert!(
            weapon.spread.len() <= MAX_SPREAD,
            "spread exceeds the codec"
        );
        w.extend([weapon.damage, weapon.speed]);
        w.int(weapon.life);
        w.int(weapon.cooldown);
        w.size(weapon.spread.len());
        let at = w.len();
        w.extend(&weapon.spread);
        w.pad_to(at + MAX_SPREAD);
    }
    w.extend(rules.melee_damage);
    w.int(rules.warden_cooldown);
    w.int(rules.specter_cooldown);
    w.int(rules.respawn_ticks);
    put_option(w, 6, rules.hearing.as_ref(), |w, hearing| {
        w.extend(hearing.ranges);
        w.int(hearing.ticks);
        w.extend([hearing.width, hearing.height]);
    });
    let items = &combat.items;
    w.flag(items.reloading);
    w.flag(items.quality_damage);
    w.size(items.drops.ground_capacity);
    w.size(items.drops.optional_body_capacity);
    w.size(items.drops.body_capacity);
    w.size(items.drops.drop_reserve);
    let i = &combat.interactions;
    w.int(i.charge_ticks);
    w.extend([i.transit_base, i.transit_per_unit]);
    let hz = &combat.hazards;
    w.extend([
        hz.mine.trigger,
        hz.mine.blast,
        hz.mine.damage,
        hz.mine.world_impulse,
        hz.mine.actor_impulse_limit,
        hz.turret.range,
    ]);
    w.int(hz.turret.cooldown);
    w.extend([hz.turret.speed, hz.turret.damage]);
    w.int(hz.turret.life);
    w.int(hz.flame.cycle);
    w.int(hz.flame.warn_at);
    w.int(hz.flame.fire_at);
    w.int(hz.flame.interval);
    w.extend([hz.flame.range, hz.flame.cone, hz.flame.damage]);
    w.extend([
        hz.spider.leash,
        hz.spider.acquire,
        hz.spider.step,
        hz.spider.grapple,
    ]);
    w.int(hz.spider.cooldown);
    w.int(hz.spider.stun);
    w.push(hz.spider.damage);
    debug_assert_eq!(w.len() - start, TUNING_WORDS);
}

#[allow(clippy::field_reassign_with_default)]
fn get_tuning(r: &mut Reader, surfaces: Vec<MotorSurface>) -> Result<Combat> {
    let mut movement = Movement::default();
    movement.motor = MotorTuning {
        base_speed: [r.finite()?, r.finite()?],
        boost: [r.finite()?, r.finite()?],
        stun: r.finite()?,
        sneak: r.finite()?,
        acceleration: r.finite()?,
        braking: r.finite()?,
    };
    movement.hook = HookTuning {
        range: r.finite()?,
        speed: r.finite()?,
        max_force: r.finite()?,
        stiffness: r.finite()?,
        damping: r.finite()?,
        pull_speed: r.finite()?,
        duration: r.u32()?,
        cooldown: r.u32()?,
        standoff: r.finite()?,
        target_distance: r.finite()?,
        break_distance: r.finite()?,
    };
    movement.boost_duration = r.u32()?;
    movement.boost_cooldown = r.u32()?;
    let movement = movement.with_surfaces(surfaces);
    let mut rules = CombatRules::default();
    for weapon in &mut rules.weapons {
        let (damage, speed) = (r.finite()?, r.finite()?);
        let (life, cooldown) = (r.u32()?, r.u32()?);
        let count = r.u32()? as usize;
        if count > MAX_SPREAD {
            return r.fail("spread count exceeds the maximum");
        }
        let spread = r.padded(MAX_SPREAD, |r| {
            (0..count).map(|_| r.finite()).collect::<Result<Vec<_>>>()
        })?;
        *weapon = WeaponTuning {
            damage,
            speed,
            life,
            cooldown,
            spread,
        };
    }
    for damage in &mut rules.melee_damage {
        *damage = r.finite()?;
    }
    rules.warden_cooldown = r.u32()?;
    rules.specter_cooldown = r.u32()?;
    rules.respawn_ticks = r.u32()?;
    rules.hearing = r.option(6, |r| {
        Ok(Hearing {
            ranges: [r.finite()?, r.finite()?, r.finite()?],
            ticks: r.u32()?,
            width: r.finite()?,
            height: r.finite()?,
        })
    })?;
    let items = ItemRules {
        reloading: r.bool()?,
        quality_damage: r.bool()?,
        drops: DropTuning {
            ground_capacity: r.u32()? as usize,
            optional_body_capacity: r.u32()? as usize,
            body_capacity: r.u32()? as usize,
            drop_reserve: r.u32()? as usize,
        },
    };
    let interactions = InteractionRules {
        charge_ticks: r.u32()?,
        transit_base: r.finite()?,
        transit_per_unit: r.finite()?,
    };
    let hazards = HazardRules {
        mine: MineTuning {
            trigger: r.finite()?,
            blast: r.finite()?,
            damage: r.finite()?,
            world_impulse: r.finite()?,
            actor_impulse_limit: r.finite()?,
        },
        turret: TurretTuning {
            range: r.finite()?,
            cooldown: r.u32()?,
            speed: r.finite()?,
            damage: r.finite()?,
            life: r.u32()?,
        },
        flame: FlameTuning {
            cycle: r.u32()?,
            warn_at: r.u32()?,
            fire_at: r.u32()?,
            interval: r.u32()?,
            range: r.finite()?,
            cone: r.finite()?,
            damage: r.finite()?,
        },
        spider: SpiderTuning {
            leash: r.finite()?,
            acquire: r.finite()?,
            step: r.finite()?,
            grapple: r.finite()?,
            cooldown: r.u32()?,
            stun: r.u32()?,
            damage: r.finite()?,
        },
    };
    Ok(Combat {
        movement,
        rules,
        items,
        interactions,
        hazards,
    })
}

impl Setup {
    pub fn encode(&self) -> Vec<f64> {
        let mut w = Vec::new();
        w.int(self.seed >> 32);
        w.int(self.seed & 0xffff_ffff);
        w.int(self.time_limit);
        put_state(&mut w, &self.state);
        w.size(self.bodies.len());
        for (id, spec) in &self.bodies {
            put_body(&mut w, *id, spec);
        }
        let surfaces = self.combat.movement.surfaces();
        w.size(surfaces.len());
        for surface in surfaces {
            put_surface(&mut w, surface);
        }
        w.extend(self.floor);
        w.size(self.hazard_areas.len());
        for area in &self.hazard_areas {
            w.extend(area);
        }
        put_option(&mut w, 2, self.wall, |w, (width, grace)| {
            w.push(width);
            w.int(grace);
        });
        put_option(&mut w, 4, self.bounds, |w, bounds| w.extend(bounds));
        put_tuning(&mut w, &self.combat);
        w
    }

    /// Decodes a whole buffer. Any malformed or leftover word is an error.
    pub fn decode(words: &[f64]) -> Result<Self> {
        let mut r = Reader::new(words);
        let seed = (u64::from(r.u32()?) << 32) | u64::from(r.u32()?);
        let time_limit = r.u32()?;
        let state = get_state(&mut r)?;
        let count = r.count(BODY_HEADER)?;
        let mut bodies = Vec::with_capacity(count);
        let mut seen = BTreeSet::new();
        for _ in 0..count {
            let (id, spec) = get_body_spec(&mut r)?;
            if !seen.insert(id) {
                return r.fail("duplicate body ID");
            }
            bodies.push((id, spec));
        }
        let count = r.count(SURFACE_ROW)?;
        let surfaces = (0..count)
            .map(|_| get_surface(&mut r))
            .collect::<Result<Vec<_>>>()?;
        let floor = [r.finite()?, r.finite()?, r.finite()?, r.finite()?];
        let count = r.count(4)?;
        let hazard_areas = (0..count)
            .map(|_| Ok([r.finite()?, r.finite()?, r.finite()?, r.finite()?]))
            .collect::<Result<Vec<_>>>()?;
        let wall = r.option(2, |r| Ok((r.finite()?, r.u32()?)))?;
        let bounds = r.option(4, |r| {
            Ok([r.finite()?, r.finite()?, r.finite()?, r.finite()?])
        })?;
        let combat = get_tuning(&mut r, surfaces)?;
        if !r.is_empty() {
            return r.fail("trailing words");
        }
        Ok(Self {
            seed,
            time_limit,
            state,
            bodies,
            floor,
            hazard_areas,
            wall,
            bounds,
            combat,
        })
    }

    /// Builds the scenario, copying the handles' maps so JavaScript's gate mask and polygon
    /// buffers never alias the match's.
    #[allow(clippy::field_reassign_with_default)]
    pub fn into_scenario(self, handles: Handles<'_>) -> (Scenario, Combat, u64, Tick) {
        let mut scenario = Scenario::default();
        scenario.state = self.state;
        for (id, spec) in self.bodies {
            scenario.body(id, spec);
        }
        let [loot, loot_angular, prop, prop_angular] = self.floor;
        scenario.floor_drag(
            self.combat
                .movement
                .floor_drag([loot, loot_angular], [prop, prop_angular]),
        );
        for area in self.hazard_areas {
            scenario.hazard_area(area);
        }
        if let Some((width, grace)) = self.wall {
            scenario.hazard_wall(width, grace);
        }
        if let Some([x0, y0, x1, y1]) = self.bounds {
            scenario.bounds([x0, y0], [x1, y1]);
        }
        if let Some(swept) = handles.swept {
            scenario.geometry(std::sync::Arc::new(swept.clone()));
        }
        if let Some((index, gates)) = handles.sight {
            scenario.sight(
                std::sync::Arc::new(index.clone()),
                std::sync::Arc::new(gates.clone()),
            );
        }
        if let Some((map, index, gates)) = handles.discovery {
            scenario.discovery(map.clone(), index.clone(), gates.clone());
        }
        (scenario, self.combat, self.seed, self.time_limit)
    }
}

// ---- The live match

/// A match the WASM exports own: the new tick, its rules, and the buffers JavaScript reads.
pub struct LiveMatch {
    game: Match,
    rules: Combat,
    input: Vec<f64>,
    flags: Vec<u8>,
    output: Vec<f64>,
}

impl LiveMatch {
    pub fn new(setup: &[f64], handles: Handles<'_>) -> Result<Self> {
        let (scenario, rules, seed, time_limit) = Setup::decode(setup)?.into_scenario(handles);
        Ok(Self {
            game: scenario.start(seed, time_limit),
            rules,
            input: Vec::new(),
            flags: Vec::new(),
            output: Vec::new(),
        })
    }

    /// The input buffer, resized to `words`. Each call may move it.
    pub fn input(&mut self, words: usize) -> &mut [f64] {
        self.input.resize(words, 0.0);
        &mut self.input
    }

    /// Submits the first `count` inbound rows of the input buffer for `tick`, one flag per row:
    /// 1 when the match queued it. A row that does not decode is refused with the rest unharmed.
    pub fn submit(&mut self, tick: Tick, count: usize) -> u32 {
        self.flags.clear();
        let mut accepted = 0;
        for row in 0..count {
            let words = self
                .input
                .get(row * INBOUND_STRIDE..(row + 1) * INBOUND_STRIDE);
            let queued = words
                .and_then(|words| get_inbound(&mut Reader::new(words)).ok())
                .is_some_and(|item| self.game.submit(tick, item));
            self.flags.push(u8::from(queued));
            accepted += u32::from(queued);
        }
        accepted
    }

    pub fn flags(&self) -> &[u8] {
        &self.flags
    }

    /// Steps one tick and encodes it into the output buffer. False once the match is over.
    pub fn step(&mut self) -> bool {
        self.output.clear();
        let Some(tick) = self.game.step(&self.rules) else {
            return false;
        };
        put_completed(&mut self.output, &tick);
        true
    }

    pub fn snapshot(&mut self) {
        self.output.clear();
        let snapshot = self.game.snapshot();
        put_snapshot(&mut self.output, &snapshot);
    }

    pub fn memory(&mut self, actor: f64) {
        self.output.clear();
        let memory = word_actor(actor).and_then(|actor| self.game.memory(actor));
        put_memory(&mut self.output, memory);
    }

    pub fn heard(&mut self, actor: f64) {
        self.output.clear();
        let cues = word_actor(actor).map_or_else(Vec::new, |actor| self.game.heard(actor));
        put_cues(&mut self.output, &cues);
    }

    /// The last sequence spent for the actor, or -1.
    pub fn acknowledged(&self, actor: f64) -> f64 {
        word_actor(actor)
            .and_then(|actor| self.game.acknowledged(actor))
            .map_or(-1.0, |seq| seq as f64)
    }

    pub fn output(&self) -> &[f64] {
        &self.output
    }
}

fn word_actor(word: f64) -> Option<ActorId> {
    (word >= 0.0 && word.fract() == 0.0 && word <= SAFE_INTEGER as f64)
        .then(|| actor_from_word(word as u64))
        .flatten()
}
