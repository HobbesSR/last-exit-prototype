//! The rest of tick phase 6 in the core (#1245, docs/27 "The state flip", step 5e.2): `applyEnvironment` (the
//! hazard wall and the hazard areas) for each active actor in `ordered(s)` order, then `stepTraps` (mine, turret,
//! flame and spider) in map order. `shared/simulation/hazards.ts` is the adapter.
//!
//! The records stay in JavaScript (D1). Each call packs the roster as phase 5's rows (`combat::PLAYER_ROW`) with
//! each actor's `movedThisTick`, the hazard areas, the traps and the trap content, and writes back the players'
//! changed fields, a log (effects, aggression and the turret's spawns, in the order the TypeScript made them) and
//! each trap's writes with a mask, which Node applies in the TypeScript's order so a trap's keys keep theirs.
//!
//! **Damage is the core's** (`combat::Run::damage`), and a kill is a stop, as in phase 5: the run returns before
//! anything of the elimination is written, Node runs it (`actions_run`'s mode 4), whose mandatory drops each
//! return at 5c.2's sync boundary, then resumes. A mine's explosion is a stop too: Node queues its impulses
//! (`enqueueExplosionImpulses`), which synchronize the world and fill the pending-impulse queue that Node owns
//! until the flip (#1214). Everything is repacked on a resume; only the cursor is kept here.
use crate::collision::{CollisionMap, can_occupy, line_clear};
use crate::combat::{OUT_ROW, PLAYER_ROW, Row, Run};
use crate::math::{atan2, cos, hypot, js_max, sin};
use crate::phase_seven::Rewind;
use crate::sight::{GateSet, SightIndex};

/// Input header: resume (nonzero continues the kept cursor), tick, serial, player count, trap count, hazard area
/// count, the hazard wall's x, whether to run the environment, whether to run the traps.
pub const HEADER: usize = 9;
/// The trap content, after the header: mine trigger, blast, damage; turret range, cooldown, speed, damage, life;
/// flame cycle, warnAt, fireAt, interval, range, cone, damage; spider leash, acquire, step, grapple, cooldown, stun,
/// damage.
pub const CONTENT: usize = 22;
/// Per player: phase 5's row, then `movedThisTick` (0 when unset).
pub const ACTOR_ROW: usize = PLAYER_ROW + 1;
/// Per hazard area: x, y, w, h.
pub const AREA_ROW: usize = 4;
/// Per trap: kind (`TRAP_KINDS`, -1 unknown), x, y, homeX, homeY, heading, offset, `cooldown || 0`, spent, the
/// roster index of its `targetId` (-1 none).
pub const TRAP_ROW: usize = 10;
/// Output header: length, serial, stopped (0 no, 1 an elimination, 2 a mine's explosion), its target or trap
/// index, the elimination's source (-1 none), the player count, the log length, the trap rows written.
pub const OUT_HEADER: usize = 8;
/// Per trap written: its index, the mask of fields written, then cooldown, spent, aiming, heading, firing,
/// warning, target (-1 null), x, y.
pub const OUT_TRAP: usize = 11;
pub const STOP_ELIMINATION: f64 = 1.0;
pub const STOP_EXPLOSION: f64 = 2.0;
pub const OP_SPAWN: f64 = 3.0;

pub const W_COOLDOWN: u32 = 1;
pub const W_SPENT: u32 = 2;
pub const W_AIMING: u32 = 4;
pub const W_HEADING: u32 = 8;
pub const W_FIRING: u32 = 16;
pub const W_WARNING: u32 = 32;
pub const W_TARGET: u32 = 64;
pub const W_POSITION: u32 = 128;

const MINE: f64 = 0.0;
const TURRET: f64 = 1.0;
const FLAME: f64 = 2.0;
const SPIDER: f64 = 3.0;
const EFFECT_SHOCK: usize = 0;
const EFFECT_GRAPPLE: usize = 7;
/// `applyEnvironment`: the hazard wall deals 9 every 5 ticks, a hazard area 5 every 12.
const WALL: (f64, f64) = (5.0, 9.0);
const AREA: (f64, f64) = (12.0, 5.0);
/// A spider moves only toward a destination farther than this, and only where its 15-unit body fits.
const SPIDER_REACHED: f64 = 20.0;
const SPIDER_RADIUS: f64 = 15.0;
const GRAPPLE_RADIUS: f64 = 35.0;

/// `n % m` is truthy: nonzero and not NaN.
fn truthy(n: f64) -> bool {
    n != 0.0 && !n.is_nan()
}

struct Content {
    mine: [f64; 3],
    turret: [f64; 5],
    flame: [f64; 7],
    spider: [f64; 7],
}

#[derive(Clone, Copy)]
struct Trap {
    kind: f64,
    x: f64,
    y: f64,
    home: (f64, f64),
    heading: f64,
    offset: f64,
    cooldown: f64,
    spent: bool,
    aiming: bool,
    firing: bool,
    warning: bool,
    target: Option<usize>,
    written: u32,
}

/// Where a run stands, kept across a stop.
#[derive(Clone, Copy)]
enum Cursor {
    /// The environment, at the actor `pos` in `ordered(s)` order: `sub` 0 the wall, 1 the areas.
    Environment { pos: usize, sub: u8 },
    /// The trap `t`: `step` 0 begins it; 1 a mine's or flame's damage from player `j`; 2 a mine's explosion is
    /// queued; 3 a spider's grapple effect at player `j`.
    Trap { t: usize, step: u8, j: usize },
}

#[derive(Default)]
pub struct Hazards {
    pub input: Vec<f64>,
    pub output: Vec<f64>,
    cursor: Option<Cursor>,
}

fn distance(a: (f64, f64), b: (f64, f64)) -> f64 {
    hypot(a.0 - b.0, a.1 - b.1)
}

impl Hazards {
    pub fn run(
        &mut self,
        map: &mut CollisionMap,
        index: &SightIndex,
        gates: &mut GateSet,
        hz: f64,
    ) {
        let input = std::mem::take(&mut self.input);
        let h = &input[..HEADER];
        let resume = h[0] != 0.0;
        let (tick, players, trap_count, areas) =
            (h[1], h[3] as usize, h[4] as usize, h[5] as usize);
        let (wall_x, environment, traps_on) = (h[6], h[7] != 0.0, h[8] != 0.0);
        let mut at = HEADER;
        let c = &input[at..at + CONTENT];
        let content = Content {
            mine: [c[0], c[1], c[2]],
            turret: [c[3], c[4], c[5], c[6], c[7]],
            flame: [c[8], c[9], c[10], c[11], c[12], c[13], c[14]],
            spider: [c[15], c[16], c[17], c[18], c[19], c[20], c[21]],
        };
        at += CONTENT;
        let mut rows = Vec::with_capacity(players);
        let mut moved = Vec::with_capacity(players);
        for _ in 0..players {
            rows.push(Row::read(&input[at..at + PLAYER_ROW]));
            moved.push(input[at + PLAYER_ROW]);
            at += ACTOR_ROW;
        }
        let boxes = &input[at..at + areas * AREA_ROW];
        at += areas * AREA_ROW;
        let mut traps: Vec<Trap> = (0..trap_count)
            .map(|i| {
                let a = &input[at + i * TRAP_ROW..at + (i + 1) * TRAP_ROW];
                Trap {
                    kind: a[0],
                    x: a[1],
                    y: a[2],
                    home: (a[3], a[4]),
                    heading: a[5],
                    offset: a[6],
                    cooldown: a[7],
                    spent: a[8] != 0.0,
                    aiming: false,
                    firing: false,
                    warning: false,
                    target: (a[9] >= 0.0).then_some(a[9] as usize),
                    written: 0,
                }
            })
            .collect();
        let empty = Rewind::default();
        let mut run = Run {
            rows,
            log: Vec::new(),
            serial: h[2],
            tick,
            hz,
            frames: &empty,
        };
        if !resume {
            self.cursor = Some(if environment {
                Cursor::Environment { pos: 0, sub: 0 }
            } else {
                Cursor::Trap {
                    t: 0,
                    step: 0,
                    j: 0,
                }
            });
        }
        let mut cursor = self.cursor.expect("no hazard run to resume");
        // `ordered(s)`: the roster by ID.
        let mut order: Vec<usize> = (0..players).collect();
        order.sort_by(|&a, &b| run.rows[a].rank.total_cmp(&run.rows[b].rank));
        let active = |run: &Run<'_>, i: usize| run.rows[i].status == 0.0;
        let clear =
            |gates: &GateSet, a: (f64, f64), b: (f64, f64)| line_clear(index, gates, a, b).0;
        let mut stop: Option<(f64, usize, Option<usize>)> = None;
        'run: loop {
            match cursor {
                Cursor::Environment { pos, sub } => {
                    if pos >= order.len() {
                        cursor = Cursor::Trap {
                            t: 0,
                            step: 0,
                            j: 0,
                        };
                        if !traps_on {
                            break;
                        }
                        continue;
                    }
                    let p = order[pos];
                    // The status is read once per actor, before its wall damage.
                    if sub == 0 && !active(&run, p) {
                        cursor = Cursor::Environment {
                            pos: pos + 1,
                            sub: 0,
                        };
                        continue;
                    }
                    let r = run.rows[p];
                    let (hit, next) = if sub == 0 {
                        let hit = (r.x < wall_x && tick % WALL.0 == 0.0).then_some(WALL.1);
                        (hit, Cursor::Environment { pos, sub: 1 })
                    } else {
                        let inside = tick % AREA.0 == 0.0
                            && boxes.as_chunks::<AREA_ROW>().0.iter().any(|b| {
                                r.x > b[0] && r.x < b[0] + b[2] && r.y > b[1] && r.y < b[1] + b[3]
                            });
                        (
                            inside.then_some(AREA.1),
                            Cursor::Environment {
                                pos: pos + 1,
                                sub: 0,
                            },
                        )
                    };
                    cursor = next;
                    if let Some(amount) = hit
                        && run.damage(p, amount, None)
                    {
                        stop = Some((STOP_ELIMINATION, p, None));
                        break 'run;
                    }
                }
                Cursor::Trap { t, step, j } => {
                    if !traps_on || t >= traps.len() {
                        break;
                    }
                    let next = Cursor::Trap {
                        t: t + 1,
                        step: 0,
                        j: 0,
                    };
                    let mut trap = traps[t];
                    let origin = (trap.x, trap.y);
                    match step {
                        0 => {
                            if trap.spent {
                                cursor = next;
                                continue;
                            }
                            trap.cooldown = js_max(0.0, trap.cooldown - 1.0);
                            trap.written |= W_COOLDOWN;
                            cursor = next;
                            let near = |run: &Run<'_>, i: usize| (run.rows[i].x, run.rows[i].y);
                            if trap.kind == MINE {
                                let [trigger, blast, _] = content.mine;
                                let triggered = (0..players).any(|i| {
                                    active(&run, i)
                                        && distance(near(&run, i), origin) < trigger
                                        && moved[i] > 0.5
                                        && clear(gates, origin, near(&run, i))
                                });
                                if triggered {
                                    trap.spent = true;
                                    trap.written |= W_SPENT;
                                    run.effect(trap.x, trap.y, EFFECT_SHOCK, blast);
                                    cursor = Cursor::Trap { t, step: 1, j: 0 };
                                }
                            } else if trap.kind == TURRET {
                                let [range, cooldown, speed, damage, life] = content.turret;
                                let target = nearest(&run, origin, |run, i| {
                                    active(run, i)
                                        && distance(near(run, i), origin) < range
                                        && clear(gates, origin, near(run, i))
                                });
                                trap.written |= W_AIMING;
                                trap.aiming = target.is_some();
                                if let Some(target) = target {
                                    let (x, y) = near(&run, target);
                                    trap.heading = atan2(y - trap.y, x - trap.x);
                                    trap.written |= W_HEADING;
                                    // `!trap.cooldown`: zero or NaN.
                                    if !truthy(trap.cooldown) {
                                        trap.cooldown = cooldown;
                                        run.log.extend_from_slice(&[
                                            OP_SPAWN,
                                            8.0,
                                            run.serial,
                                            t as f64,
                                            trap.x,
                                            trap.y,
                                            cos(trap.heading) * speed,
                                            sin(trap.heading) * speed,
                                            damage,
                                            life,
                                        ]);
                                        run.serial += 1.0;
                                    }
                                }
                            } else if trap.kind == FLAME {
                                let [cycle, warn_at, fire_at, interval, ..] = content.flame;
                                let phase = (tick + trap.offset) % cycle;
                                trap.firing = phase >= fire_at;
                                trap.warning = phase >= warn_at && phase < fire_at;
                                trap.written |= W_FIRING | W_WARNING;
                                if trap.firing && !truthy(tick % interval) {
                                    cursor = Cursor::Trap { t, step: 1, j: 0 };
                                }
                            } else if trap.kind == SPIDER {
                                let [leash, acquire, step_length, grapple, cooldown, stun, damage] =
                                    content.spider;
                                // A held target is kept out to the full leash; a new one is acquired well inside it.
                                let mut target = trap.target.filter(|&i| {
                                    i < players
                                        && active(&run, i)
                                        && distance(near(&run, i), trap.home) < leash
                                });
                                if target.is_none() {
                                    target = nearest(&run, origin, |run, i| {
                                        active(run, i)
                                            && distance(near(run, i), trap.home) < acquire
                                            && clear(gates, origin, near(run, i))
                                    });
                                }
                                trap.target = target;
                                trap.written |= W_TARGET | W_HEADING;
                                let destination = target.map_or(trap.home, |i| near(&run, i));
                                let length = distance(origin, destination);
                                trap.heading =
                                    atan2(destination.1 - trap.y, destination.0 - trap.x);
                                if length > SPIDER_REACHED {
                                    let x = trap.x + cos(trap.heading) * step_length;
                                    let y = trap.y + sin(trap.heading) * step_length;
                                    if distance((x, y), trap.home) <= leash
                                        && can_occupy(map, gates, x, y, SPIDER_RADIUS, false, false)
                                    {
                                        trap.x = x;
                                        trap.y = y;
                                        trap.written |= W_POSITION;
                                    }
                                }
                                if let Some(i) = target
                                    && !truthy(trap.cooldown)
                                    && distance((trap.x, trap.y), near(&run, i)) < grapple
                                    && clear(gates, (trap.x, trap.y), near(&run, i))
                                {
                                    trap.cooldown = cooldown;
                                    run.rows[i].stun = js_max(run.rows[i].stun, stun);
                                    let killed = run.damage(i, damage, None);
                                    traps[t] = trap;
                                    if killed {
                                        // The grapple's effect is placed after the elimination, where it left the target.
                                        cursor = Cursor::Trap { t, step: 3, j: i };
                                        stop = Some((STOP_ELIMINATION, i, None));
                                        break 'run;
                                    }
                                    let (x, y) = near(&run, i);
                                    run.effect(x, y, EFFECT_GRAPPLE, GRAPPLE_RADIUS);
                                }
                            }
                            traps[t] = trap;
                        }
                        1 => {
                            // A mine's blast, or a flame's cone, over the actors in roster order.
                            let mut i = j;
                            while i < players {
                                let p = i;
                                i += 1;
                                if !active(&run, p) {
                                    continue;
                                }
                                let at = (run.rows[p].x, run.rows[p].y);
                                let (hit, amount) = if trap.kind == MINE {
                                    let [_, blast, damage] = content.mine;
                                    (
                                        distance(at, origin) < blast && clear(gates, origin, at),
                                        damage,
                                    )
                                } else {
                                    let [.., range, cone, damage] = content.flame;
                                    let facing =
                                        cos(atan2(at.1 - trap.y, at.0 - trap.x) - trap.heading)
                                            > cone;
                                    (
                                        distance(at, origin) < range
                                            && facing
                                            && clear(gates, origin, at),
                                        damage,
                                    )
                                };
                                if hit && run.damage(p, amount, None) {
                                    cursor = Cursor::Trap { t, step: 1, j: i };
                                    stop = Some((STOP_ELIMINATION, p, None));
                                    break 'run;
                                }
                            }
                            if trap.kind == MINE {
                                cursor = Cursor::Trap { t, step: 2, j: 0 };
                                stop = Some((STOP_EXPLOSION, t, None));
                                break 'run;
                            }
                            cursor = next;
                        }
                        2 => cursor = next,
                        _ => {
                            let (x, y) = (run.rows[j].x, run.rows[j].y);
                            run.effect(x, y, EFFECT_GRAPPLE, GRAPPLE_RADIUS);
                            cursor = next;
                        }
                    }
                }
            }
        }
        self.cursor = stop.is_some().then_some(cursor);
        let mut out = std::mem::take(&mut self.output);
        out.clear();
        let (kind, which, source) = stop.map_or((0.0, -1.0, -1.0), |(k, w, s)| {
            (k, w as f64, s.map_or(-1.0, |s| s as f64))
        });
        let written = traps.iter().filter(|t| t.written != 0).count();
        out.extend_from_slice(&[
            0.0,
            run.serial,
            kind,
            which,
            source,
            run.rows.len() as f64,
            run.log.len() as f64,
            written as f64,
        ]);
        for r in &run.rows {
            r.write(&mut out);
        }
        debug_assert_eq!(out.len(), OUT_HEADER + run.rows.len() * OUT_ROW);
        out.extend_from_slice(&run.log);
        for (i, t) in traps.iter().enumerate().filter(|(_, t)| t.written != 0) {
            out.extend_from_slice(&[
                i as f64,
                t.written as f64,
                t.cooldown,
                if t.spent { 1.0 } else { 0.0 },
                if t.aiming { 1.0 } else { 0.0 },
                t.heading,
                if t.firing { 1.0 } else { 0.0 },
                if t.warning { 1.0 } else { 0.0 },
                t.target.map_or(-1.0, |i| i as f64),
                t.x,
                t.y,
            ]);
        }
        out[0] = out.len() as f64;
        self.output = out;
        self.input = input;
    }
}

/// `filter(test).sort(by distance to origin)[0]`: the first in roster order at the least distance, as a stable sort
/// leaves it.
fn nearest(
    run: &Run<'_>,
    origin: (f64, f64),
    test: impl Fn(&Run<'_>, usize) -> bool,
) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for i in 0..run.rows.len() {
        if !test(run, i) {
            continue;
        }
        let d = distance((run.rows[i].x, run.rows[i].y), origin);
        if best.is_none_or(|(_, b)| d < b) {
            best = Some((i, d));
        }
    }
    best.map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::truthy;

    #[test]
    fn a_remainder_is_truthy_only_when_nonzero() {
        assert!(truthy(3.0 % 5.0));
        assert!(!truthy(10.0 % 5.0));
        assert!(
            !truthy(f64::NAN),
            "NaN is falsy, so a NaN interval never skips the flame"
        );
    }
}
