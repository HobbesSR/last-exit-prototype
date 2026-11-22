//! The tick boundary's body work in the core (#1234, docs/27 "The state flip", step 5b.3): the body
//! sync (`synchronize` in `shared/simulation/game.ts`, with `synchronizePhysicalItems` from
//! `world-physics.ts`), phase 1's admission of the pending impulses and attachments (`tick.ts`), and
//! the placement search for a caller outside them (`placement.rs`).
//! It also runs the drop planner's spiral search for a drop planned in JavaScript (`scatter.rs`,
//! #1228), through the same input and output.
//!
//! `shared/simulation/boundary.ts` packs what each call still reads into the world's boundary input,
//! and this runs the rules over it, calling the world (`world.rs`) in the
//! order the TypeScript did, so Rapier allocates the same handles and slots.
//!
//! **What comes back is a log.** Each write the TypeScript made to a JavaScript record is an entry, in
//! the order it was made: a body queued (with what JavaScript needs to build its frozen spec), a
//! commit's facts, a teleport, a discontinuity marker, an actor's, item's or gate's bookkeeping, a
//! player's pose or retry. JavaScript applies the log in order when the call returns. A refusal stops
//! the run where the TypeScript threw: the log holds what was done before it, and the header names it.
//!
//! **The sync is one routine** (`synchronize`, #1214 stage 6d.6): the actors, the gates and the item bodies whose
//! records left the ground; the item admission when there is room; the pending queues' generation filter; then the
//! hooks' reconcile (`hooks::reconcile_into`). The players, ground, launches, queues and hooks are the world's own, so
//! only the tick, the admission flag, the markers and their capacity cross.

use crate::collision::{CollisionMap, can_occupy, reach_clear};
use crate::ground;
use crate::hooks;
use crate::math::hypot;
use crate::phase_one::RESPAWNING;
use crate::placement::{Disk, loot_fits, placement};
use crate::scatter::scatter_point;
use crate::sight::{GateSet, SightIndex};
use crate::swept::SweptMap;
use crate::world::{BODY_ROW, Key, World};

/// Refusals beside `world::E_*`.
pub const E_NO_PLACEMENT: i32 = -17;
pub const E_DISCONTINUITY_CAPACITY: i32 = -18;
/// world.ts's `finite`: a value that is not finite or exceeds 1e9 in magnitude.
pub const E_UNREPRESENTABLE: i32 = -19;
/// validateBody's initial speed check.
pub const E_INITIAL_SPEED: i32 = -20;

/// The output header: the refusal code (0 when none), the refused key and player or item reference
/// (-1 when none), a word no call now writes (0; the body sync reported its room there until 6d.6), how many commands
/// stay queued, and the output's length in words.
pub const OUT_HEADER: usize = 6;

/// Log entries, each its code followed by fixed words.
/// `key, template, reference, x, y, vx, vy`: a body queued from a template.
pub const OP_QUEUED: f64 = 1.0;
/// `code, count`, then `count` facts of `world::World::commit`: its refusal code (0 when done), then
/// the facts of what it did.
pub const OP_COMMIT: f64 = 2.0;
/// `key`: an actor teleported, which clears its motor.
pub const OP_TRANSFORM: f64 = 3.0;
/// `kind` (`MARK_PLACED` or `MARK_REMOVED`), `key`, `generation` (-1 for none).
pub const OP_MARK: f64 = 4.0;
/// `key, added`: the runtime's actor set.
pub const OP_ACTOR: f64 = 5.0;
/// `player, x, y`: a player's pose.
pub const OP_POSE: f64 = 6.0;
/// `player, respawnAt`: a gladiator that could not be placed waits for the next boundary.
pub const OP_RETRY: f64 = 7.0;
/// `gate, pushed, forced`: what the world last saw of the gate; `forced` when a closing was refused.
pub const OP_GATE: f64 = 8.0;
/// `key, added, reference`: the runtime's item set; an added item leaves the admission order.
pub const OP_ITEM: f64 = 9.0;
/// `key, a, b, max distance`: an attachment the admission queued (6d.5), whose spec JavaScript adopts.
pub const OP_ATTACHMENT: f64 = 10.0;

/// A log entry, encoded by `Entry::encode` alone, so each kind's words and their count live in one
/// place. The codes and layouts are the `OP_*` constants above, which `shared/simulation/boundary.ts`
/// reads.
enum Entry {
    Queued {
        key: Key,
        template: f64,
        reference: f64,
        pose: [f64; 4],
    },
    Commit {
        code: i32,
    },
    Transform {
        key: Key,
    },
    Mark {
        kind: f64,
        key: Key,
        generation: f64,
    },
    Actor {
        key: Key,
        added: bool,
    },
    Pose {
        player: f64,
        x: f64,
        y: f64,
    },
    Retry {
        player: f64,
        respawn_at: f64,
    },
    Gate {
        index: f64,
        pushed: f64,
        forced: bool,
    },
    Item {
        key: Key,
        added: bool,
        reference: f64,
    },
    /// An attachment the admission queued (6d.5), for JavaScript's spec table.
    Attachment {
        key: Key,
        a: Key,
        b: Key,
        max_distance: f64,
    },
}

impl Entry {
    /// Appends the entry's words. A commit's facts follow it, from the world's output.
    fn encode(&self, out: &mut Vec<f64>) {
        let flag = |b: bool| f64::from(u8::from(b));
        match *self {
            Entry::Queued {
                key,
                template,
                reference,
                pose: [x, y, vx, vy],
            } => out.extend_from_slice(&[
                OP_QUEUED,
                f64::from(key),
                template,
                reference,
                x,
                y,
                vx,
                vy,
            ]),
            Entry::Commit { code } => out.extend_from_slice(&[OP_COMMIT, f64::from(code)]),
            Entry::Transform { key } => out.extend_from_slice(&[OP_TRANSFORM, f64::from(key)]),
            Entry::Mark {
                kind,
                key,
                generation,
            } => out.extend_from_slice(&[OP_MARK, kind, f64::from(key), generation]),
            Entry::Actor { key, added } => {
                out.extend_from_slice(&[OP_ACTOR, f64::from(key), flag(added)])
            }
            Entry::Pose { player, x, y } => out.extend_from_slice(&[OP_POSE, player, x, y]),
            Entry::Retry { player, respawn_at } => {
                out.extend_from_slice(&[OP_RETRY, player, respawn_at])
            }
            Entry::Gate {
                index,
                pushed,
                forced,
            } => out.extend_from_slice(&[OP_GATE, index, pushed, flag(forced)]),
            Entry::Item {
                key,
                added,
                reference,
            } => out.extend_from_slice(&[OP_ITEM, f64::from(key), flag(added), reference]),
            Entry::Attachment {
                key,
                a,
                b,
                max_distance,
            } => out.extend_from_slice(&[
                OP_ATTACHMENT,
                f64::from(key),
                f64::from(a),
                f64::from(b),
                max_distance,
            ]),
        }
    }
}

pub const MARK_PLACED: f64 = 0.0;
pub const MARK_REMOVED: f64 = 1.0;

/// Body templates: which spec JavaScript builds for a queued body.
pub const TEMPLATE_CONTESTANT: f64 = 0.0;
pub const TEMPLATE_GLADIATOR: f64 = 1.0;
pub const TEMPLATE_LOOT: f64 = 2.0;
pub const TEMPLATE_GATE: f64 = 3.0;

/// A refusal: its code, the key it names and the reference JavaScript reports it by.
type Refusal = (i32, f64, f64);

fn refused(code: i32) -> Refusal {
    (code, -1.0, -1.0)
}

/// world.ts's `finite`.
fn representable(n: f64) -> bool {
    n.is_finite() && n.abs() <= 1e9
}

/// The log and the discontinuity markers it emulates (`markPhysicsDiscontinuity`).
struct Log {
    out: Vec<f64>,
    markers: Vec<Key>,
    capacity: usize,
    /// The players' poses and retries this call logged, in order, for the core's player store (#1214 stage 6c.2).
    players: Vec<Entry>,
}

impl Log {
    fn entry(&mut self, entry: Entry) {
        entry.encode(&mut self.out);
        match entry {
            Entry::Pose { player, x, y } => self.players.push(Entry::Pose { player, x, y }),
            Entry::Retry { player, respawn_at } => {
                self.players.push(Entry::Retry { player, respawn_at })
            }
            _ => {}
        }
    }

    /// A call's answer words, for the calls that return answers rather than a log.
    fn answer(&mut self, words: &[f64]) {
        self.out.extend_from_slice(words);
    }

    /// A marker for the body as it now stands. Only the latest per ID is kept, within the capacity.
    fn mark(&mut self, world: &World, kind: f64, key: Key) -> Result<(), Refusal> {
        let generation = world.generation(key);
        if !self.markers.contains(&key) {
            if self.markers.len() >= self.capacity {
                return Err(refused(E_DISCONTINUITY_CAPACITY));
            }
            self.markers.push(key);
        }
        self.entry(Entry::Mark {
            kind,
            key,
            generation,
        });
        Ok(())
    }

    /// Commits the world's queues and logs the facts, including those of a commit that stops.
    fn commit(&mut self, world: &mut World) -> Result<(), Refusal> {
        let code = world.commit();
        let facts = world.output();
        Entry::Commit { code }.encode(&mut self.out);
        self.out.extend_from_slice(facts);
        if code < 0 { Err(refused(code)) } else { Ok(()) }
    }

    fn remove(&mut self, world: &mut World, key: Key) -> Result<(), Refusal> {
        let code = world.queue_remove_body(key);
        if code < 0 {
            Err((code, f64::from(key), -1.0))
        } else {
            Ok(())
        }
    }

    /// Queues a body from `template` (a row with no vertices) at the pose, checked as `validateBody`
    /// checks the values that differ from the template's.
    #[allow(clippy::too_many_arguments)]
    fn queue(
        &mut self,
        world: &mut World,
        template: &[f64],
        kind: f64,
        key: Key,
        reference: f64,
        pose: [f64; 4],
    ) -> Result<(), Refusal> {
        let [x, y, vx, vy] = pose;
        let invalid = if !pose.iter().all(|&n| representable(n)) {
            Some(E_UNREPRESENTABLE)
        } else if template[1] != 0.0 && hypot(vx, vy) + 0.0 > template[19] {
            // A dynamic body's speed: `hypot(vx, vy) + |omega| * tip`, with no spin.
            Some(E_INITIAL_SPEED)
        } else {
            None
        };
        if let Some(code) = invalid {
            // world.ts checks the queue before throwing a validation error.
            let full = world.check_queue();
            return Err(refused(if full < 0 { full } else { code }));
        }
        let mut row = [0.0; BODY_ROW];
        row.copy_from_slice(&template[..BODY_ROW]);
        row[0] = f64::from(key);
        row[6] = x;
        row[7] = y;
        row[9] = vx;
        row[10] = vy;
        let code = world.queue_add_row(&row);
        if code < 0 {
            return Err((code, f64::from(key), -1.0));
        }
        self.entry(Entry::Queued {
            key,
            template: kind,
            reference,
            pose: [x, y, vx, vy],
        });
        Ok(())
    }
}

fn keys(words: &[f64]) -> Vec<Key> {
    words.iter().map(|&k| k as Key).collect()
}

/// Runs `body` over the world's boundary input and fills its output: the header, then the log.
fn run(
    world: &mut World,
    body: impl FnOnce(&mut World, &mut [f64], &mut Log, &mut [f64; OUT_HEADER]) -> Result<(), Refusal>,
) {
    let mut input = std::mem::take(&mut world.boundary_input);
    let mut out = std::mem::take(&mut world.boundary_output);
    out.clear();
    out.extend_from_slice(&[0.0; OUT_HEADER]);
    let mut log = Log {
        out,
        markers: Vec::new(),
        capacity: 0,
        players: Vec::new(),
    };
    let mut header = [0.0, -1.0, -1.0, 0.0, 0.0, 0.0];
    if let Err((code, key, reference)) = body(world, &mut input, &mut log, &mut header) {
        header[0] = f64::from(code);
        header[1] = key;
        header[2] = reference;
    }
    apply_players(world, &mut log);
    header[4] = world.queued_count() as f64;
    header[5] = log.out.len() as f64;
    log.out[..OUT_HEADER].copy_from_slice(&header);
    world.boundary_input = input;
    world.boundary_output = log.out;
}

/// The sync's input (#1214 stage 6d.6): the tick, whether items are admitted, the markers' capacity, the roster's size,
/// then the markers' count and keys. Everything else is the world's: the players from its store, the body templates,
/// drop reserve and hook tuning from its settings (`World::configure_sync`), the launches, the ground and the hooks.
const S_TICK: usize = 0;
const S_ADMIT: usize = 1;
const S_CAPACITY: usize = 2;
const S_PLAYERS: usize = 3;
const S_MARKERS: usize = 4;
pub const S_HEADER: usize = 5;
/// Per active actor, in ID order: `key, player, gladiator, x, y`, built from the core's player store (6c.3a).
const ACTOR_STRIDE: usize = 5;

/// The store takes the same writes JavaScript applies to its records: the poses and retries logged so far, applied
/// now so a later step reads them, refusal or not. A store that does not hold the roster yet (before the first upload)
/// is left for that upload.
fn apply_players(world: &mut World, log: &mut Log) {
    for entry in std::mem::take(&mut log.players) {
        match entry {
            Entry::Pose { player, x, y } => {
                if let Some(r) = world.players.rows.get_mut(player as usize) {
                    r.x = x;
                    r.y = y;
                }
            }
            Entry::Retry { player, respawn_at } => {
                let i = player as usize;
                if let (Some(r), Some(e)) = (
                    world.players.rows.get_mut(i),
                    world.players.extra.get_mut(i),
                ) {
                    r.status = RESPAWNING;
                    e.respawn_at = respawn_at;
                }
            }
            _ => {}
        }
    }
}

/// The whole body sync, as Node's `synchronize` ran it in four calls (#1214 stage 6d.6): the actors, the gates and the
/// item bodies whose records left the ground; then, when items are admitted and there is room, the launches and the
/// records awaiting a body; then the pending queues' generation filter; then the hooks' reconcile. One log holds them
/// all, in that order; the hooks' entries (`hooks::OP_COMMIT`, which is `OP_COMMIT`, and `hooks::OP_REMOVED`) come
/// last. A refusal stops the sync where it is, as each call's throw stopped Node's.
pub fn synchronize(
    world: &mut World,
    map: &mut CollisionMap,
    gates: &mut GateSet,
    swept: &SweptMap,
) {
    run(world, |world, input, log, _| {
        let markers = input[S_MARKERS] as usize;
        log.markers = keys(&input[S_HEADER..S_HEADER + markers]);
        log.capacity = input[S_CAPACITY] as usize;
        let (tick, players) = (input[S_TICK], input[S_PLAYERS] as usize);
        let bodies = bodies(world, map, gates, log, tick);
        // The markers as each step leaves them, for a sync the core runs itself (#1214 stage 6d.5).
        world.markers = log.markers.clone();
        apply_players(world, log);
        let live = bodies?;
        world.sync_actors = live;
        if input[S_ADMIT] != 0.0 {
            let reserve_actors = players.saturating_sub(live);
            // With no launched item and no room beyond the reserves, nothing can be admitted.
            let room = !world.launches.is_empty()
                || world.can_add_bodies(1 + reserve_actors + world.sync_config.drop_reserve);
            if room {
                let done = items(world, map, gates, log, reserve_actors);
                world.markers = log.markers.clone();
                done?;
            }
        }
        world.filter_pending();
        let words = std::mem::take(&mut world.sync_config.hook);
        let reconciled = hooks::reconcile_into(world, swept, gates, tick, &words, &mut log.out);
        world.sync_config.hook = words;
        reconciled.map_err(|(code, key)| (code, key, -1.0))
    });
}

/// The body sync inside another run (#1214 stage 6d.6b): as `r.synchronize()` ran it at a stop, admitting items, from
/// the world's markers. Returns the sync's header and log, for the run's output.
pub(crate) fn synchronize_in_run(
    world: &mut World,
    map: &mut CollisionMap,
    gates: &mut GateSet,
    swept: &SweptMap,
    tick: f64,
    capacity: f64,
    roster: f64,
) -> Vec<f64> {
    let markers: Vec<f64> = world.markers.iter().map(|&k| f64::from(k)).collect();
    world.boundary_input.clear();
    world
        .boundary_input
        .extend_from_slice(&[tick, 1.0, capacity, roster, markers.len() as f64]);
    world.boundary_input.extend_from_slice(&markers);
    synchronize(world, map, gates, swept);
    world.boundary_output.clone()
}

/// The sync's first step: the actors, then the gates, then the item bodies whose items left the ground. Returns how
/// many actor bodies the world then holds (the runtime's `actors.size`).
fn bodies(
    world: &mut World,
    map: &mut CollisionMap,
    gates: &mut GateSet,
    log: &mut Log,
    tick: f64,
) -> Result<usize, Refusal> {
    let store = &world.players;
    let mut active: Vec<usize> = (0..store.len())
        .filter(|&i| store.rows[i].status == 0.0)
        .collect();
    active.sort_by(|&a, &b| store.rows[a].rank.total_cmp(&store.rows[b].rank));
    let mut rows: Vec<[f64; ACTOR_STRIDE]> = active
        .iter()
        .map(|&i| {
            let (r, e) = (&store.rows[i], &store.extra[i]);
            [
                e.key,
                i as f64,
                if r.role != 0.0 { 1.0 } else { 0.0 },
                r.x,
                r.y,
            ]
        })
        .collect();
    let radius = |world: &World, row: &[f64; ACTOR_STRIDE]| {
        world.sync_config.templates[usize::from(row[2] != 0.0)][4]
    };
    let key_of = |row: &[f64; ACTOR_STRIDE]| row[0] as Key;
    // The actors that are no longer active leave, in ID order.
    let wanted: Vec<Key> = rows.iter().map(key_of).collect();
    // The actor bodies the world holds (#1214 stage 6d.2): the runtime's `actors` until then.
    let mut live = world.keys_with_prefix("actor:");
    live.sort_by(|&a, &b| world.id_order(a, b));
    for key in live.clone() {
        if wanted.contains(&key) {
            continue;
        }
        log.mark(world, MARK_REMOVED, key)?;
        log.remove(world, key)?;
        log.entry(Entry::Actor { key, added: false });
        live.retain(|&k| k != key);
    }
    log.commit(world)?;
    // Then each active actor, in ID order, is placed where its record says, or nearest it.
    let mut admitted: Vec<usize> = Vec::new();
    for at in 0..rows.len() {
        let row = rows[at];
        let key = key_of(&row);
        let (player, gladiator) = (row[1], row[2] != 0.0);
        let (x, y) = (row[3], row[4]);
        let current = world.position(key);
        if current.is_some_and(|(cx, cy)| hypot(cx - x, cy - y) < 1e-6) {
            admitted.push(at);
            continue;
        }
        let disks: Vec<Disk> = admitted
            .iter()
            .copied()
            .chain((0..rows.len()).filter(|&q| q != at && live.contains(&key_of(&rows[q]))))
            .map(|q| [rows[q][3], rows[q][4], radius(world, &rows[q])])
            .collect();
        let r = radius(world, &row);
        let Some((px, py)) = placement(world, map, gates, r, (x, y), &disks) else {
            if let Some((cx, cy)) = current {
                rows[at][3] = cx;
                rows[at][4] = cy;
                log.entry(Entry::Pose {
                    player,
                    x: cx,
                    y: cy,
                });
                admitted.push(at);
                continue;
            }
            // A gladiator's respawn retries at a later boundary; an initial contestant is refused.
            if gladiator && tick > 0.0 {
                log.entry(Entry::Retry {
                    player,
                    respawn_at: tick + 1.0,
                });
                continue;
            }
            return Err((E_NO_PLACEMENT, f64::from(key), player));
        };
        rows[at][3] = px;
        rows[at][4] = py;
        log.entry(Entry::Pose {
            player,
            x: px,
            y: py,
        });
        if current.is_some() {
            if !representable(px) || !representable(py) {
                return Err(refused(E_UNREPRESENTABLE));
            }
            let code = world.set_transform(key, px, py, 0.0);
            if code < 0 {
                return Err((code, f64::from(key), -1.0));
            }
            log.entry(Entry::Transform { key });
        } else {
            let kind = if gladiator {
                TEMPLATE_GLADIATOR
            } else {
                TEMPLATE_CONTESTANT
            };
            let template = world.sync_config.templates[usize::from(gladiator)].clone();
            log.queue(world, &template, kind, key, player, [px, py, 0.0, 0.0])?;
            log.entry(Entry::Actor { key, added: true });
            live.push(key);
            log.commit(world)?;
        }
        log.mark(world, MARK_PLACED, key)?;
        admitted.push(at);
    }
    // The gates whose state the world has not seen, in the legacy gate order. Their keys, closed rows and what the
    // world last saw of each are the world's own (#1214 stage 6d.2); the door state is the gate set's (6a).
    for g in 0..world.gate_bodies.order.len() {
        let i = world.gate_bodies.order[g];
        let (index, open, pushed) = (
            i as f64,
            gates.open[i] != 0,
            f64::from(world.gate_bodies.seen[i]),
        );
        if pushed == if open { 1.0 } else { 2.0 } {
            continue;
        }
        let key = world.gate_bodies.keys[i];
        let [bx, by, bw, bh] = gates.boxes[i];
        // `overlapsDynamicBox`'s box, as it centres `gateShape`.
        if !open && world.overlaps_dynamic_box(bw / 2.0, bh / 2.0, bx + bw / 2.0, by + bh / 2.0) {
            // Closing is refused while an actor or a solid prop is in the way; the gate stays open.
            gates.open[i] = 1;
            world.gate_bodies.seen[i] = 1;
            log.entry(Entry::Gate {
                index,
                pushed: 1.0,
                forced: true,
            });
            continue;
        }
        if pushed == 2.0 {
            log.remove(world, key)?;
        }
        if !open {
            let row = world.gate_bodies.rows[i].clone();
            log.queue(
                world,
                &row,
                TEMPLATE_GATE,
                key,
                index,
                [row[6], row[7], 0.0, 0.0],
            )?;
        }
        world.gate_bodies.seen[i] = if open { 1 } else { 2 };
        log.entry(Entry::Gate {
            index,
            pushed: if open { 1.0 } else { 2.0 },
            forced: false,
        });
        log.commit(world)?;
    }
    // The item bodies the world holds whose records the ground store no longer has (#1214 stage 6d.2), in ID order.
    let mut items: Vec<(Key, bool)> = world
        .keys_with_prefix("item:")
        .into_iter()
        .map(|key| (key, world.ground.holds(u64::from(key))))
        .collect();
    items.sort_by(|a, b| world.id_order(a.0, b.0));
    for (key, on_ground) in items {
        if on_ground {
            continue;
        }
        log.mark(world, MARK_REMOVED, key)?;
        log.remove(world, key)?;
        log.entry(Entry::Item {
            key,
            added: false,
            reference: -1.0,
        });
    }
    log.commit(world)?;
    Ok(live.len())
}

/// The sync's item admission, when there is room: launched items first, then the items awaiting a body, each placed
/// where it lies if the map, the solid props and the active actors leave room. The launches, the records awaiting a
/// body and the item bodies are the world's own (#1214 stage 6d.3); the active actors' disks come from its player
/// store in roster order, as the adapter packed them (6d.6).
fn items(
    world: &mut World,
    map: &mut CollisionMap,
    gates: &mut GateSet,
    log: &mut Log,
    reserve_actors: usize,
) -> Result<(), Refusal> {
    let config = &world.sync_config;
    let template = config.templates[TEMPLATE_LOOT as usize].clone();
    let radius = template[4];
    let drop_reserve = config.drop_reserve;
    let disks: Vec<Disk> = world
        .players
        .rows
        .iter()
        .filter(|r| r.status == 0.0)
        .map(|r| [r.x, r.y, config.templates[usize::from(r.role != 0.0)][4]])
        .collect();
    let mut items = world.keys_with_prefix("item:");
    let mut place = |world: &mut World, log: &mut Log, row: &[f64], reserve: usize| {
        let key = row[0] as Key;
        let (x, y) = (row[2], row[3]);
        if items.contains(&key)
            || !world.can_add_bodies(1 + reserve_actors + reserve)
            || !can_occupy(map, gates, x, y, radius, false, false)
            || !loot_fits(world, x, y, radius, &disks)
        {
            return Ok(());
        }
        let (vx, vy) = if row.len() > 4 {
            (row[4], row[5])
        } else {
            (0.0, 0.0)
        };
        log.queue(world, &template, TEMPLATE_LOOT, key, row[1], [x, y, vx, vy])?;
        items.push(key);
        world.stop_awaiting(key);
        log.entry(Entry::Item {
            key,
            added: true,
            reference: row[1],
        });
        log.commit(world)?;
        log.mark(world, MARK_PLACED, key)
    };
    // Each row: key, the record's id (the reference JavaScript finds it by), x, y, then a launch's motion.
    let row_of = |world: &World, key: Key| {
        world.ground.by_key(u64::from(key)).map(|r| {
            vec![
                f64::from(key),
                r.words[0],
                r.words[ground::X],
                r.words[ground::Y],
            ]
        })
    };
    // A preflighted transfer owns its released slots first: the launches in ID order, those still on the ground.
    let mut launched = std::mem::take(&mut world.launches);
    launched.sort_by(|a, b| world.id_order(a.0, b.0));
    for &(key, vx, vy) in &launched {
        if let Some(mut row) = row_of(world, key) {
            row.extend_from_slice(&[vx, vy]);
            place(world, log, &row, 0)?;
        }
    }
    // Then the records awaiting a body, in ID order, a launched one excepted. No item frees room, so the walk stops at
    // the first that finds none, where the TypeScript stopped packing chunks.
    let awaiting = world.waiting.clone();
    for key in awaiting {
        if launched.iter().any(|l| l.0 == key) {
            continue;
        }
        if !world.can_add_bodies(1 + reserve_actors + drop_reserve) {
            break;
        }
        if let Some(row) = row_of(world, key) {
            place(world, log, &row, drop_reserve)?;
        }
    }
    log.commit(world)
}

/// Phase 1's admission of the pending impulses and attachments, from the world's own queues (#1214 stage 6d.5): an
/// impulse whose body keeps its generation, an attachment whose actors keep theirs, within reach and in the clear. The
/// impulse queue empties; the admitted impulses are queued in order. Only once every one has queued does the attachment
/// queue empty and the admitted attachments queue, each reported for JavaScript's spec table, so an impulse the world
/// refuses leaves the attachments pending (review 975).
pub fn admit_pending(world: &mut World, index: &SightIndex, gates: &GateSet) {
    run(world, |world, _input, log, _| {
        let impulses = std::mem::take(&mut world.pending_impulses);
        let mut attachments = world.pending_attachments.clone();
        attachments.sort_by(|x, y| world.id_order(x.key, y.key));
        let pass_impulse: Vec<bool> = impulses
            .iter()
            .map(|p| world.has_body(p.0) && world.generation(p.0) == p.3)
            .collect();
        let actor =
            |world: &World, key: Key| world.has_body(key) && world.id_starts_with(key, "actor:");
        let pass_attachment: Vec<bool> = attachments
            .iter()
            .map(|p| match (world.position(p.a), world.position(p.b)) {
                (Some(a), Some(b)) => {
                    actor(world, p.a)
                        && actor(world, p.b)
                        && world.generation(p.a) == p.generation_a
                        && world.generation(p.b) == p.generation_b
                        && hypot(a.0 - b.0, a.1 - b.1) <= p.max_distance
                        && reach_clear(index, gates, a, b).0
                }
                _ => false,
            })
            .collect();
        for (p, pass) in impulses.iter().zip(&pass_impulse) {
            if *pass {
                let code = world.queue_push(true, p.0, p.1, p.2);
                if code < 0 {
                    return Err((code, f64::from(p.0), -1.0));
                }
            }
        }
        world.pending_attachments.clear();
        for (p, pass) in attachments.iter().zip(&pass_attachment) {
            if *pass {
                // The legacy form `validateConstraint` gives an attachment: no kind, only a maximum distance.
                let row = [
                    f64::from(p.key),
                    f64::from(p.a),
                    f64::from(p.b),
                    f64::NAN,
                    p.max_distance,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    f64::NAN,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                ];
                let code = world.queue_constraint_row(&row);
                if code < 0 {
                    return Err((code, f64::from(p.key), -1.0));
                }
                log.entry(Entry::Attachment {
                    key: p.key,
                    a: p.a,
                    b: p.b,
                    max_distance: p.max_distance,
                });
            }
        }
        Ok(())
    });
}

/// The placement search for a caller outside the sync and phase 1 (an instant transit's landing).
/// The input: `radius, x, y, count`, then the admitted actors' `x, y, radius`. The output, after the
/// header: whether a spot was found, and where.
pub fn place(world: &mut World, map: &mut CollisionMap, gates: &mut GateSet) {
    run(world, |world, input, log, _| {
        let (radius, origin, count) = (input[0], (input[1], input[2]), input[3] as usize);
        let disks: Vec<Disk> = input[4..4 + count * 3].as_chunks::<3>().0.to_vec();
        match placement(world, map, gates, radius, origin, &disks) {
            Some((x, y)) => log.answer(&[1.0, x, y]),
            None => log.answer(&[0.0, 0.0, 0.0]),
        }
        Ok(())
    });
}

/// The drop planner's spiral search (`scatter.rs`), for a drop planned in JavaScript. The input:
/// `x, y, phase, loot radius, actors, taken`, then the active actors' `x, y, radius`, then the
/// taken spots' `x, y`. The output, after the header: whether a spot was found, and where.
pub fn scatter(world: &mut World, map: &mut CollisionMap, index: &SightIndex, gates: &mut GateSet) {
    run(world, |world, input, log, _| {
        let (origin, phase, radius) = ((input[0], input[1]), input[2], input[3]);
        let (actors, taken) = (input[4] as usize, input[5] as usize);
        let disks: Vec<Disk> = input[6..6 + actors * 3].as_chunks::<3>().0.to_vec();
        let base = 6 + actors * 3;
        let spots: Vec<[f64; 2]> = input[base..base + taken * 2].as_chunks::<2>().0.to_vec();
        match scatter_point(
            world, map, index, gates, origin, phase, radius, &disks, &spots,
        ) {
            Some((x, y)) => log.answer(&[1.0, x, y]),
            None => log.answer(&[0.0, 0.0, 0.0]),
        }
        Ok(())
    });
}
