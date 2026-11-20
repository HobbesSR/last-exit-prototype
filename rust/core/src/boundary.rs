//! The tick boundary's body work in the core (#1234, docs/27 "The state flip", step 5b.3): the body
//! sync (`synchronize` in `shared/simulation/game.ts`, with `synchronizePhysicalItems` from
//! `world-physics.ts`), phase 1's admission of the pending impulses and attachments (`tick.ts`), and
//! the placement search for a caller outside them (`placement.rs`).
//! It also runs the drop planner's spiral search for a drop planned in JavaScript (`scatter.rs`,
//! #1228), through the same input and output.
//!
//! The state stays in JavaScript (D1). `shared/simulation/boundary.ts` packs what each call reads into
//! the world's boundary input, and this runs the rules over it, calling the world (`world.rs`) in the
//! order the TypeScript did, so Rapier allocates the same handles and slots.
//!
//! **What comes back is a log.** Each write the TypeScript made to a JavaScript record is an entry, in
//! the order it was made: a body queued (with what JavaScript needs to build its frozen spec), a
//! commit's facts, a teleport, a discontinuity marker, an actor's, item's or gate's bookkeeping, a
//! player's pose or retry. JavaScript applies the log in order when the call returns. A refusal stops
//! the run where the TypeScript threw: the log holds what was done before it, and the header names it.
//!
//! **The sync runs in two calls.** The first does the actors, the gates and the removal of item bodies
//! whose items left the ground, then reports whether any item could be admitted. Only then does
//! JavaScript pack the items awaiting a body, which on a large map are thousands, so a tick with no
//! room packs none, as the TypeScript skipped ordering them.

use crate::collision::{CollisionMap, can_occupy, reach_clear};
use crate::math::hypot;
use crate::placement::{Disk, loot_fits, placement};
use crate::scatter::scatter_point;
use crate::sight::{GateSet, SightIndex};
use crate::world::{BODY_ROW, Key, World};

/// Refusals beside `world::E_*`.
pub const E_NO_PLACEMENT: i32 = -17;
pub const E_DISCONTINUITY_CAPACITY: i32 = -18;
/// world.ts's `finite`: a value that is not finite or exceeds 1e9 in magnitude.
pub const E_UNREPRESENTABLE: i32 = -19;
/// validateBody's initial speed check.
pub const E_INITIAL_SPEED: i32 = -20;

/// The output header: the refusal code (0 when none), the refused key and player or item reference
/// (-1 when none), whether an item could be admitted (`synchronize_bodies` only), how many commands
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

/// `synchronize_bodies`' header: the tick, whether items are admitted, whether any item was
/// launched, the roster's size, the drop reserve, the markers' capacity, then the counts.
const A_TICK: usize = 0;
const A_ADMIT: usize = 1;
const A_LAUNCHES: usize = 2;
const A_PLAYERS: usize = 3;
const A_DROP_RESERVE: usize = 4;
const A_CAPACITY: usize = 5;
const A_ACTORS: usize = 6;
const A_KNOWN: usize = 7;
const A_GATES: usize = 8;
const A_HELD: usize = 9;
const A_MARKERS: usize = 10;
pub const A_HEADER: usize = 11;
/// Per active player, in ID order: `key, player, gladiator, x, y`.
pub const ACTOR_STRIDE: usize = 5;
/// Per gate to reconcile, in the runtime's gate order: `gate, open, pushed, hx, hy, cx, cy, key`,
/// then the body's row when it is closed.
pub const GATE_STRIDE: usize = 8 + BODY_ROW;
/// Per held item body: `key, on ground`. JavaScript packs only those whose items left the ground.
pub const HELD_STRIDE: usize = 2;

/// `synchronize_items`' header: the actors' reserve (roster less actor bodies), the drop reserve,
/// the markers' capacity, then the counts.
const B_RESERVE_ACTORS: usize = 0;
const B_DROP_RESERVE: usize = 1;
const B_CAPACITY: usize = 2;
const B_LAUNCHES: usize = 3;
const B_WAITING: usize = 4;
const B_ACTIVE: usize = 5;
const B_HELD: usize = 6;
const B_MARKERS: usize = 7;
pub const B_HEADER: usize = 8;
/// Per launched item, in ID order: `key, reference, x, y, vx, vy`.
pub const LAUNCH_STRIDE: usize = 6;
/// Per item awaiting a body, in ID order: `key, reference, x, y`.
pub const WAITING_STRIDE: usize = 4;

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
}

impl Log {
    fn entry(&mut self, entry: Entry) {
        entry.encode(&mut self.out);
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
    };
    let mut header = [0.0, -1.0, -1.0, 0.0, 0.0, 0.0];
    if let Err((code, key, reference)) = body(world, &mut input, &mut log, &mut header) {
        header[0] = f64::from(code);
        header[1] = key;
        header[2] = reference;
    }
    header[4] = world.queued_count() as f64;
    header[5] = log.out.len() as f64;
    log.out[..OUT_HEADER].copy_from_slice(&header);
    world.boundary_input = input;
    world.boundary_output = log.out;
}

/// The sync's first call: the actors, then the gates, then the item bodies whose items left the
/// ground. The input, after the header: the contestant's and the gladiator's body rows, the actors,
/// the runtime's actor keys, the gates to reconcile, the held item bodies, then the markers' keys.
pub fn synchronize_bodies(world: &mut World, map: &mut CollisionMap, gates: &mut GateSet) {
    run(world, |world, input, log, header| {
        let count = |i: usize| input[i] as usize;
        let (actors, known, gate_count, held, markers) = (
            count(A_ACTORS),
            count(A_KNOWN),
            count(A_GATES),
            count(A_HELD),
            count(A_MARKERS),
        );
        let templates = A_HEADER;
        let actor_base = templates + 2 * BODY_ROW;
        let known_base = actor_base + actors * ACTOR_STRIDE;
        let gate_base = known_base + known;
        let held_base = gate_base + gate_count * GATE_STRIDE;
        let marker_base = held_base + held * HELD_STRIDE;
        log.markers = keys(&input[marker_base..marker_base + markers]);
        log.capacity = count(A_CAPACITY);
        let (tick, players, drop_reserve) =
            (input[A_TICK], count(A_PLAYERS), count(A_DROP_RESERVE));
        let template = |input: &[f64], gladiator: bool| {
            let at = templates + usize::from(gladiator) * BODY_ROW;
            input[at..at + BODY_ROW].to_vec()
        };
        let rows: Vec<usize> = (0..actors).map(|i| actor_base + i * ACTOR_STRIDE).collect();
        let row_keys: Vec<Key> = rows.iter().map(|&row| input[row] as Key).collect();
        let key_of = |row: usize| row_keys[(row - actor_base) / ACTOR_STRIDE];
        // The actors that are no longer active leave, in ID order.
        let wanted: Vec<Key> = rows.iter().map(|&row| key_of(row)).collect();
        let mut live = keys(&input[known_base..known_base + known]);
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
        let radius = |input: &[f64], row: usize| {
            input[templates + usize::from(input[row + 2] != 0.0) * BODY_ROW + 4]
        };
        let mut admitted: Vec<usize> = Vec::new();
        for &row in &rows {
            let key = key_of(row);
            let (player, gladiator) = (input[row + 1], input[row + 2] != 0.0);
            let (x, y) = (input[row + 3], input[row + 4]);
            let current = world.position(key);
            if current.is_some_and(|(cx, cy)| hypot(cx - x, cy - y) < 1e-6) {
                admitted.push(row);
                continue;
            }
            let disks: Vec<Disk> = admitted
                .iter()
                .copied()
                .chain(
                    rows.iter()
                        .copied()
                        .filter(|&q| q != row && live.contains(&key_of(q))),
                )
                .map(|q| [input[q + 3], input[q + 4], radius(input, q)])
                .collect();
            let r = radius(input, row);
            let Some((px, py)) = placement(world, map, gates, r, (x, y), &disks) else {
                if let Some((cx, cy)) = current {
                    input[row + 3] = cx;
                    input[row + 4] = cy;
                    log.entry(Entry::Pose {
                        player,
                        x: cx,
                        y: cy,
                    });
                    admitted.push(row);
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
            input[row + 3] = px;
            input[row + 4] = py;
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
                log.queue(
                    world,
                    &template(input, gladiator),
                    kind,
                    key,
                    player,
                    [px, py, 0.0, 0.0],
                )?;
                log.entry(Entry::Actor { key, added: true });
                live.push(key);
                log.commit(world)?;
            }
            log.mark(world, MARK_PLACED, key)?;
            admitted.push(row);
        }
        // The gates whose state the world has not seen, in the runtime's gate order.
        for g in 0..gate_count {
            let at = gate_base + g * GATE_STRIDE;
            let (index, open, pushed) = (input[at], input[at + 1] != 0.0, input[at + 2]);
            let key = input[at + 7] as Key;
            if !open
                && world.overlaps_dynamic_box(
                    input[at + 3],
                    input[at + 4],
                    input[at + 5],
                    input[at + 6],
                )
            {
                // Closing is refused while an actor or a solid prop is in the way; the gate stays open.
                gates.open[index as usize] = 1;
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
                let row = &input[at + 8..at + 8 + BODY_ROW];
                log.queue(
                    world,
                    row,
                    TEMPLATE_GATE,
                    key,
                    index,
                    [row[6], row[7], 0.0, 0.0],
                )?;
            }
            log.entry(Entry::Gate {
                index,
                pushed: if open { 1.0 } else { 2.0 },
                forced: false,
            });
            log.commit(world)?;
        }
        // The item bodies whose items are no longer on the ground leave, in ID order.
        let mut items: Vec<(Key, bool)> = (0..held)
            .map(|i| {
                let at = held_base + i * HELD_STRIDE;
                (input[at] as Key, input[at + 1] != 0.0)
            })
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
        // With no launched item and no room beyond the reserves, nothing can be admitted.
        let reserve = players.saturating_sub(live.len()) + drop_reserve;
        let room = input[A_LAUNCHES] != 0.0 || world.can_add_bodies(1 + reserve);
        header[3] = f64::from(u8::from(input[A_ADMIT] != 0.0 && room));
        Ok(())
    });
}

/// The sync's second call, when the first found room: launched items first, then the items awaiting
/// a body, each placed where it lies if the map, the solid props and the active actors leave room.
/// The input, after the header: the loot body's row, the active actors' disks, the held item keys,
/// the launches, the items awaiting a body, then the markers' keys.
///
/// The items awaiting a body come in chunks, in ID order: the header's flag word says whether this
/// chunk ran out with room left, so that JavaScript packs the next, which comes with no launches. On
/// a large map most are never packed, as the TypeScript never visited them once the world was full.
pub fn synchronize_items(world: &mut World, map: &mut CollisionMap, gates: &mut GateSet) {
    run(world, |world, input, log, header| {
        let count = |i: usize| input[i] as usize;
        let (launches, waiting, active, held, markers) = (
            count(B_LAUNCHES),
            count(B_WAITING),
            count(B_ACTIVE),
            count(B_HELD),
            count(B_MARKERS),
        );
        let template_at = B_HEADER;
        let active_base = template_at + BODY_ROW;
        let held_base = active_base + active * 3;
        let launch_base = held_base + held;
        let waiting_base = launch_base + launches * LAUNCH_STRIDE;
        let marker_base = waiting_base + waiting * WAITING_STRIDE;
        log.markers = keys(&input[marker_base..marker_base + markers]);
        log.capacity = count(B_CAPACITY);
        let template = input[template_at..template_at + BODY_ROW].to_vec();
        let radius = template[4];
        let disks: Vec<Disk> = input[active_base..held_base].as_chunks::<3>().0.to_vec();
        let mut items = keys(&input[held_base..launch_base]);
        let reserve_actors = count(B_RESERVE_ACTORS);
        let drop_reserve = count(B_DROP_RESERVE);
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
            log.entry(Entry::Item {
                key,
                added: true,
                reference: row[1],
            });
            log.commit(world)?;
            log.mark(world, MARK_PLACED, key)
        };
        // A preflighted transfer owns its released slots first.
        for i in 0..launches {
            let at = launch_base + i * LAUNCH_STRIDE;
            place(world, log, &input[at..at + LAUNCH_STRIDE], 0)?;
        }
        // The TypeScript checked for room before the loop and before each item; with no change between
        // them, the loop's first check is the same test.
        let mut exhausted = true;
        for i in 0..waiting {
            // No later item can free room.
            if !world.can_add_bodies(1 + reserve_actors + drop_reserve) {
                exhausted = false;
                break;
            }
            let at = waiting_base + i * WAITING_STRIDE;
            place(world, log, &input[at..at + WAITING_STRIDE], drop_reserve)?;
        }
        header[3] = f64::from(u8::from(exhausted && waiting > 0));
        log.commit(world)
    });
}

/// Phase 1's admission of the pending impulses and attachments: which may be queued. The input:
/// the counts, then `key, generation` per impulse (key -1 when it was never interned), then per
/// attachment in ID order `a, b, a is an actor, b is an actor, generation a, generation b, max
/// distance`. The output, after the header, is one flag per impulse, then per attachment.
pub fn admit_pending(world: &mut World, index: &SightIndex, gates: &GateSet) {
    run(world, |world, input, log, _| {
        let (impulses, attachments) = (input[0] as usize, input[1] as usize);
        for i in 0..impulses {
            let (key, generation) = (input[2 + 2 * i], input[3 + 2 * i]);
            let pass = key >= 0.0
                && world.has_body(key as Key)
                && world.generation(key as Key) == generation;
            log.answer(&[f64::from(u8::from(pass))]);
        }
        let base = 2 + 2 * impulses;
        for i in 0..attachments {
            let r = &input[base + 7 * i..base + 7 * i + 7];
            let position = |world: &mut World, key: f64| {
                if key < 0.0 {
                    None
                } else {
                    world.position(key as Key)
                }
            };
            let (a, b) = (position(world, r[0]), position(world, r[1]));
            let pass = match (a, b) {
                (Some(a), Some(b)) => {
                    r[2] != 0.0
                        && r[3] != 0.0
                        && world.generation(r[0] as Key) == r[4]
                        && world.generation(r[1] as Key) == r[5]
                        && hypot(a.0 - b.0, a.1 - b.1) <= r[6]
                        && reach_clear(index, gates, a, b).0
                }
                _ => false,
            };
            log.answer(&[f64::from(u8::from(pass))]);
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
