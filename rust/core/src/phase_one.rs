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
//! **Two queries stay with JavaScript** because what they read is not in the core yet: whether a
//! station is clear for a respawn (`canOccupy` on the map) and where a transit lands (the physics
//! placement search, which `synchronize` shares). When a player needs one, the run stops before that
//! player and reports the query; JavaScript applies the players already run, answers, and resumes
//! from that player. Both are rare, so a normal tick is one call. The landing reads the players
//! before it in roster order as they now stand, which is why the run stops rather than asking ahead.

use crate::math::hypot;

/// Header words of the input. The run writes `tick`, `hazard_x` and `serial` back in place.
pub const HEADER: usize = 18;
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
/// Nonzero once the stations' clearance flags are written.
const STATIONS_ANSWERED: usize = 12;
/// Nonzero when a landing answer is written for the player the run resumes from; then
/// `LANDED` is nonzero when it can land, at `LANDING_X, LANDING_Y`.
const LANDING_ANSWERED: usize = 13;
const LANDED: usize = 14;
const LANDING_X: usize = 15;
const LANDING_Y: usize = 16;
/// Nonzero once this tick's first run has advanced the tick, so a resume from player 0 does not again.
const ADVANCED: usize = 17;

/// Words per station: `x, y, clear`.
pub const STATION_STRIDE: usize = 3;
/// Words per player. Field offsets follow.
pub const PLAYER_STRIDE: usize = 16;
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

pub const CONTESTANT: f64 = 0.0;
pub const ACTIVE: f64 = 0.0;
pub const RESPAWNING: f64 = 2.0;
pub const TRANSIT: f64 = 5.0;

/// What a run ends with: the first output word.
pub const DONE: f64 = 0.0;
pub const NEED_STATIONS: f64 = 1.0;
pub const NEED_LANDING: f64 = 2.0;

/// Facts in the output, three words each: `kind, player, id`.
pub const RESPAWNED: f64 = 1.0;
pub const ARRIVED: f64 = 2.0;

/// Phase 1's input and output buffers, reused across ticks.
#[derive(Default)]
pub struct PhaseOne {
    input: Vec<f64>,
    output: Vec<f64>,
}

/// `Math.max(0, x)`: NaN stays NaN, where `f64::max` would drop it.
fn at_least_zero(x: f64) -> f64 {
    if x.is_nan() || x > 0.0 { x } else { 0.0 }
}

/// `Math.round`: halves round up, and a negative input that rounds to zero keeps its sign.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

impl PhaseOne {
    /// The input buffer, resized to `len` words. Its layout:
    /// - the header (`HEADER` words): `tick, hazardGraceTicks, durationTicks, map width, hazardX, serial`,
    ///   the counts of players, effects and stations, the respawn margin and contestant distance, the
    ///   rail cooldown, then the query answers: whether the stations' `clear` flags are written, and
    ///   for the player a run resumes from, whether its landing is written, whether it lands, and where;
    ///   then whether the tick has advanced, which the first run sets;
    /// - each effect's `life`;
    /// - `x, y, clear` per station, in the map's order;
    /// - `PLAYER_STRIDE` words per player, in roster order: `role, status, respawnAt, arriveAt, x, y, hp,
    ///   maxHp, shield`, then the timers. An absent `respawnAt` or `arriveAt` is NaN.
    pub fn input(&mut self, len: usize) -> &mut [f64] {
        self.input.resize(len, 0.0);
        &mut self.input
    }

    /// Runs phase 1 from player `from`; the tick's first run also advances the tick. Players and effects are
    /// written in place in the input. The output: how the run ended (`DONE`, `NEED_STATIONS` or
    /// `NEED_LANDING`), the player it stopped before, the count of facts, then the facts in
    /// allocation order.
    pub fn run(&mut self, from: usize) -> &[f64] {
        let mut out = std::mem::take(&mut self.output);
        out.clear();
        out.extend_from_slice(&[DONE, 0.0, 0.0]);
        let input = &mut self.input;
        let players = input[PLAYERS] as usize;
        let effects = input[EFFECTS] as usize;
        let stations = input[STATIONS] as usize;
        let station_base = HEADER + effects;
        let player_base = station_base + stations * STATION_STRIDE;
        if input[ADVANCED] == 0.0 {
            input[ADVANCED] = 1.0;
            input[TICK] += 1.0;
            let (tick, grace, duration) = (input[TICK], input[GRACE], input[DURATION]);
            input[HAZARD_X] = js_round(
                -80.0
                    + at_least_zero(tick - grace) / (duration - grace) * (input[MAP_WIDTH] + 100.0),
            );
            for life in &mut input[HEADER..station_base] {
                *life -= 1.0;
            }
        }
        let tick = input[TICK];
        for i in from..players {
            let row = player_base + i * PLAYER_STRIDE;
            if input[row + STATUS] == RESPAWNING && tick >= input[row + RESPAWN_AT] {
                if input[STATIONS_ANSWERED] == 0.0 {
                    out[0] = NEED_STATIONS;
                    out[1] = i as f64;
                    break;
                }
                if let Some(station) = respawn_station(input, station_base, player_base, players) {
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
                if from != i || input[LANDING_ANSWERED] == 0.0 {
                    out[0] = NEED_LANDING;
                    out[1] = i as f64;
                    break;
                }
                if input[LANDED] != 0.0 {
                    let (x, y, rail) = (input[LANDING_X], input[LANDING_Y], input[RAIL_COOLDOWN]);
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
                    *timer = at_least_zero(*timer - 1.0);
                }
            }
        }
        out[2] = ((out.len() - 3) / 3) as f64;
        self.output = out;
        &self.output
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
    station_base: usize,
    player_base: usize,
    players: usize,
) -> Option<usize> {
    let stations = input[STATIONS] as usize;
    let (margin, distance) = (input[RESPAWN_MARGIN], input[RESPAWN_DISTANCE]);
    let ahead = input[HAZARD_X] + margin;
    let mut best: Option<usize> = None;
    for s in 0..stations {
        let at = station_base + s * STATION_STRIDE;
        let (x, y) = (input[at], input[at + 1]);
        // As `filter` reads it: ahead of the wall (false for NaN), then clear, then far.
        let candidate = x > ahead && input[at + 2] != 0.0;
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

    fn header(players: usize, effects: usize, stations: usize) -> Vec<f64> {
        let mut h = vec![0.0; HEADER];
        h[TICK] = 99.0;
        h[GRACE] = 0.0;
        h[DURATION] = 1000.0;
        h[MAP_WIDTH] = 900.0;
        h[SERIAL] = 7.0;
        h[PLAYERS] = players as f64;
        h[EFFECTS] = effects as f64;
        h[STATIONS] = stations as f64;
        h[RESPAWN_MARGIN] = 400.0;
        h[RESPAWN_DISTANCE] = 1000.0;
        h[RAIL_COOLDOWN] = 180.0;
        h
    }

    fn player(role: f64, status: f64, x: f64) -> Vec<f64> {
        let mut p = vec![0.0; PLAYER_STRIDE];
        p[ROLE] = role;
        p[STATUS] = status;
        p[RESPAWN_AT] = f64::NAN;
        p[ARRIVE_AT] = f64::NAN;
        p[X] = x;
        p[HP] = 10.0;
        p[MAX_HP] = 100.0;
        p[TIMERS..TIMERS + TIMER_COUNT].copy_from_slice(&[3.0, 1.0, 0.0, 2.0, f64::NAN, 5.0, 4.0]);
        p
    }

    fn load(phase: &mut PhaseOne, words: Vec<f64>) {
        phase.input(words.len()).copy_from_slice(&words);
    }

    #[test]
    fn the_tick_advances_and_timers_count_down_as_math_max_does() {
        let mut phase = PhaseOne::default();
        let mut words = header(1, 2, 0);
        words.extend([1.0, 5.0]);
        words.extend(player(CONTESTANT, ACTIVE, 0.0));
        load(&mut phase, words);
        assert_eq!(phase.run(0), [DONE, 0.0, 0.0]);
        let input = &phase.input;
        assert_eq!(input[TICK], 100.0);
        assert_eq!(input[HAZARD_X], js_round(-80.0 + 100.0 / 1000.0 * 1000.0));
        assert_eq!(input[HEADER..HEADER + 2], [0.0, 4.0]);
        let t = HEADER + 2 + TIMERS;
        assert_eq!(input[t..t + 4], [2.0, 0.0, 0.0, 1.0]);
        assert!(input[t + 4].is_nan(), "Math.max(0, NaN) is NaN");
    }

    #[test]
    fn math_round_keeps_negative_zero_and_rounds_halves_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert!(js_round(-0.3).is_sign_negative());
        assert!(js_round(-0.5).is_sign_negative());
        assert!(js_round(0.3).is_sign_positive());
    }

    #[test]
    fn a_respawn_asks_for_the_stations_then_takes_the_westmost_clear_one_and_an_id() {
        let mut phase = PhaseOne::default();
        let mut words = header(1, 0, 3);
        // Ahead of the wall (hazardX 20 + 400): 900 clear, 700 blocked, 800 clear.
        words.extend([900.0, 0.0, 1.0, 700.0, 0.0, 0.0, 800.0, 5.0, 1.0]);
        let mut g = player(1.0, RESPAWNING, -50.0);
        g[RESPAWN_AT] = 100.0;
        words.extend(g);
        load(&mut phase, words);
        assert_eq!(phase.run(0), [NEED_STATIONS, 0.0, 0.0]);
        phase.input[STATIONS_ANSWERED] = 1.0;
        assert_eq!(phase.run(0), [DONE, 0.0, 1.0, RESPAWNED, 0.0, 7.0]);
        assert_eq!(
            phase.input[TICK], 100.0,
            "resuming from the first player advances the tick once"
        );
        let row = HEADER + 9;
        assert_eq!(phase.input[HAZARD_X], 20.0);
        assert_eq!(phase.input[row + X], 800.0);
        assert_eq!(phase.input[row + Y], 5.0);
        assert_eq!(phase.input[row + HP], 100.0);
        assert_eq!(phase.input[row + STATUS], ACTIVE);
        assert_eq!(phase.input[SERIAL], 8.0);
        // Then the timers run for the now active player: cleared ones stay at zero.
        assert_eq!(phase.input[row + COOLDOWN], 0.0);
        assert_eq!(phase.input[row + TIMERS + 3], 1.0);
    }

    #[test]
    fn a_due_arrival_stops_for_its_landing_and_lands_on_resume() {
        let mut phase = PhaseOne::default();
        let mut words = header(2, 0, 0);
        words.extend(player(CONTESTANT, ACTIVE, 0.0));
        let mut g = player(1.0, TRANSIT, 0.0);
        g[ARRIVE_AT] = 100.0;
        words.extend(g);
        load(&mut phase, words);
        assert_eq!(phase.run(0), [NEED_LANDING, 1.0, 0.0]);
        let row = HEADER + PLAYER_STRIDE;
        phase.input[LANDING_ANSWERED] = 1.0;
        phase.input[LANDED] = 1.0;
        phase.input[LANDING_X] = 30.0;
        phase.input[LANDING_Y] = 40.0;
        assert_eq!(phase.run(1), [DONE, 0.0, 1.0, ARRIVED, 1.0, 7.0]);
        assert_eq!(phase.input[row + X..row + Y + 1], [30.0, 40.0]);
        // The cooldown starts on landing, then counts down with the other timers.
        assert_eq!(phase.input[row + RAIL_CD], 179.0);
        // The contestant before it ran once, in the first call.
        assert_eq!(phase.input[HEADER + COOLDOWN], 2.0);
    }
}
