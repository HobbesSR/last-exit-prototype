//! Phase 3 and its shared attack/drop entry points (27, step 5c.2).
//! The loop's drops sync inside the run (#1214 stage 6d.6b): a committed drop adds its records to the ground store,
//! launches them and runs the body sync (`boundary::synchronize`), whose log goes to the output as a fact (`OP_SYNC`), then
//! the loop goes on with what Node would have repacked. An elimination's drops still return at the sync boundary, and
//! the adapter resumes at the next step.
//!
//! Input header: mode (loop, a contestant's scenario attack, carried plan, ammo plan, elimination), resume player and
//! operation, tick, serial, item/scatter serials, ground count, reserved actor bodies,
//! counts of action players, context actors, free label phases, known item IDs, near
//! ground positions, ground IDs, carried identities and hooks; mandatory, ammo family/count,
//! whether the loop syncs its drops in the run (`InRun`'s words then follow the lists). Each action player is 24 scalar
//! words, optional reserves/reload triples, ten words per carried slot, then 15 intent words. Context actors are seven scalars,
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
use crate::ground;
use crate::math::js_min;
use crate::placement::Disk;
use crate::sight::{GateSet, SightIndex};
use crate::swept::SweptMap;
use crate::world::World;

pub const HEADER: usize = 21;
pub const MODE_ELIMINATE: usize = 4;
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
        let _radii: [f64; 2] = r.row();
        let loot_radius = r.n();
        let hearing_ticks = r.n();
        let discovery_cell = r.n();
        let map_width = r.n();
        let map_height = r.n();
        let hook_cooldown = r.n();
        let hz = r.n();
        let movement = r.row();
        let utility = r.row();
        let kit_cooldown = r.vec(4);
        let _kit_damage: [f64; 4] = r.row();
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
            acceleration,
            braking,
            surfaces,
            loot_radius,
            hearing_ticks,
            discovery_cell,
            map_width,
            map_height,
            hook_cooldown,
            hz,
            movement,
            utility,
        });
    }
}
/// The inventory length an adapter writes for an inventory the core takes from its player store (#1214 stage 6c.3c.2).
pub const FROM_STORE: f64 = -2.0;

/// What the loop needs to sync a drop inside its run (#1214 stage 6d.6b), packed after the input's lists when header word
/// 20 is set: the markers' capacity, the roster's size, the loot's drop speed, the markers' count and keys, then each
/// free label phase's body key (`item:instance-<phase>`, parallel to the phases) and each carried identity's body key
/// (`item:<label>`, parallel to the carried pairs; NaN unless a dropper carries it). Node interns those keys; the core
/// does not intern strings.
struct InRun<'s> {
    swept: &'s SweptMap,
    capacity: f64,
    roster: f64,
    drop_speed: f64,
    /// The carried pairs no action player held when the call began: the rest are rebuilt from the players as they stand.
    others: Vec<[f64; 2]>,
}

/// A drop record's body key (#1214 stage 6e.1): a new allocation's `item:instance-<phase>`, interned by the core, else
/// the registered identity's, from the world's registry.
pub(crate) fn record_key(
    world: &mut World,
    allocation: &Allocation,
    record: &drop_planner::Record,
) -> f64 {
    match allocation.facts.iter().find(|f| f[0] == record.id) {
        Some(fact) => f64::from(world.allocation_key(fact[1])),
        None => world.registry.key(record.id).unwrap_or(f64::NAN),
    }
}

/// The allocations' facts for the output, each with its body key (Node adopts it), registered in the world's registry
/// where the call writes and the run read the registry (6e.1): `id, phase, key`.
pub(crate) fn allocation_facts(
    world: &mut World,
    allocation: &mut Allocation,
    register: bool,
    out: &mut Vec<f64>,
) {
    let live = allocation.registry.take().is_some();
    for &[id, phase] in &allocation.facts {
        let key = match (live, register) {
            (true, true) => f64::from(world.register_allocation(id, phase)),
            (true, false) => f64::from(world.allocation_key(phase)),
            (false, _) => f64::NAN,
        };
        out.extend_from_slice(&[id, phase, key]);
    }
}

/// A drop's body sync inside the run (#1214 stage 6d.6b): its records reach the ground store and launch from
/// their dropper, the hooks' and the store's facts so far reach the world (the sync reconciles the hooks, and reads an
/// eliminated target's status), then the body sync runs where Node ran it at the stop, and its log goes to the output.
/// Returns false when the sync refused, which ends the run as Node's throw did.
#[allow(clippy::too_many_arguments)]
fn sync_drop(
    world: &mut World,
    map: &mut CollisionMap,
    gates: &mut GateSet,
    sync: &InRun<'_>,
    rules: &Rules,
    allocation: &Allocation,
    records: &[drop_planner::Record],
    (roster, x, y): (usize, f64, f64),
    tick: f64,
    log: &mut Vec<f64>,
    cursors: &mut (usize, usize),
) -> bool {
    let keys: Vec<f64> = records
        .iter()
        .map(|record| record_key(world, allocation, record))
        .collect();
    let words: Vec<f64> = records
        .iter()
        .zip(&keys)
        .flat_map(|(record, &key)| ground_words(rules, record, key, roster as f64, tick))
        .collect();
    world.add_ground(&words);
    for (record, &key) in records.iter().zip(&keys) {
        launch(world, key, record, (x, y), sync.drop_speed);
    }
    apply_hook_facts(world, log, &mut cursors.0, tick);
    world.players.apply_action_log(&log[cursors.1..]);
    let out = sync.synchronize(world, map, gates, tick);
    op(log, OP_SYNC, &out);
    *cursors = (log.len(), log.len());
    out[0] >= 0.0
}

/// The context actors as the resumed call read them from the store after a sync: role, status and pose.
fn refresh(actors: &mut [Actor], world: &World) {
    for a in actors {
        let s = &world.players.rows[a.roster];
        (a.role, a.status, a.x, a.y) = (s.role, s.status, s.x, s.y);
    }
}

impl InRun<'_> {
    /// The body sync, as `r.synchronize()` ran it at the stop.
    fn synchronize(
        &self,
        world: &mut World,
        map: &mut CollisionMap,
        gates: &mut GateSet,
        tick: f64,
    ) -> Vec<f64> {
        crate::boundary::synchronize_in_run(
            world,
            map,
            gates,
            self.swept,
            tick,
            self.capacity,
            self.roster,
        )
    }

    /// The carried identities as Node packs them: every roster player's carried items with an identity, the action
    /// players' as they now stand (`current` in place of player `at`), the others' as the call began.
    fn carried(&self, players: &[Player], at: usize, current: &Player) -> Vec<[f64; 2]> {
        let mut carried = self.others.clone();
        for (j, q) in players.iter().enumerate() {
            let q = if j == at { current } else { q };
            for item in q.inventory.iter().flatten().flatten() {
                if !item.missing(crate::action_types::ABSENT_INSTANCE) && truthy(item.instance) {
                    carried.push([item.token, item.instance]);
                }
            }
        }
        carried
    }
}

/// The world's hooks as phase 3 reads them: caster, interned key, and whether the caster's hook key is the hook's.
fn world_hooks(world: &World) -> Vec<[f64; 3]> {
    world
        .hooks
        .iter()
        .map(|hook| {
            // As `hooks.rs` reads it: a caster index the store does not hold matches nothing.
            let matches = (hook.caster >= 0.0)
                .then(|| world.players.extra.get(hook.caster as usize))
                .flatten()
                .is_some_and(|caster| caster.hook_key as u32 == hook.key);
            [
                hook.caster,
                f64::from(hook.key),
                f64::from(u8::from(matches)),
            ]
        })
        .collect()
}

/// The fact a drop that synced in the run leaves for Node: its records, as op 9 carries them, to add without writing
/// them through (`addItems` from the core).
pub const OP_DROP_SYNCED: f64 = 16.0;
/// The body sync's log (`boundary::synchronize`'s header and entries), applied by Node as its own sync's.
pub const OP_SYNC: f64 = 15.0;

/// Walk the log's facts from `cursor`, applying the hooks' launches and cancels (#1214 stage 6d.4) and the shots
/// fired (op 2, 6e.3) to the world, as Node applies them to its mirror. A sync inside the run reconciles the hooks, so
/// they are applied before it.
fn apply_hook_facts(world: &mut World, log: &[f64], cursor: &mut usize, tick: f64) {
    let mut at = *cursor;
    while at < log.len() {
        let (op, len) = (log[at], log[at + 1] as usize);
        let p = &log[at + 2..at + 2 + len];
        if op == 5.0 {
            world.cancel_hook(p[0] as usize);
        } else if op == 6.0 {
            world.launch_hook(p[0] as usize, p[1], p[2], p[3], tick);
        } else if op == 2.0 {
            // id, owner, x, y, dx, dy, life, damage: phase 5's row.
            let mut row = [0.0; 8];
            row.copy_from_slice(&p[..8]);
            world.projectiles.push(row);
        }
        at += 2 + len;
    }
    *cursor = at;
}

/// A drop's ground record in the store's words (`ground::RECORD`), as `ground-store.ts` packs the record `ground` in
/// `phase-three.ts` builds from the same row: the fields that record has, and the absence mask of those it lacks.
pub(crate) fn ground_words(
    rules: &Rules,
    record: &drop_planner::Record,
    key: f64,
    roster: f64,
    tick: f64,
) -> [f64; ground::RECORD] {
    const AMMO: u32 = 1;
    const CHARGE: u32 = 2;
    const INSTANCE: u32 = 4;
    const QUALITY: u32 = 16;
    const WEAPON: u32 = 32;
    const COUNT: u32 = 64;
    const FAMILY: u32 = 128;
    let item = &record.item;
    let index = |v: f64, len: usize| v >= 0.0 && v.fract() == 0.0 && (v as usize) < len;
    let mut w = [f64::NAN; ground::RECORD];
    w[0] = record.id;
    w[1] = key;
    w[2] = record.x;
    w[3] = record.y;
    w[4] = item.kind;
    w[9] = -1.0;
    w[11] = item.lineage;
    w[13] = roster;
    w[14] = tick + rules.hz;
    let mut absent = AMMO | CHARGE | INSTANCE | QUALITY | WEAPON | COUNT | FAMILY;
    if item.kind == 5.0 {
        w[7] = item.count;
        absent &= !COUNT;
        if index(record.family, 3) {
            w[9] = record.family;
            absent &= !FAMILY;
        }
    } else {
        if !item.quality.is_nan() {
            w[12] = item.quality;
            absent &= !QUALITY;
        }
        if item.kind == 0.0 {
            if index(item.weapon, rules.weapons.len()) {
                w[5] = item.weapon;
                absent &= !WEAPON;
            }
            w[6] = item.ammo;
            absent &= !AMMO;
        } else if item.kind == 3.0 {
            w[8] = item.charge;
            absent &= !CHARGE;
        } else {
            w[7] = 1.0;
            absent &= !COUNT;
        }
    }
    w[15] = f64::from(absent);
    w
}

/// `launchPhysicalDrops`: each record leaves its dropper at the drop speed, along the line from the dropper.
pub(crate) fn launch(
    world: &mut World,
    key: f64,
    record: &drop_planner::Record,
    from: (f64, f64),
    speed: f64,
) {
    let (dx, dy) = (record.x - from.0, record.y - from.1);
    let length = crate::math::hypot(dx, dy);
    // JavaScript's `length ? … : 0`: zero and NaN are falsy.
    let (vx, vy) = if length != 0.0 && !length.is_nan() {
        (dx / length * speed, dy / length * speed)
    } else {
        (0.0, 0.0)
    };
    world.launch(key as crate::world::Key, vx, vy);
}

/// One action player's row; the flag says the adapter asked for its inventory from the store.
fn read_player(r: &mut Reader<'_>) -> (Player, bool) {
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
    let player = Player {
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
    };
    (player, a[20] == FROM_STORE)
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
        }
    }
}

/// `eliminate` (`lifecycle.ts`) from `from`, its steps in order: the record's lifecycle (0), each slot's
/// mandatory drop (1 to n), each reserve family's (n + 1 to n + 3), then the inventory's clear and the
/// kill credit. A committed drop returns the next step, at 5c.2's sync boundary.
#[allow(clippy::too_many_arguments)]
fn eliminate(
    players: &mut [Player],
    rules: &Rules,
    ctx: &mut Context<'_>,
    // Every carried identity; each plan is given all but the dropped item's.
    carried: &[[f64; 2]],
    allocation: &mut Allocation,
    serial: &mut f64,
    log: &mut Vec<f64>,
    from: usize,
    [source, kills, respawn]: [f64; 3],
    tick: f64,
    drop_op: f64,
) -> Option<(usize, Vec<drop_planner::Record>)> {
    let slots = players[0].inventory.as_ref().map_or(0, Vec::len);
    let source = (source >= 0.0).then_some(source as usize);
    for step in from..slots + 5 {
        let p = &mut players[0];
        if step == 0 {
            // Status, the event (its ID), charging cleared, and a gladiator's respawn with its
            // input cleared: JavaScript writes these in that order (op 12).
            let respawn_at = if p.role == 1.0 {
                tick + respawn
            } else {
                f64::NAN
            };
            let source_roster = source.map_or(-1.0, |s| players[s].roster as f64);
            let p = &mut players[0];
            op(
                log,
                12.0,
                &[p.roster as f64, *serial, source_roster, respawn_at],
            );
            *serial += 1.0;
            p.status = if p.role == 1.0 { 2.0 } else { 1.0 };
        } else if step <= slots {
            let Some(item) = p.inventory.as_ref().unwrap()[step - 1].clone() else {
                continue;
            };
            let ids: Vec<f64> = carried
                .iter()
                .filter(|t| t[0] != item.token)
                .map(|t| t[1])
                .collect();
            let mut ctx = Context {
                world: ctx.world,
                map: ctx.map,
                index: ctx.index,
                gates: ctx.gates,
                actors: ctx.actors,
                taken: ctx.taken,
                ground_ids: ctx.ground_ids,
                carried_ids: &ids,
                ground_count: ctx.ground_count,
            };
            let plan =
                drop_planner::plan_drop(&mut ctx, rules, (p.x, p.y), &item, true, allocation);
            if let Some(plan) = plan {
                *allocation = plan.allocation.clone();
                p.inventory.as_mut().unwrap()[step - 1] = None;
                sync_weapon(p, rules);
                op(log, 10.0, &[p.roster as f64]);
                let mut row = vec![p.roster as f64, plan.records.len() as f64];
                records(&mut row, &plan);
                op(log, drop_op, &row);
                return Some((step + 1, plan.records));
            }
        } else if step <= slots + 3 {
            let family = step - slots - 1;
            if family == 0 {
                // `dropReserves` writes `reload = null` even where it was absent (op 14).
                p.reload = None;
                op(log, 14.0, &[p.roster as f64]);
            }
            let Some(reserves) = p.reserves.filter(|_| rules.reloading) else {
                continue;
            };
            // `dropReserve(family, reserves[family], true)`: a non-integer count refuses.
            let count = reserves[family];
            if !safe(count) || count <= 0.0 {
                continue;
            }
            let ids: Vec<f64> = carried.iter().map(|t| t[1]).collect();
            let mut ctx = Context {
                world: ctx.world,
                map: ctx.map,
                index: ctx.index,
                gates: ctx.gates,
                actors: ctx.actors,
                taken: ctx.taken,
                ground_ids: ctx.ground_ids,
                carried_ids: &ids,
                ground_count: ctx.ground_count,
            };
            let plan = drop_planner::plan_ammo(
                &mut ctx,
                rules,
                (p.x, p.y),
                family as f64,
                count,
                true,
                allocation,
            );
            if let Some(plan) = plan {
                *allocation = plan.allocation.clone();
                p.reserves.as_mut().unwrap()[family] -= count;
                let mut row = vec![p.roster as f64, plan.records.len() as f64];
                records(&mut row, &plan);
                op(log, drop_op, &row);
                return Some((step + 1, plan.records));
            }
        } else {
            if let Some(inventory) = p.inventory.as_mut() {
                inventory.fill(None);
                sync_weapon(p, rules);
            }
            let Some(s) = source else { break };
            let q = &mut players[s];
            if q.role == 1.0 {
                let kills = kills + 1.0;
                q.level = js_min(4.0, 1.0 + kills);
                q.max_hp += 20.0;
                q.hp = js_min(q.max_hp, q.hp + 45.0);
                q.cooldown = 0.0;
                op(log, 13.0, &[q.roster as f64, kills, q.level, q.max_hp]);
                op(log, 1.0, &[*serial, q.x, q.y, 4.0, 90.0]);
                *serial += 1.0;
            } else {
                op(
                    log,
                    13.0,
                    &[q.roster as f64, kills + 1.0, f64::NAN, f64::NAN],
                );
            }
        }
    }
    None
}

impl PhaseThree {
    pub fn run(
        &mut self,
        world: &mut World,
        map: &mut CollisionMap,
        index: &SightIndex,
        gates: &mut GateSet,
        swept: Option<&SweptMap>,
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
        let mut from_store = Vec::new();
        let mut intents = Vec::new();
        for _ in 0..h[9] as usize {
            let (p, store) = read_player(&mut r);
            players.push(p);
            from_store.push(store);
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
        // The store's fields come from the core's player store (#1214 stage 6c.3b); the adapter leaves those words 0.
        // So does the equipment (6c.3c.2): selection, weapon, reserves and reload always, as the adapter packed them,
        // and the inventory where the adapter asked for it.
        for (p, &store) in players.iter_mut().zip(&from_store) {
            world.players.fill_action(p);
            world.players.fill_equipment(p, store);
        }
        for a in &mut actors {
            let s = &world.players.rows[a.roster];
            (a.role, a.status, a.x, a.y) = (s.role, s.status, s.x, s.y);
            // The cues it heard are the store's too (#1214 stage 6e.4); the adapter sends none.
            if a.heard.is_empty() {
                a.heard = world
                    .players
                    .heard
                    .get(a.roster)
                    .cloned()
                    .unwrap_or_default();
            }
        }
        let phases = r.vec(h[11] as usize);
        let registered = r.vec(h[12] as usize);
        let mut taken: Vec<[f64; 2]> = (0..h[13] as usize).map(|_| r.row()).collect();
        let mut ground_ids = r.vec(h[14] as usize);
        let mut carried: Vec<[f64; 2]> = (0..h[15] as usize).map(|_| r.row()).collect();
        // Hooks: caster, interned constraint key, exact caster/id match. They are the world's (#1214 stage 6d.4): where the
        // adapter would have packed them it writes `FROM_STORE` for their count.
        let hooks_from_store = h[16] == FROM_STORE;
        let mut hooks: Vec<[f64; 3]> = if hooks_from_store {
            world_hooks(world)
        } else {
            (0..h[16] as usize).map(|_| r.row()).collect()
        };
        // An elimination's source: -1 none, 0 the target itself, 1 the second player; its kills; the
        // gladiator respawn delay.
        let elimination: [f64; 3] = if mode == MODE_ELIMINATE {
            r.row()
        } else {
            [-1.0, 0.0, 0.0]
        };
        // A loop with droppers syncs each drop inside the run (#1214 stage 6d.6b); every other call stops at a drop.
        // So does an elimination (6e.2), whose drops each stopped the call before.
        let in_run = ((mode == 0 || mode == MODE_ELIMINATE) && h[20] != 0.0).then(|| {
            let [capacity, roster, drop_speed, markers] = r.row();
            world.markers = r.vec(markers as usize).iter().map(|&k| k as u32).collect();
            let held: Vec<f64> = players
                .iter()
                .filter_map(|p| p.inventory.as_ref())
                .flatten()
                .flatten()
                .map(|item| item.token)
                .collect();
            InRun {
                swept: swept.expect("a sync inside the run needs the swept map"),
                capacity,
                roster,
                drop_speed,
                others: carried
                    .iter()
                    .copied()
                    .filter(|c| !held.contains(&c[0]))
                    .collect(),
            }
        });
        // How far the log's facts have reached the world: the hooks', then the player store's.
        let mut cursors = (0usize, 0usize);
        let mut stopped = false;
        let mut ground_count = h[7] as usize;
        let mut reserve_actors = h[8] as usize;
        let mut allocation = Allocation {
            item_serial: h[5],
            scatter_serial: h[6],
            phases,
            registered,
            facts: Vec::new(),
            // The world's registry where the adapter says so (`FROM_STORE` for the phases, #1214 stage 6e.1).
            registry: (h[11] == FROM_STORE && world.registry_live).then(|| world.registry.clone()),
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
                ground_count,
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
        } else if mode == MODE_ELIMINATE {
            // The target is no longer active when its loot drops, so its body leaves no disk.
            let target = players[0].roster;
            let mut from = h[2] as usize;
            loop {
                let disks: Vec<Disk> = actors
                    .iter()
                    .filter(|a| a.status == 0.0 && a.roster != target)
                    .map(|a| [a.x, a.y, a.radius])
                    .collect();
                let mut ctx = Context {
                    world,
                    map,
                    index,
                    gates,
                    actors: &disks,
                    taken: &taken,
                    ground_ids: &ground_ids,
                    carried_ids: &[],
                    ground_count,
                };
                let drop_op = if in_run.is_some() {
                    OP_DROP_SYNCED
                } else {
                    9.0
                };
                let Some((step, records)) = eliminate(
                    &mut players,
                    rules,
                    &mut ctx,
                    &carried,
                    &mut allocation,
                    &mut serial,
                    &mut log,
                    from,
                    elimination,
                    tick,
                    drop_op,
                ) else {
                    break;
                };
                let Some(sync) = in_run.as_ref() else {
                    resume = (0.0, step as f64);
                    break;
                };
                // Each drop syncs where the call stopped before (6e.2), and the elimination goes on at its next step
                // with what the next call repacked.
                let dropper = (target, players[0].x, players[0].y);
                if !sync_drop(
                    world,
                    map,
                    gates,
                    sync,
                    rules,
                    &allocation,
                    &records,
                    dropper,
                    tick,
                    &mut log,
                    &mut cursors,
                ) {
                    break;
                }
                taken.extend(records.iter().map(|record| [record.x, record.y]));
                ground_ids.extend(records.iter().map(|record| record.id));
                ground_count += records.len();
                carried = sync.carried(&players, 0, &players[0]);
                refresh(&mut actors, world);
                from = step;
            }
        } else {
            for i in h[1] as usize..players.len() {
                let mut p = players[i].clone();
                let a = intents[i];
                let stage = if i == h[1] as usize { h[2] as usize } else { 0 };
                let mut facts = Vec::new();
                if mode == 1 {
                    // A contestant's attack reads no targets; a gladiator's is in `tick/combat.rs`.
                    action_combat::attack(&mut p, rules, &mut serial, &mut facts);
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
                        action_combat::attack(&mut p, rules, &mut serial, &mut facts);
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
                        ground_count,
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
                    if let Some(plan) = plan
                        .filter(|plan| world.can_add_bodies(plan.records.len() + reserve_actors))
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
                        let Some(sync) = in_run.as_ref() else {
                            op(&mut log, 9.0, &row);
                            resume = (i as f64, (drop_stage + 1) as f64);
                            break;
                        };
                        // The drop's records reach the ground and launch, and the world syncs, where Node did at the
                        // stop: the hooks' facts first, since the sync reconciles the hooks.
                        op(&mut log, OP_DROP_SYNCED, &row);
                        let dropper = (p.roster, p.x, p.y);
                        if !sync_drop(
                            world,
                            map,
                            gates,
                            sync,
                            rules,
                            &allocation,
                            &plan.records,
                            dropper,
                            tick,
                            &mut log,
                            &mut cursors,
                        ) {
                            stopped = true;
                            break;
                        }
                        refresh(&mut actors, world);
                        // What Node repacked for the next call: the new records among the taken spots and on the
                        // ground, the actor bodies' reserve, the carried identities as they stand, and the hooks.
                        taken.extend(plan.records.iter().map(|record| [record.x, record.y]));
                        ground_ids.extend(plan.records.iter().map(|record| record.id));
                        ground_count += plan.records.len();
                        reserve_actors = (sync.roster as usize).saturating_sub(world.sync_actors);
                        carried = sync.carried(&players, i, &p);
                        if hooks_from_store {
                            hooks = world_hooks(world);
                        }
                    }
                }
                if resume.0 >= 0.0 || stopped {
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
                                    players[i] = p;
                                    break;
                                }
                            }
                            // remove() changed the hook list before commitMutations; a failed
                            // queue leaves it alone, but a failed commit keeps that removal.
                            op(&mut log, 5.0, &[p.roster as f64]);
                            let code = world.commit();
                            let mut row = vec![f64::from(code)];
                            row.extend_from_slice(world.output());
                            row.push(world.queued_count() as f64);
                            op(&mut log, 8.0, &row);
                            if code < 0 {
                                error = (f64::from(code), -1.0);
                                players[i] = p;
                                break;
                            }
                        } else if p.cooldown <= 0.0 {
                            world.counts();
                            let count = world.output()[3];
                            let active = hooks
                                .iter()
                                .filter(|h| h[1] >= 0.0 && world.has_constraint(h[1] as u32))
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
                    action_combat::attack(&mut p, rules, &mut serial, &mut facts);
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
        // The hooks' launches and cancels reach the world, as Node applies them to its mirror (#1214 stage 6d.4).
        apply_hook_facts(world, &log, &mut cursors.0, tick);
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
        allocation_facts(
            world,
            &mut allocation,
            mode < 2 || mode == MODE_ELIMINATE,
            &mut out,
        );
        out.extend_from_slice(&log);
        if let Some(plan) = planned {
            records(&mut out, &plan);
        }
        out[0] = out.len() as f64;
        self.output = out;
    }
}
