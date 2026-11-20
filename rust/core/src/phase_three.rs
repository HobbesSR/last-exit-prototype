//! Phase 3 and its shared attack/drop entry points (27, step 5c.2).
//! A successful drop returns at the sync boundary; the adapter admits bounded item chunks,
//! then repacks the changed poses and resumes at the next operation of that same player.
//!
//! Input header: mode (loop, shared attack, carried plan, ammo plan), resume player and
//! operation, tick, serial, item/scatter serials, ground count, reserved actor bodies,
//! counts of action players, context actors, free label phases, known item IDs, near
//! ground positions, ground IDs, carried identities and hooks; mandatory, ammo family/count,
//! reserved. Each action player is 24 scalar words, optional reserves/reload triples,
//! ten words per carried slot, then 15 intent words. Context actors are seven scalars,
//! a cue count and four words per cue. The remaining lists follow in header order.
//! Output: word length, serials, resume player/operation, plan success, player count,
//! registration count, log length, plan record count and error/value. Updated player
//! rows (without intents, with retired-item rows) precede registration pairs, the ordered
//! log (opcode, length, payload), and any standalone plan's fourteen-word records.
use crate::action_combat::{self, Fact};
use crate::action_equipment::{advance_reload, rearrange, sync_weapon};
use crate::action_types::{Item, Player, Rules, Weapon, present, safe, truthy};
use crate::collision::CollisionMap;
use crate::drop_planner::{self, Allocation, Context, Plan};
use crate::placement::Disk;
use crate::sight::{GateSet, SightIndex};
use crate::world::World;

pub const HEADER: usize = 21;
#[derive(Default)]
pub struct PhaseThree {
    pub input: Vec<f64>,
    pub output: Vec<f64>,
    rules: Option<Rules>,
}
struct Reader<'a> {
    v: &'a [f64],
    at: usize,
}
impl Reader<'_> {
    fn n(&mut self) -> f64 {
        let n = self.v[self.at];
        self.at += 1;
        n
    }
    fn count(&mut self) -> usize {
        self.n() as usize
    }
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
}
impl PhaseThree {
    pub fn configure(&mut self) {
        let mut r = Reader {
            v: &self.input,
            at: 0,
        };
        let ground_capacity = r.n();
        let reloading = r.n() != 0.0;
        let acceleration = r.n();
        let braking = r.n();
        let radii = r.row();
        let loot_radius = r.n();
        let hearing_ticks = r.n();
        let discovery_cell = r.n();
        let map_width = r.n();
        let map_height = r.n();
        let hook_cooldown = r.n();
        let kit_cooldown = r.vec(4);
        let kit_damage = r.vec(4);
        let n = r.count();
        let quality_damage = r.vec(n);
        let n = r.count();
        let mut weapons = Vec::with_capacity(n);
        for _ in 0..n {
            let a: [f64; 11] = r.row();
            weapons.push(Weapon {
                ammo: a[0],
                max_ammo: a[1],
                cooldown: a[2],
                speed: a[3],
                life: a[4],
                damage: a[5],
                reload: if a[6] < 0.0 {
                    None
                } else {
                    Some([a[6], a[7], a[8]])
                },
                hearing: a[9],
                spread: r.vec(a[10] as usize),
            });
        }
        let n = r.count();
        let surfaces = (0..n).map(|_| r.row()).collect();
        self.rules = Some(Rules {
            weapons,
            ground_capacity,
            reloading,
            quality_damage,
            kit_cooldown,
            kit_damage,
            acceleration,
            braking,
            surfaces,
            radii,
            loot_radius,
            hearing_ticks,
            discovery_cell,
            map_width,
            map_height,
            hook_cooldown,
        });
    }
}
fn read_player(r: &mut Reader<'_>) -> Player {
    let a: [f64; 24] = r.row();
    let reserves = if a[21] != 0.0 { Some(r.row()) } else { None };
    let reload = if a[22] != 0.0 { Some(r.row()) } else { None };
    let inventory = if a[20] < 0.0 {
        None
    } else {
        Some(
            (0..a[20] as usize)
                .map(|_| {
                    let a: [f64; 10] = r.row();
                    if a[0] == -1.0 {
                        None
                    } else {
                        Some(Item::read(&a))
                    }
                })
                .collect(),
        )
    };
    Player {
        roster: a[0] as usize,
        key: a[1] as u32,
        role: a[2],
        status: a[3],
        kit: a[4] as usize,
        x: a[5],
        y: a[6],
        heading: a[7],
        hp: a[8],
        max_hp: a[9],
        shield: a[10],
        selected: a[11],
        weapon: a[12],
        attack_cd: a[13],
        cooldown: a[14],
        cloak: a[15],
        revealed: a[16],
        boost: a[17],
        stun: a[18],
        level: a[19],
        inventory,
        reserves,
        reload,
        retired: Vec::new(),
    }
}
fn write_player(out: &mut Vec<f64>, p: &Player) {
    out.extend_from_slice(&[
        p.roster as f64,
        f64::from(p.key),
        p.role,
        p.status,
        p.kit as f64,
        p.x,
        p.y,
        p.heading,
        p.hp,
        p.max_hp,
        p.shield,
        p.selected,
        p.weapon,
        p.attack_cd,
        p.cooldown,
        p.cloak,
        p.revealed,
        p.boost,
        p.stun,
        p.level,
        p.inventory.as_ref().map_or(-1.0, |i| i.len() as f64),
        if p.reserves.is_some() { 1.0 } else { 0.0 },
        if p.reload.is_some() { 1.0 } else { 0.0 },
        p.retired.len() as f64,
    ]);
    if let Some(a) = p.reserves {
        out.extend_from_slice(&a);
    }
    if let Some(a) = p.reload {
        out.extend_from_slice(&a);
    }
    if let Some(inv) = &p.inventory {
        for item in inv {
            out.extend_from_slice(&item.as_ref().map_or([-1.0; 10], Item::row));
        }
    }
    for item in &p.retired {
        out.extend_from_slice(&item.row());
    }
}
struct Actor {
    roster: usize,
    role: f64,
    status: f64,
    x: f64,
    y: f64,
    radius: f64,
    heard: Vec<[f64; 4]>,
}
fn op(out: &mut Vec<f64>, kind: f64, row: &[f64]) {
    out.extend_from_slice(&[kind, row.len() as f64]);
    out.extend_from_slice(row);
}
fn records(out: &mut Vec<f64>, plan: &Plan) {
    for r in &plan.records {
        out.extend_from_slice(&r.item.row());
        out.extend_from_slice(&[r.id, r.x, r.y, r.family]);
    }
}
fn combat_facts(
    log: &mut Vec<f64>,
    facts: Vec<Fact>,
    actors: &mut [Actor],
    rules: &Rules,
    tick: f64,
) {
    for fact in facts {
        match fact {
            Fact::Effect {
                id,
                x,
                y,
                kind,
                radius,
            } => op(log, 1.0, &[id, x, y, kind as f64, radius]),
            Fact::Projectile {
                id,
                owner,
                x,
                y,
                dx,
                dy,
                life,
                damage,
            } => op(log, 2.0, &[id, owner as f64, x, y, dx, dy, life, damage]),
            Fact::Damage {
                target,
                amount,
                source,
            } => op(log, 4.0, &[target as f64, amount, source as f64]),
            Fact::Shot { shooter, weapon } => {
                let Some(p) = actors.iter().find(|p| p.roster == shooter) else {
                    continue;
                };
                let (x, y) = (p.x, p.y);
                let range = rules.weapons[weapon].hearing;
                if !truthy(range)
                    || x < 0.0
                    || y < 0.0
                    || x >= rules.map_width
                    || y >= rules.map_height
                {
                    continue;
                }
                let cx = (x / rules.discovery_cell).floor() * rules.discovery_cell
                    + rules.discovery_cell / 2.0;
                let cy = (y / rules.discovery_cell).floor() * rules.discovery_cell
                    + rules.discovery_cell / 2.0;
                for p in actors.iter_mut() {
                    let (dx, dy) = (p.x - x, p.y - y);
                    if p.roster == shooter || p.status != 0.0 || dx * dx + dy * dy >= range * range
                    {
                        continue;
                    }
                    p.heard
                        .retain(|c| c[3] > tick && (c[0] != cx || c[1] != cy));
                    p.heard.push([cx, cy, tick, tick + rules.hearing_ticks]);
                    let mut row = vec![p.roster as f64, p.heard.len() as f64];
                    for cue in &p.heard {
                        row.extend_from_slice(cue);
                    }
                    op(log, 3.0, &row);
                }
            }
            Fact::HookCancel { caster } => op(log, 5.0, &[caster as f64]),
            Fact::HookLaunch {
                caster,
                generation,
                dx,
                dy,
            } => op(log, 6.0, &[caster as f64, generation, dx, dy]),
        }
    }
}

impl PhaseThree {
    pub fn run(
        &mut self,
        world: &mut World,
        map: &mut CollisionMap,
        index: &SightIndex,
        gates: &mut GateSet,
    ) {
        let rules = self.rules.as_ref().expect("configured phase 3");
        let h = &self.input[..HEADER];
        let mode = h[0] as usize;
        let tick = h[3];
        let mut serial = h[4];
        let mut r = Reader {
            v: &self.input,
            at: HEADER,
        };
        let mut players = Vec::new();
        let mut intents = Vec::new();
        for _ in 0..h[9] as usize {
            players.push(read_player(&mut r));
            intents.push(r.row::<15>());
        }
        let mut actors = Vec::new();
        for _ in 0..h[10] as usize {
            let a: [f64; 7] = r.row();
            let n = r.count();
            actors.push(Actor {
                roster: a[0] as usize,
                role: a[1],
                status: a[2],
                x: a[3],
                y: a[4],
                radius: a[5],
                heard: (0..n).map(|_| r.row()).collect(),
            });
        }
        let phases = r.vec(h[11] as usize);
        let registered = r.vec(h[12] as usize);
        let taken: Vec<[f64; 2]> = (0..h[13] as usize).map(|_| r.row()).collect();
        let ground_ids = r.vec(h[14] as usize);
        let carried: Vec<[f64; 2]> = (0..h[15] as usize).map(|_| r.row()).collect();
        // Hooks: caster, interned constraint key, exact caster/id match.
        let mut hooks: Vec<[f64; 3]> = (0..h[16] as usize).map(|_| r.row()).collect();
        let mut allocation = Allocation {
            item_serial: h[5],
            scatter_serial: h[6],
            phases,
            registered,
            facts: Vec::new(),
        };
        let mut log = Vec::new();
        let mut resume = (-1.0, 0.0);
        let mut ok = 1.0;
        let mut planned: Option<Plan> = None;
        let mut error = (0.0, 0.0);
        if mode == 2 || mode == 3 {
            let p = &players[0];
            let disks: Vec<Disk> = actors
                .iter()
                .filter(|a| a.status == 0.0)
                .map(|a| [a.x, a.y, a.radius])
                .collect();
            let item = p.inventory.as_ref().and_then(|v| v[0].as_ref());
            let ids: Vec<f64> = carried
                .iter()
                .filter(|a| item.is_none_or(|i| a[0] != i.token))
                .map(|a| a[1])
                .collect();
            let mut ctx = Context {
                world,
                map,
                index,
                gates,
                actors: &disks,
                taken: &taken,
                ground_ids: &ground_ids,
                carried_ids: &ids,
                ground_count: h[7] as usize,
            };
            planned = if mode == 2 {
                item.and_then(|item| {
                    drop_planner::plan_drop(
                        &mut ctx,
                        rules,
                        (p.x, p.y),
                        item,
                        h[17] != 0.0,
                        &allocation,
                    )
                })
            } else {
                drop_planner::plan_ammo(
                    &mut ctx,
                    rules,
                    (p.x, p.y),
                    h[18],
                    h[19],
                    h[17] != 0.0,
                    &allocation,
                )
            };
            ok = if planned.is_some() { 1.0 } else { 0.0 };
            if let Some(plan) = &planned {
                allocation = plan.allocation.clone();
            }
        } else {
            for i in h[1] as usize..players.len() {
                let mut p = players[i].clone();
                let a = intents[i];
                let stage = if i == h[1] as usize { h[2] as usize } else { 0 };
                let mut facts = Vec::new();
                if mode == 1 {
                    let targets: Vec<_> = actors
                        .iter()
                        .map(|t| (t.roster, t.role, t.status, t.x, t.y))
                        .collect();
                    action_combat::attack(
                        &mut p,
                        rules,
                        &mut serial,
                        &mut facts,
                        &targets,
                        index,
                        gates,
                    );
                    combat_facts(&mut log, facts, &mut actors, rules, tick);
                    players[i] = p;
                    break;
                }
                if stage == 0 {
                    p.heading = if truthy(a[0]) { a[0] } else { 0.0 };
                    if p.inventory.is_some() && !a[1].is_nan() {
                        p.selected = a[1];
                        sync_weapon(&mut p, rules);
                    }
                    if !a[2].is_nan()
                        && let Err(e) = rearrange(&mut p, rules, a[2], a[3], &mut allocation)
                    {
                        error = (f64::from(e.0), e.1);
                        players[i] = p;
                        break;
                    }
                    if !a[4].is_nan() && p.selected == a[4] {
                        let targets = [];
                        action_combat::attack(
                            &mut p,
                            rules,
                            &mut serial,
                            &mut facts,
                            &targets,
                            index,
                            gates,
                        );
                    }
                    combat_facts(
                        &mut log,
                        std::mem::take(&mut facts),
                        &mut actors,
                        rules,
                        tick,
                    );
                }
                // Resume after a committed slot or reserve drop, never repeat its prior operations.
                let discard = if !a[5].is_nan() {
                    a[5]
                } else if a[6] != 0.0 {
                    p.selected
                } else {
                    f64::NAN
                };
                for drop_stage in 0..2 {
                    if stage > drop_stage {
                        continue;
                    }
                    let item = if drop_stage == 0 && safe(discard) && discard >= 0.0 {
                        p.inventory
                            .as_ref()
                            .and_then(|v| v.get(discard as usize))
                            .and_then(Option::as_ref)
                    } else {
                        None
                    };
                    let ammo = drop_stage == 1
                        && rules.reloading
                        && p.reserves.is_some()
                        && safe(a[7])
                        && (0.0..3.0).contains(&a[7])
                        && safe(a[8]);
                    if item.is_none() && !ammo {
                        continue;
                    }
                    let disks: Vec<Disk> = actors
                        .iter()
                        .filter(|t| t.status == 0.0)
                        .map(|t| [t.x, t.y, t.radius])
                        .collect();
                    let ids: Vec<f64> = carried
                        .iter()
                        .filter(|t| item.is_none_or(|item| t[0] != item.token))
                        .map(|t| t[1])
                        .collect();
                    let mut ctx = Context {
                        world,
                        map,
                        index,
                        gates,
                        actors: &disks,
                        taken: &taken,
                        ground_ids: &ground_ids,
                        carried_ids: &ids,
                        ground_count: h[7] as usize,
                    };
                    let plan = if let Some(item) = item {
                        drop_planner::plan_drop(
                            &mut ctx,
                            rules,
                            (p.x, p.y),
                            item,
                            false,
                            &allocation,
                        )
                    } else {
                        let count = crate::math::js_min(a[8], p.reserves.unwrap()[a[7] as usize]);
                        if count <= 0.0 {
                            None
                        } else {
                            drop_planner::plan_ammo(
                                &mut ctx,
                                rules,
                                (p.x, p.y),
                                a[7],
                                count,
                                false,
                                &allocation,
                            )
                        }
                    };
                    if let Some(plan) =
                        plan.filter(|plan| world.can_add_bodies(plan.records.len() + h[8] as usize))
                    {
                        allocation = plan.allocation.clone();
                        if drop_stage == 0 {
                            p.inventory.as_mut().unwrap()[discard as usize] = None;
                            sync_weapon(&mut p, rules);
                            op(&mut log, 10.0, &[p.roster as f64]);
                        } else {
                            p.reserves.as_mut().unwrap()[a[7] as usize] -=
                                plan.records[0].item.count;
                        }
                        let mut row = vec![p.roster as f64, plan.records.len() as f64];
                        records(&mut row, &plan);
                        op(&mut log, 9.0, &row);
                        resume = (i as f64, (drop_stage + 1) as f64);
                        break;
                    }
                }
                if resume.0 >= 0.0 {
                    players[i] = p;
                    break;
                }
                advance_reload(&mut p, rules, tick, a[9] != 0.0);
                if a[10] != 0.0 && p.kit != 0 {
                    if p.kit == 3 && p.role == 1.0 && p.status == 0.0 {
                        if let Some(at) = hooks
                            .iter()
                            .position(|hook| hook[0] == p.roster as f64 && hook[2] != 0.0)
                        {
                            let hook = hooks.remove(at);
                            let key = hook[1] as u32;
                            if world.has_constraint(key) {
                                let code = world.queue_remove_constraint(key);
                                if code < 0 {
                                    error = (f64::from(code), f64::from(key));
                                }
                            }
                            let code = world.commit();
                            let mut row = vec![f64::from(code)];
                            row.extend_from_slice(world.output());
                            op(&mut log, 8.0, &row);
                            op(&mut log, 5.0, &[p.roster as f64]);
                        } else if p.cooldown <= 0.0 {
                            world.counts();
                            let count = world.output()[3];
                            let active = hooks
                                .iter()
                                .filter(|h| world.has_constraint(h[1] as u32))
                                .count();
                            let generation = world.generation(p.key);
                            if count - active as f64 + (hooks.len() as f64) < 8.0
                                && generation >= 0.0
                            {
                                p.cooldown = rules.hook_cooldown;
                                let dx = crate::math::cos(p.heading);
                                let dy = crate::math::sin(p.heading);
                                op(&mut log, 6.0, &[p.roster as f64, generation, dx, dy]);
                                hooks.push([p.roster as f64, -1.0, 1.0]);
                            }
                        }
                    } else {
                        let opponents: Vec<_> = actors
                            .iter()
                            .map(|a| (a.roster, a.role, a.x, a.y))
                            .collect();
                        for roster in
                            action_combat::skill(&mut p, rules, &mut serial, &mut facts, &opponents)
                        {
                            op(&mut log, 11.0, &[roster as f64, 110.0]);
                        }
                    }
                }
                if a[11] != 0.0 && p.role == 0.0 {
                    let targets = [];
                    action_combat::attack(
                        &mut p,
                        rules,
                        &mut serial,
                        &mut facts,
                        &targets,
                        index,
                        gates,
                    );
                }
                combat_facts(&mut log, facts, &mut actors, rules, tick);
                let motor = action_combat::motor(
                    &p,
                    rules,
                    present(a[12], 0.0),
                    present(a[13], 0.0),
                    a[14] != 0.0,
                );
                let code = world.set_motor(p.key, motor[0], motor[1], motor[2]);
                if code < 0 {
                    error = (f64::from(code), f64::from(p.key));
                } else {
                    op(
                        &mut log,
                        7.0,
                        &[f64::from(p.key), motor[0], motor[1], motor[2]],
                    );
                }
                players[i] = p;
                if error.0 < 0.0 {
                    break;
                }
            }
        }
        let mut out = std::mem::take(&mut self.output);
        out.clear();
        out.extend_from_slice(&[
            0.0,
            serial,
            allocation.item_serial,
            allocation.scatter_serial,
            resume.0,
            resume.1,
            ok,
            players.len() as f64,
            allocation.facts.len() as f64,
            log.len() as f64,
            planned.as_ref().map_or(0.0, |p| p.records.len() as f64),
            error.0,
            error.1,
        ]);
        for p in &players {
            write_player(&mut out, p);
        }
        for a in &allocation.facts {
            out.extend_from_slice(a);
        }
        out.extend_from_slice(&log);
        if let Some(plan) = planned {
            records(&mut out, &plan);
        }
        out[0] = out.len() as f64;
        self.output = out;
    }
}
