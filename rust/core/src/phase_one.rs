//! Tick phase 1 (docs/29.2, "Tick order"), ported from `shared/simulation/tick.ts` by #1212, step 4 of
//! docs/27's state flip. The state stays in JavaScript (D1): `shared/simulation/phase-one.ts` packs it
//! here each tick and unpacks what this writes.
//!
//! What runs here, in the order the TypeScript ran it:
//! - the tick advances, the hazard wall moves, and every effect loses a tick of life;
//! - then per player, in roster order: respawn, transit arrival, and the countdown timers of an
//!   active player.
//!
//! The game's `serial` counter is packed in and out (D6), and every ID phase 1 allocates is taken
//! from it here, in the same order. Phase 1 allocates no item IDs.
//!
//! **Both queries are answered here** (#1234): whether a station is clear for a respawn
//! (`can_occupy` at the clearance radius, over the map's collision upload) and where a transit lands
//! (the placement search the body sync shares, `placement.rs`). A landing reads the players before it
//! in roster order as this run has left them, and the ones after it as they were packed, as the
//! TypeScript tick did, so a tick is one call with no stop and no resume.

use crate::collision::{CollisionMap, can_occupy};
use crate::math::{hypot, js_max, js_round};
use crate::placement::{Disk, placement};
use crate::players::Players;
use crate::sight::GateSet;
use crate::world::World;

/// Header words of the input. The run writes `tick`, `hazard_x` and `serial` back in place.
pub const HEADER: usize = 15;
const TICK: usize = 0;
const GRACE: usize = 1;
const DURATION: usize = 2;
const MAP_WIDTH: usize = 3;
const HAZARD_X: usize = 4;
const SERIAL: usize = 5;
const PLAYERS: usize = 6;
const EFFECTS: usize = 7;
const STATIONS: usize = 8;
const RESPAWN_MARGIN: usize = 9;
const RESPAWN_DISTANCE: usize = 10;
const RAIL_COOLDOWN: usize = 11;
/// The actors' body radii by role (`actorRadius`), and a respawn's station clearance radius.
const CONTESTANT_RADIUS: usize = 12;
const GLADIATOR_RADIUS: usize = 13;
const CLEARANCE_RADIUS: usize = 14;

/// Words per station: `x, y`.
pub const STATION_STRIDE: usize = 2;
/// Words per player. Field offsets follow.
pub const PLAYER_STRIDE: usize = 17;
const ROLE: usize = 0;
const STATUS: usize = 1;
const RESPAWN_AT: usize = 2;
const ARRIVE_AT: usize = 3;
const X: usize = 4;
const Y: usize = 5;
const HP: usize = 6;
const MAX_HP: usize = 7;
const SHIELD: usize = 8;
/// The countdown timers, in `tick-rules.ts`'s order: `cooldown, attackCd, railCd, cloak, revealed,
/// boost, stun`.
const TIMERS: usize = 9;
const COOLDOWN: usize = TIMERS;
const ATTACK_CD: usize = TIMERS + 1;
const RAIL_CD: usize = TIMERS + 2;
const BOOST: usize = TIMERS + 5;
const STUN: usize = TIMERS + 6;
const TIMER_COUNT: usize = 7;
/// The index of a transit's destination station in the map's list, or -1 when none has its ID.
const DESTINATION: usize = 16;

pub const CONTESTANT: f64 = 0.0;
pub const ACTIVE: f64 = 0.0;
pub const RESPAWNING: f64 = 2.0;
pub const TRANSIT: f64 = 5.0;

/// Facts in the output, three words each: `kind, player, id`.
pub const RESPAWNED: f64 = 1.0;
pub const ARRIVED: f64 = 2.0;

/// Phase 1's input and output buffers, reused across ticks.
#[derive(Default)]
pub struct PhaseOne {
    input: Vec<f64>,
    output: Vec<f64>,
}

impl PhaseOne {
    /// The input buffer, resized to `len` words. Its layout:
    /// - the header (`HEADER` words): `tick, hazardGraceTicks, durationTicks, map width, hazardX, serial`,
    ///   the counts of players, effects and stations, the respawn margin and contestant distance, the
    ///   rail cooldown, the contestant's and the gladiator's body radii, then the clearance radius;
    /// - each effect's `life`;
    /// - `x, y` per station, in the map's order;
    /// - `PLAYER_STRIDE` words per player, in roster order: `role, status, respawnAt, arriveAt, x, y, hp,
    ///   maxHp, shield`, the timers, then the destination station. An absent `respawnAt` or `arriveAt`
    ///   is NaN.
    pub fn input(&mut self, len: usize) -> &mut [f64] {
        self.input.resize(len, 0.0);
        &mut self.input
    }

    /// Runs phase 1 over the input; players and effects are written in place. `map` and `gates` are the
    /// map's collision upload and gate set, with the open mask written, and `world` the game's physics
    /// world, for the station clearance and the landing. The output: the count of facts, then the facts
    /// in allocation order.
    pub fn run(
        &mut self,
        world: &mut World,
        map: &mut CollisionMap,
        gates: &mut GateSet,
    ) -> &[f64] {
        let mut out = std::mem::take(&mut self.output);
        out.clear();
        out.push(0.0);
        let input = &mut self.input;
        let players = input[PLAYERS] as usize;
        let effects = input[EFFECTS] as usize;
        let stations = input[STATIONS] as usize;
        let station_base = HEADER + effects;
        let player_base = station_base + stations * STATION_STRIDE;
        // The players come from the world's store (`players.rs`, #1214 stage 6c.2), not from the adapter.
        fill_players(input, player_base, &world.players, players);
        input[TICK] += 1.0;
        let (tick, grace, duration) = (input[TICK], input[GRACE], input[DURATION]);
        input[HAZARD_X] = js_round(
            -80.0 + js_max(0.0, tick - grace) / (duration - grace) * (input[MAP_WIDTH] + 100.0),
        );
        for life in &mut input[HEADER..station_base] {
            *life -= 1.0;
        }
        let radius = |input: &[f64], row: usize| {
            input[if input[row + ROLE] == CONTESTANT {
                CONTESTANT_RADIUS
            } else {
                GLADIATOR_RADIUS
            }]
        };
        // Which stations are clear, found the first time a respawn needs them. The map and the gates
        // do not change within the phase, so one answer serves every respawn of the tick.
        let mut clear: Option<Vec<bool>> = None;
        for i in 0..players {
            let row = player_base + i * PLAYER_STRIDE;
            if input[row + STATUS] == RESPAWNING && tick >= input[row + RESPAWN_AT] {
                let clear = clear.get_or_insert_with(|| {
                    (0..stations)
                        .map(|s| {
                            let at = station_base + s * STATION_STRIDE;
                            can_occupy(
                                map,
                                gates,
                                input[at],
                                input[at + 1],
                                input[CLEARANCE_RADIUS],
                                false,
                                false,
                            )
                        })
                        .collect()
                });
                if let Some(station) =
                    respawn_station(input, clear, station_base, player_base, players)
                {
                    let (x, y) = (input[station], input[station + 1]);
                    let p = &mut input[row..row + PLAYER_STRIDE];
                    p[X] = x;
                    p[Y] = y;
                    p[HP] = p[MAX_HP];
                    p[SHIELD] = 0.0;
                    p[STATUS] = ACTIVE;
                    p[RESPAWN_AT] = f64::NAN;
                    for field in [COOLDOWN, ATTACK_CD, STUN, BOOST, RAIL_CD] {
                        p[field] = 0.0;
                    }
                    fact(&mut out, input, RESPAWNED, i);
                }
            }
            if input[row + STATUS] == TRANSIT && tick >= input[row + ARRIVE_AT] {
                // Lands at the station, or nearest it, clear of every other active actor as they stand.
                let destination = input[row + DESTINATION];
                let origin = if destination < 0.0 {
                    (input[row + X], input[row + Y])
                } else {
                    let at = station_base + destination as usize * STATION_STRIDE;
                    (input[at], input[at + 1])
                };
                let admitted: Vec<Disk> = (0..players)
                    .filter(|&j| {
                        j != i && input[player_base + j * PLAYER_STRIDE + STATUS] == ACTIVE
                    })
                    .map(|j| {
                        let other = player_base + j * PLAYER_STRIDE;
                        [input[other + X], input[other + Y], radius(input, other)]
                    })
                    .collect();
                let r = radius(input, row);
                if let Some((x, y)) = placement(world, map, gates, r, origin, &admitted) {
                    let rail = input[RAIL_COOLDOWN];
                    let p = &mut input[row..row + PLAYER_STRIDE];
                    p[STATUS] = ACTIVE;
                    p[ARRIVE_AT] = f64::NAN;
                    p[X] = x;
                    p[Y] = y;
                    p[RAIL_CD] = rail;
                    fact(&mut out, input, ARRIVED, i);
                }
            }
            if input[row + STATUS] == ACTIVE {
                for timer in &mut input[row + TIMERS..row + TIMERS + TIMER_COUNT] {
                    *timer = js_max(0.0, *timer - 1.0);
                }
            }
        }
        store_players(input, player_base, &mut world.players, players);
        out[0] = ((out.len() - 1) / 3) as f64;
        self.output = out;
        &self.output
    }
}

/// Write each player's `PLAYER_STRIDE` words from the store, as the adapter packed them before stage 6c.2.
fn fill_players(input: &mut [f64], base: usize, store: &Players, players: usize) {
    assert_eq!(store.len(), players, "the store holds the roster");
    for (i, (r, e)) in store.rows.iter().zip(&store.extra).enumerate() {
        let p = &mut input[base + i * PLAYER_STRIDE..base + (i + 1) * PLAYER_STRIDE];
        p[ROLE] = r.role;
        p[STATUS] = r.status;
        p[RESPAWN_AT] = e.respawn_at;
        p[ARRIVE_AT] = e.arrive_at;
        p[X] = r.x;
        p[Y] = r.y;
        p[HP] = r.hp;
        p[MAX_HP] = r.max_hp;
        p[SHIELD] = r.shield;
        p[TIMERS..TIMERS + TIMER_COUNT].copy_from_slice(&[
            r.cooldown,
            r.attack_cd,
            e.rail_cd,
            e.cloak,
            e.revealed,
            e.boost,
            r.stun,
        ]);
        p[DESTINATION] = e.destination;
    }
}

/// Write phase 1's results back into the store; every player's `movedThisTick` starts the tick at 0.
fn store_players(input: &[f64], base: usize, store: &mut Players, players: usize) {
    for i in 0..players {
        let p = &input[base + i * PLAYER_STRIDE..base + (i + 1) * PLAYER_STRIDE];
        let (r, e) = (&mut store.rows[i], &mut store.extra[i]);
        r.status = p[STATUS];
        e.respawn_at = p[RESPAWN_AT];
        e.arrive_at = p[ARRIVE_AT];
        // An arrival deletes the record's `transit`, and with it the destination.
        if e.arrive_at.is_nan() {
            e.destination = -1.0;
        }
        r.x = p[X];
        r.y = p[Y];
        r.hp = p[HP];
        r.shield = p[SHIELD];
        let timers = &p[TIMERS..TIMERS + TIMER_COUNT];
        (
            r.cooldown,
            r.attack_cd,
            e.rail_cd,
            e.cloak,
            e.revealed,
            e.boost,
            r.stun,
        ) = (
            timers[0], timers[1], timers[2], timers[3], timers[4], timers[5], timers[6],
        );
        store.moved[i] = 0.0;
    }
}

/// Allocates the fact's ID from the game's serial.
fn fact(out: &mut Vec<f64>, input: &mut [f64], kind: f64, player: usize) {
    let id = input[SERIAL];
    input[SERIAL] = id + 1.0;
    out.extend_from_slice(&[kind, player as f64, id]);
}

/// The station a respawn uses (`lifecycle.ts`'s rule): ahead of the wall by the margin, clear, and
/// beyond the distance from every active contestant; the westmost of those, the first on a tie.
fn respawn_station(
    input: &[f64],
    clear: &[bool],
    station_base: usize,
    player_base: usize,
    players: usize,
) -> Option<usize> {
    let stations = input[STATIONS] as usize;
    let (margin, distance) = (input[RESPAWN_MARGIN], input[RESPAWN_DISTANCE]);
    let ahead = input[HAZARD_X] + margin;
    let mut best: Option<usize> = None;
    for (s, &clear) in clear.iter().enumerate().take(stations) {
        let at = station_base + s * STATION_STRIDE;
        let (x, y) = (input[at], input[at + 1]);
        // As `filter` reads it: ahead of the wall (false for NaN), then clear, then far.
        let candidate = x > ahead && clear;
        let far = candidate
            && (0..players).all(|j| {
                let other = player_base + j * PLAYER_STRIDE;
                input[other + ROLE] != CONTESTANT
                    || input[other + STATUS] != ACTIVE
                    || hypot(input[other + X] - x, input[other + Y] - y) > distance
            });
        if far && best.is_none_or(|b| x < input[b]) {
            best = Some(at);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sight::tests::grid_of;

    /// A 2000 x 800 map with one circle obstacle of radius 150 at (1300, 300), in sight's 200-unit cells.
    fn map() -> (World, CollisionMap, GateSet) {
        let cells: Vec<((i32, i32), Vec<i32>)> = (5..=7)
            .flat_map(|c| (0..=2).map(move |r| ((c, r), vec![0])))
            .collect();
        let map = CollisionMap::new(
            &[2000.0, 800.0, 100.0, 20.0, 8.0],
            &[1; 160],
            &[1.0, 0.0, 1150.0, 150.0, 300.0, 300.0, 1300.0, 300.0, 150.0],
            &[0, 9],
            &grid_of(&cells),
        );
        let gates = GateSet::new(
            &[],
            &[0, 0],
            &[1900.0, 700.0, 26.0, 54.0],
            &grid_of(&[((9, 3), vec![0])]),
        );
        (World::new(), map, gates)
    }

    fn header(players: usize, effects: usize, stations: usize) -> Vec<f64> {
        let mut h = vec![0.0; HEADER];
        h[TICK] = 99.0;
        h[DURATION] = 1000.0;
        h[MAP_WIDTH] = 900.0;
        h[SERIAL] = 7.0;
        h[PLAYERS] = players as f64;
        h[EFFECTS] = effects as f64;
        h[STATIONS] = stations as f64;
        h[RESPAWN_MARGIN] = 400.0;
        h[RESPAWN_DISTANCE] = 1000.0;
        h[RAIL_COOLDOWN] = 180.0;
        h[CONTESTANT_RADIUS] = 12.0;
        h[GLADIATOR_RADIUS] = 16.0;
        h[CLEARANCE_RADIUS] = 25.0;
        h
    }

    fn player(role: f64, status: f64, x: f64) -> Vec<f64> {
        let mut p = vec![0.0; PLAYER_STRIDE];
        p[ROLE] = role;
        p[STATUS] = status;
        p[RESPAWN_AT] = f64::NAN;
        p[ARRIVE_AT] = f64::NAN;
        p[X] = x;
        p[Y] = 600.0;
        p[HP] = 10.0;
        p[MAX_HP] = 100.0;
        p[TIMERS..TIMERS + TIMER_COUNT].copy_from_slice(&[3.0, 1.0, 0.0, 2.0, f64::NAN, 5.0, 4.0]);
        p[DESTINATION] = -1.0;
        p
    }

    /// Load the world's player store from the players a test wrote into its input, as the adapter uploads them.
    fn store_from(world: &mut World, words: &[f64]) {
        let players = words[PLAYERS] as usize;
        let base = HEADER + words[EFFECTS] as usize + words[STATIONS] as usize * STATION_STRIDE;
        // Each player's fixed row, then an equipment header with no inventory (`players::EQUIP_HEAD`).
        // Each equipment ends with an empty cue list (6e.4).
        let per = crate::players::EQUIP_HEAD + 1;
        let up = world
            .players
            .input(players * (crate::players::STORE_ROW + per));
        for i in 0..players {
            up[players * crate::players::STORE_ROW + i * per + 4] = -1.0;
        }
        for i in 0..players {
            let p = &words[base + i * PLAYER_STRIDE..base + (i + 1) * PLAYER_STRIDE];
            let u = &mut up[i * crate::players::STORE_ROW..(i + 1) * crate::players::STORE_ROW];
            u[..15].copy_from_slice(&[
                p[ROLE],
                p[STATUS],
                0.0,
                p[X],
                p[Y],
                0.0,
                p[HP],
                p[MAX_HP],
                p[SHIELD],
                0.0,
                p[COOLDOWN],
                p[ATTACK_CD],
                p[STUN],
                0.0,
                0.0,
            ]);
            u[16..24].copy_from_slice(&[
                p[RESPAWN_AT],
                p[ARRIVE_AT],
                p[DESTINATION],
                p[RAIL_CD],
                p[TIMERS + 3],
                p[TIMERS + 4],
                p[BOOST],
                0.0,
            ]);
        }
        world.players.load(players);
    }

    fn run(phase: &mut PhaseOne, words: Vec<f64>) -> Vec<f64> {
        let (mut world, mut map, mut gates) = map();
        store_from(&mut world, &words);
        phase.input(words.len()).copy_from_slice(&words);
        phase.run(&mut world, &mut map, &mut gates).to_vec()
    }

    #[test]
    fn the_tick_advances_and_timers_count_down_as_math_max_does() {
        let mut phase = PhaseOne::default();
        let mut words = header(1, 2, 0);
        words.extend([1.0, 5.0]);
        words.extend(player(CONTESTANT, ACTIVE, 100.0));
        assert_eq!(run(&mut phase, words), [0.0]);
        let input = &phase.input;
        assert_eq!(input[TICK], 100.0);
        assert_eq!(input[HAZARD_X], js_round(-80.0 + 100.0 / 1000.0 * 1000.0));
        assert_eq!(input[HEADER..HEADER + 2], [0.0, 4.0]);
        let t = HEADER + 2 + TIMERS;
        assert_eq!(input[t..t + 4], [2.0, 0.0, 0.0, 1.0]);
        assert!(input[t + 4].is_nan(), "Math.max(0, NaN) is NaN");
    }

    #[test]
    fn a_respawn_takes_the_westmost_clear_station_and_an_id() {
        let mut phase = PhaseOne::default();
        let mut words = header(1, 0, 3);
        // Ahead of the wall (hazardX 20 + 400): 1300 is inside the obstacle, 1700 and 1600 are clear.
        words.extend([1700.0, 300.0, 1300.0, 300.0, 1600.0, 305.0]);
        let mut g = player(1.0, RESPAWNING, -50.0);
        g[RESPAWN_AT] = 100.0;
        words.extend(g);
        assert_eq!(run(&mut phase, words), [1.0, RESPAWNED, 0.0, 7.0]);
        let row = HEADER + 6;
        assert_eq!(phase.input[row + X..row + Y + 1], [1600.0, 305.0]);
        assert_eq!(phase.input[row + HP], 100.0);
        assert_eq!(phase.input[row + STATUS], ACTIVE);
        assert_eq!(phase.input[SERIAL], 8.0);
        // Then the timers run for the now active player: cleared ones stay at zero.
        assert_eq!(phase.input[row + COOLDOWN], 0.0);
        assert_eq!(phase.input[row + TIMERS + 3], 1.0);
    }

    #[test]
    fn a_due_arrival_lands_clear_of_an_actor_and_waits_when_it_cannot() {
        let mut phase = PhaseOne::default();
        let mut words = header(3, 0, 2);
        words.extend([500.0, 600.0, 1300.0, 300.0]);
        // A contestant on the open station: the gladiator lands on the first ring spot clear of it.
        words.extend(player(CONTESTANT, ACTIVE, 500.0));
        let mut g = player(1.0, TRANSIT, 0.0);
        g[ARRIVE_AT] = 100.0;
        g[DESTINATION] = 0.0;
        words.extend(g.clone());
        // The second station is inside the obstacle, beyond the search's reach.
        g[DESTINATION] = 1.0;
        words.extend(g);
        assert_eq!(run(&mut phase, words), [1.0, ARRIVED, 1.0, 7.0]);
        let (landed, waiting) = (HEADER + 4 + PLAYER_STRIDE, HEADER + 4 + 2 * PLAYER_STRIDE);
        let (x, y) = (phase.input[landed + X], phase.input[landed + Y]);
        assert!(hypot(x - 500.0, y - 600.0) >= 28.0 && hypot(x - 500.0, y - 600.0) < 36.0);
        // The cooldown starts on landing, then counts down with the other timers.
        assert_eq!(phase.input[landed + RAIL_CD], 179.0);
        assert_eq!(phase.input[waiting + STATUS], TRANSIT);
        assert_eq!(phase.input[SERIAL], 8.0);
    }
}
