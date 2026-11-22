//! Phase 5's combat in the core (#1242, docs/27 "The state flip", step 5d.2): projectile flight
//! (`solvePhysicsProjectiles`), the end-of-tick casters (the warden skill, then the gladiator attack,
//! in `ordered(s)` order), `damage`, and the rewind reads (`asSeenBy`) the casters resolve against.
//!
//! The records stay in JavaScript (D1). `shared/simulation/phase-five.ts` packs the roster as compact
//! rows each call, and the run writes back only the fields these rules write: health, shield, the
//! cooldowns and stun, then a log of effects and aggression in the order the TypeScript made them.
//!
//! **Elimination stops the run, inside the call.** When damage kills, the run returns before anything of the
//! elimination is written. What the run must remember across that (the sorted hits, which bullets were spent, the
//! caster and target it stopped at) is kept here. Since #1214 stage 6e.2 the call carries the elimination out itself
//! (`combat_run` in `lib.rs`, `phase_three::eliminate_in_world`) and resumes the run, as Node's `drive` did, so a resume
//! still reads what the elimination and its syncs left in the stores.
use crate::action_combat::{self, Fact};
use crate::action_types::{Player, Rules};
use crate::collision::line_clear;
use crate::math::{hypot, js_max, js_min};
use crate::phase_seven::{MAX_REWIND_TICKS, Rewind};
use crate::players::Players;
use crate::sight::{GateSet, SightIndex};
use crate::swept::{SweptMap, hit_radius, impact};

pub const MODE_PROJECTILES: usize = 0;
pub const MODE_CASTERS: usize = 1;
pub const MODE_DAMAGE: usize = 2;
/// Input header: mode, resume (nonzero continues the retained run), tick, serial, player count, bullet
/// count, caster count, then a damage call's target, amount and source (-1 none). The rewind frames are
/// the core's own (`phase_seven::Rewind`, 27 step 5e.2).
pub const HEADER: usize = 11;
/// Header word: the call carries out a kill's elimination itself (#1214 stage 6e.2). Its words follow the casters: the
/// item and scatter serials, the gladiators' respawn delay, the markers' capacity, the loot's drop speed, then the
/// markers' count and keys.
pub const IN_RUN: usize = 10;
/// A player's fields (`Row`): role (0 contestant), status (0 active), kit, x, y, heading, hp, maxHp, shield, level,
/// cooldown, attackCd, stun, rank in ID order, view lag (0 when unset). The run reads them from the core's player
/// store (`players.rs`, #1214 stage 6c), not the input. A fresh projectile call's input holds, per player after the
/// bullets' header, a path flag and five substep points (`PATH_ROW`).
pub const PLAYER_ROW: usize = 15;
pub const PATH_ROW: usize = 11;
/// Per bullet: id, owner's roster index (-1 when absent), x, y, dx, dy, life, damage.
pub const BULLET_ROW: usize = 8;
/// Per caster, in `ordered(s)` order: roster index, warden skill pressed, gladiator attack pressed.
pub const CASTER_ROW: usize = 3;
/// Output header: length, serial, stopped (1: an elimination), its target, its source (-1 none), player
/// count, log length, bullet rows, removed bullet count.
pub const OUT_HEADER: usize = 9;
/// Per player out: hp, shield, cooldown, attackCd, stun.
pub const OUT_ROW: usize = 5;
pub const OP_EFFECT: f64 = 1.0;
pub const OP_AGGRESSION: f64 = 2.0;

const PROJECTILE_RADIUS: f64 = 2.0;
const STEPS: usize = 4;
const WARDEN: f64 = 0.0;
const EFFECT_SHOCK: usize = 0;

/// `n > 0`, false for NaN: the TypeScript's tests negate it.
fn positive(n: f64) -> bool {
    n > 0.0
}

/// A player's row, as `PLAYER_ROW` packs it. Phase 6's environment and traps (`hazards.rs`) read the same rows.
#[derive(Clone, Copy)]
pub(crate) struct Row {
    pub(crate) role: f64,
    pub(crate) status: f64,
    pub(crate) kit: f64,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) heading: f64,
    pub(crate) hp: f64,
    pub(crate) max_hp: f64,
    pub(crate) shield: f64,
    pub(crate) level: f64,
    pub(crate) cooldown: f64,
    pub(crate) attack_cd: f64,
    pub(crate) stun: f64,
    pub(crate) rank: f64,
    pub(crate) lag: f64,
}

impl Row {
    /// One packed row (`PLAYER_ROW` words).
    pub(crate) fn read(a: &[f64]) -> Row {
        Row {
            role: a[0],
            status: a[1],
            kit: a[2],
            x: a[3],
            y: a[4],
            heading: a[5],
            hp: a[6],
            max_hp: a[7],
            shield: a[8],
            level: a[9],
            cooldown: a[10],
            attack_cd: a[11],
            stun: a[12],
            rank: a[13],
            lag: a[14],
        }
    }
    /// The fields these rules write back (`OUT_ROW` words).
    pub(crate) fn write(&self, out: &mut Vec<f64>) {
        out.extend_from_slice(&[
            self.hp,
            self.shield,
            self.cooldown,
            self.attack_cd,
            self.stun,
        ]);
    }
}

struct Hit {
    bullet: usize,
    target: usize,
    toi: f64,
    id: f64,
    damage: f64,
    owner: Option<usize>,
}

enum Pending {
    Hits {
        hits: Vec<Hit>,
        next: usize,
        consumed: Vec<bool>,
        expired: Vec<bool>,
    },
    Casters {
        casters: Vec<[f64; CASTER_ROW]>,
        next: usize,
        /// 0: begin the caster; 1: the warden's targets from `target`; 2: the attack.
        step: u8,
        target: usize,
    },
}

#[derive(Default)]
pub struct Combat {
    pub input: Vec<f64>,
    pub output: Vec<f64>,
    pending: Option<Pending>,
}

/// A run's roster and log, with `damage`, which phase 6's environment and traps (`hazards.rs`) call directly.
pub(crate) struct Run<'a> {
    pub(crate) rows: Vec<Row>,
    pub(crate) log: Vec<f64>,
    pub(crate) serial: f64,
    pub(crate) tick: f64,
    pub(crate) hz: f64,
    pub(crate) frames: &'a Rewind,
}

impl Run<'_> {
    pub(crate) fn effect(&mut self, x: f64, y: f64, kind: usize, radius: f64) {
        self.log
            .extend_from_slice(&[OP_EFFECT, 5.0, self.serial, x, y, kind as f64, radius]);
        self.serial += 1.0;
    }

    /// `damage` (`combat.ts`) up to the elimination: true when the target is to be eliminated.
    pub(crate) fn damage(&mut self, target: usize, amount: f64, source: Option<usize>) -> bool {
        let t = &mut self.rows[target];
        if t.status != 0.0 {
            return false;
        }
        let blocked = js_min(t.shield, amount);
        t.shield -= blocked;
        t.hp = js_max(0.0, t.hp - amount + blocked);
        let hp = t.hp;
        if let Some(source) = source
            && source != target
        {
            self.log.extend_from_slice(&[
                OP_AGGRESSION,
                3.0,
                target as f64,
                source as f64,
                self.tick + 10.0 * self.hz,
            ]);
        }
        // `hp > 0` is false for NaN, which the TypeScript eliminated too.
        !positive(hp)
    }

    /// `asSeenBy(viewer)(target)` (`rewind.ts`): the target where this viewer's view showed it.
    fn seen(&self, viewer: usize, target: usize) -> (f64, f64) {
        let t = &self.rows[target];
        let lag = js_min(self.rows[viewer].lag, MAX_REWIND_TICKS as f64);
        // `lag <= 0`; a NaN lag found no frame there (it threw), and reads the present here.
        if !positive(lag) || self.frames.is_empty() {
            return (t.x, t.y);
        }
        let frame = self
            .frames
            .frame(js_max(0.0, self.frames.len() as f64 - lag) as usize);
        if target * 2 + 1 < frame.len() {
            (frame[target * 2], frame[target * 2 + 1])
        } else {
            (t.x, t.y)
        }
    }
}

/// `solvePhysicsProjectiles`' sweep: each live bullet's geometry contact and its earliest actor hit,
/// then the hits sorted by time of impact, bullet ID and target ID. Writes each bullet's row.
fn sweep(
    run: &Run<'_>,
    bullets: &mut [[f64; BULLET_ROW]],
    paths: &[Option<[[f64; 2]; STEPS + 1]>],
    swept: &SweptMap,
    gates: &GateSet,
) -> (Vec<Hit>, Vec<bool>) {
    let mut hits = Vec::new();
    let mut expired = vec![false; bullets.len()];
    for (b, bullet) in bullets.iter_mut().enumerate() {
        let [id, owner, x, y, dx, dy, _, damage] = *bullet;
        let origin = [x, y];
        let end = [x + dx, y + dy];
        bullet[6] -= 1.0;
        if bullet[6] <= 0.0 {
            expired[b] = true;
            continue;
        }
        let blocked_at = swept.contact(gates, true, origin, end, PROJECTILE_RADIUS, &[]);
        if blocked_at < f64::INFINITY {
            expired[b] = true;
        }
        for (t, target) in run.rows.iter().enumerate() {
            if owner == t as f64 || target.status != 0.0 {
                continue;
            }
            let path = paths
                .get(t)
                .copied()
                .flatten()
                .unwrap_or([[target.x, target.y]; STEPS + 1]);
            for k in 0..STEPS {
                let (kf, steps) = (k as f64, STEPS as f64);
                let a = [x + dx * kf / steps, y + dy * kf / steps];
                let b2 = [x + dx * (kf + 1.0) / steps, y + dy * (kf + 1.0) / steps];
                let Some(t_hit) =
                    impact(a, b2, path[k], path[k + 1], hit_radius(target.role != 0.0))
                else {
                    continue;
                };
                let toi = (kf + t_hit) / steps;
                if toi < blocked_at {
                    hits.push(Hit {
                        bullet: b,
                        target: t,
                        toi,
                        id,
                        damage,
                        owner: (owner >= 0.0).then_some(owner as usize),
                    });
                }
                break;
            }
        }
        bullet[2] = end[0];
        bullet[3] = end[1];
    }
    let rank = |t: usize| run.rows[t].rank;
    // The comparator `a.toi - b.toi || a.id - b.id || compare(ids)`: zero or NaN falls through.
    hits.sort_by(|a, b| {
        let by = |d: f64| {
            if d < 0.0 {
                Some(std::cmp::Ordering::Less)
            } else if d > 0.0 {
                Some(std::cmp::Ordering::Greater)
            } else {
                None
            }
        };
        by(a.toi - b.toi)
            .or_else(|| by(a.id - b.id))
            .unwrap_or_else(|| rank(a.target).total_cmp(&rank(b.target)))
    });
    (hits, expired)
}

/// The gladiator attack (`action_combat::attack`'s role-one branch) against rewound targets.
fn gladiator_attack(
    run: &mut Run<'_>,
    rules: &Rules,
    caster: usize,
    index: &SightIndex,
    gates: &mut GateSet,
) -> Option<(usize, usize)> {
    let c = run.rows[caster];
    let mut p = Player {
        roster: caster,
        key: 0,
        role: c.role,
        status: c.status,
        kit: c.kit as usize,
        x: c.x,
        y: c.y,
        heading: c.heading,
        hp: c.hp,
        max_hp: c.max_hp,
        shield: c.shield,
        selected: f64::NAN,
        weapon: 0.0,
        attack_cd: c.attack_cd,
        cooldown: c.cooldown,
        cloak: 0.0,
        revealed: 0.0,
        boost: 0.0,
        stun: c.stun,
        level: c.level,
        inventory: None,
        reserves: None,
        reload: None,
        retired: Vec::new(),
    };
    let targets: Vec<_> = (0..run.rows.len())
        .map(|t| {
            let (x, y) = run.seen(caster, t);
            (t, run.rows[t].role, run.rows[t].status, x, y)
        })
        .collect();
    let mut facts = Vec::new();
    action_combat::attack(
        &mut p,
        rules,
        &mut run.serial,
        &mut facts,
        &targets,
        index,
        gates,
    );
    run.rows[caster].attack_cd = p.attack_cd;
    for fact in facts {
        match fact {
            Fact::Effect {
                id,
                x,
                y,
                kind,
                radius,
            } => run
                .log
                .extend_from_slice(&[OP_EFFECT, 5.0, id, x, y, kind as f64, radius]),
            Fact::Damage {
                target,
                amount,
                source,
            } => {
                if run.damage(target, amount, Some(source)) {
                    return Some((target, source));
                }
            }
            _ => unreachable!("a gladiator's attack makes only an effect and damage"),
        }
    }
    None
}

/// The projectiles' flight, written back to the world's store (#1214 stage 6e.3) as Node writes its mirror: each bullet's
/// position and life from the first part's rows, then, once the call ended, the spent and expired ones removed.
pub(crate) fn fly(projectiles: &mut Vec<[f64; 8]>, first: &[f64], last: &[f64]) {
    let rows = OUT_HEADER + first[5] as usize * OUT_ROW + first[6] as usize;
    for (k, b) in projectiles.iter_mut().enumerate().take(first[7] as usize) {
        let at = rows + k * 3;
        (b[2], b[3], b[6]) = (first[at], first[at + 1], first[at + 2]);
    }
    if last[2] != 0.0 {
        return;
    }
    let removed_at =
        OUT_HEADER + last[5] as usize * OUT_ROW + last[6] as usize + last[7] as usize * 3;
    let removed: Vec<usize> = last[removed_at..removed_at + last[8] as usize]
        .iter()
        .map(|&i| i as usize)
        .collect();
    let mut k = 0;
    projectiles.retain(|_| {
        let keep = !removed.contains(&k);
        k += 1;
        keep
    });
}

impl Combat {
    /// Put the store's projectiles where a projectile call's adapter packed its bullets (6e.3).
    pub(crate) fn stored_bullets(&mut self, projectiles: &[[f64; 8]]) {
        let h = &self.input;
        let (mode, resume, players) = (h[0] as usize, h[1] != 0.0, h[4] as usize);
        let mut at = HEADER;
        if mode == MODE_PROJECTILES && !resume {
            at += players * PATH_ROW;
        }
        let mut input = self.input[..at].to_vec();
        input[5] = projectiles.len() as f64;
        input.extend(projectiles.iter().flatten());
        input.extend_from_slice(&self.input[at..]);
        self.input = input;
    }

    /// The elimination words of a call that carries out its kills itself (`IN_RUN`), and the markers.
    pub(crate) fn elimination_words(&self) -> Option<(crate::phase_three::Elimination, Vec<u32>)> {
        let h = &self.input;
        if h.len() <= IN_RUN || h[IN_RUN] == 0.0 {
            return None;
        }
        let (mode, resume, players) = (h[0] as usize, h[1] != 0.0, h[4] as usize);
        let mut at = HEADER;
        if mode == MODE_PROJECTILES && !resume {
            at += players * PATH_ROW;
        }
        at += h[5] as usize * BULLET_ROW + h[6] as usize * CASTER_ROW;
        let w = &h[at..];
        let markers = w[5] as usize;
        Some((
            crate::phase_three::Elimination {
                tick: h[2],
                serial: h[3],
                item_serial: w[0],
                scatter_serial: w[1],
                respawn: w[2],
                capacity: w[3],
                drop_speed: w[4],
            },
            w[6..6 + markers].iter().map(|&k| k as u32).collect(),
        ))
    }

    /// Run a call. `swept` is needed only by a fresh projectile call; `rewind` is phase 7's frames.
    pub fn run(
        &mut self,
        players: &mut Players,
        rules: &Rules,
        rewind: &Rewind,
        index: &SightIndex,
        gates: &mut GateSet,
        swept: Option<&SweptMap>,
    ) {
        let input = std::mem::take(&mut self.input);
        let h = &input[..HEADER];
        let mode = h[0] as usize;
        let resume = h[1] != 0.0;
        let (store, players) = (players, h[4] as usize);
        let mut at = HEADER;
        let rows = store.take(players);
        let mut paths = Vec::new();
        for _ in 0..players {
            if mode == MODE_PROJECTILES && !resume {
                let a = &input[at..at + PATH_ROW];
                at += PATH_ROW;
                paths.push((a[0] != 0.0).then(|| {
                    let mut path = [[0.0; 2]; STEPS + 1];
                    for (k, point) in path.iter_mut().enumerate() {
                        *point = [a[1 + k * 2], a[2 + k * 2]];
                    }
                    path
                }));
            }
        }
        let mut bullets: Vec<[f64; BULLET_ROW]> = (0..h[5] as usize)
            .map(|i| {
                let mut row = [0.0; BULLET_ROW];
                row.copy_from_slice(&input[at + i * BULLET_ROW..at + (i + 1) * BULLET_ROW]);
                row
            })
            .collect();
        at += bullets.len() * BULLET_ROW;
        let casters: Vec<[f64; CASTER_ROW]> = (0..h[6] as usize)
            .map(|i| {
                let mut row = [0.0; CASTER_ROW];
                row.copy_from_slice(&input[at + i * CASTER_ROW..at + (i + 1) * CASTER_ROW]);
                row
            })
            .collect();
        let mut run = Run {
            rows,
            log: Vec::new(),
            serial: h[3],
            tick: h[2],
            hz: rules.hz,
            frames: rewind,
        };
        let mut stop: Option<(usize, Option<usize>)> = None;
        let mut removed = Vec::new();
        if !resume {
            self.pending = None;
        }
        match mode {
            MODE_PROJECTILES => {
                if !resume {
                    let swept = swept.expect("a projectile call needs the swept map");
                    let (hits, expired) = sweep(&run, &mut bullets, &paths, swept, gates);
                    self.pending = Some(Pending::Hits {
                        consumed: vec![false; bullets.len()],
                        hits,
                        next: 0,
                        expired,
                    });
                }
                let Some(Pending::Hits {
                    hits,
                    next,
                    consumed,
                    expired,
                }) = &mut self.pending
                else {
                    panic!("no projectile run to resume");
                };
                while *next < hits.len() {
                    let hit = &hits[*next];
                    *next += 1;
                    if consumed[hit.bullet] || run.rows[hit.target].status != 0.0 {
                        continue;
                    }
                    consumed[hit.bullet] = true;
                    if run.damage(hit.target, hit.damage, hit.owner) {
                        stop = Some((hit.target, hit.owner));
                        break;
                    }
                }
                if stop.is_none() {
                    removed = (0..consumed.len())
                        .filter(|&b| consumed[b] || expired[b])
                        .map(|b| b as f64)
                        .collect();
                    self.pending = None;
                }
            }
            MODE_CASTERS => {
                if !resume {
                    self.pending = Some(Pending::Casters {
                        casters,
                        next: 0,
                        step: 0,
                        target: 0,
                    });
                }
                let Some(Pending::Casters {
                    casters,
                    next,
                    step,
                    target,
                }) = &mut self.pending
                else {
                    panic!("no caster run to resume");
                };
                'casters: while *next < casters.len() {
                    let [roster, skill, attack] = casters[*next];
                    let c = roster as usize;
                    if *step == 0 {
                        if run.rows[c].status != 0.0 {
                            *next += 1;
                            continue;
                        }
                        *step = 2;
                        // `skill` (`combat.ts`) for a warden: cooldown, then a gladiator's shock.
                        let p = run.rows[c];
                        if skill != 0.0 && p.kit == WARDEN && !positive(p.cooldown) && p.role != 0.0
                        {
                            run.rows[c].cooldown =
                                js_max(45.0, rules.kit_cooldown[0] - (p.level - 1.0) * 12.0);
                            run.effect(p.x, p.y, EFFECT_SHOCK, 130.0);
                            *step = 1;
                            *target = 0;
                        }
                    }
                    if *step == 1 {
                        while *target < run.rows.len() {
                            let t = *target;
                            *target += 1;
                            let (p, q) = (run.rows[c], run.rows[t]);
                            if q.role == p.role || q.status != 0.0 {
                                continue;
                            }
                            let (sx, sy) = run.seen(c, t);
                            if hypot(p.x - sx, p.y - sy) < 130.0
                                && line_clear(index, gates, (p.x, p.y), (sx, sy)).0
                            {
                                let eliminated = run.damage(t, 18.0 + 5.0 * p.level, Some(c));
                                // Set after the damage, as the TypeScript did, whatever it did.
                                run.rows[t].stun = 22.0;
                                if eliminated {
                                    stop = Some((t, Some(c)));
                                    break 'casters;
                                }
                            }
                        }
                        *step = 2;
                    }
                    *next += 1;
                    *step = 0;
                    if attack != 0.0
                        && run.rows[c].role != 0.0
                        && let Some((t, source)) =
                            gladiator_attack(&mut run, rules, c, index, gates)
                    {
                        stop = Some((t, Some(source)));
                        break;
                    }
                }
                if stop.is_none() {
                    self.pending = None;
                }
            }
            MODE_DAMAGE => {
                let target = h[7] as usize;
                let source = (h[9] >= 0.0).then_some(h[9] as usize);
                if run.damage(target, h[8], source) {
                    stop = Some((target, source));
                }
            }
            _ => panic!("unknown combat mode {mode}"),
        }
        let mut out = std::mem::take(&mut self.output);
        out.clear();
        let bullet_rows = if mode == MODE_PROJECTILES && !resume {
            bullets.len()
        } else {
            0
        };
        out.extend_from_slice(&[
            0.0,
            run.serial,
            if stop.is_some() { 1.0 } else { 0.0 },
            stop.map_or(-1.0, |s| s.0 as f64),
            stop.and_then(|s| s.1).map_or(-1.0, |s| s as f64),
            run.rows.len() as f64,
            run.log.len() as f64,
            bullet_rows as f64,
            removed.len() as f64,
        ]);
        for r in &run.rows {
            r.write(&mut out);
        }
        out.extend_from_slice(&run.log);
        for b in bullets.iter().take(bullet_rows) {
            out.extend_from_slice(&[b[2], b[3], b[6]]);
        }
        out.extend_from_slice(&removed);
        out[0] = out.len() as f64;
        self.output = out;
        self.input = input;
        store.restore(run.rows);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(role: f64, x: f64, y: f64) -> Row {
        Row {
            role,
            status: 0.0,
            kit: 0.0,
            x,
            y,
            heading: 0.0,
            hp: 100.0,
            max_hp: 100.0,
            shield: 10.0,
            level: 1.0,
            cooldown: 0.0,
            attack_cd: 0.0,
            stun: 0.0,
            rank: 0.0,
            lag: 0.0,
        }
    }

    #[test]
    fn damage_spends_the_shield_first_and_reports_a_kill() {
        let mut run = Run {
            rows: vec![row(0.0, 0.0, 0.0), row(1.0, 0.0, 0.0)],
            log: Vec::new(),
            serial: 1.0,
            tick: 5.0,
            hz: 20.0,
            frames: &Rewind::default(),
        };
        assert!(!run.damage(0, 30.0, Some(1)));
        assert_eq!((run.rows[0].shield, run.rows[0].hp), (0.0, 80.0));
        assert_eq!(run.log, vec![OP_AGGRESSION, 3.0, 0.0, 1.0, 205.0]);
        assert!(run.damage(0, 200.0, None));
        assert_eq!(run.rows[0].hp, 0.0);
        run.rows[0].status = 2.0;
        assert!(
            !run.damage(0, 1.0, None),
            "only an active target takes damage"
        );
    }

    #[test]
    fn a_lagging_viewer_reads_the_frame_it_saw() {
        let mut frames = Rewind::default();
        frames.record(&[5.0, 6.0]);
        frames.record(&[1.0, 2.0, 3.0, 4.0]);
        let mut run = Run {
            rows: vec![row(0.0, 10.0, 10.0), row(1.0, 20.0, 20.0)],
            log: Vec::new(),
            serial: 1.0,
            tick: 5.0,
            hz: 20.0,
            frames: &frames,
        };
        assert_eq!(run.seen(1, 0), (10.0, 10.0), "no lag, no rewind");
        run.rows[1].lag = 1.0;
        assert_eq!(run.seen(1, 1), (3.0, 4.0));
        run.rows[1].lag = 30.0;
        assert_eq!(
            run.seen(1, 0),
            (5.0, 6.0),
            "past the window, the oldest kept"
        );
        assert_eq!(
            run.seen(1, 1),
            (20.0, 20.0),
            "a frame without the target reads the present"
        );
    }
}
