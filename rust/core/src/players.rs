//! The game's players as the core keeps them (#1214, docs/27 "The state flip", step 6c).
//!
//! One store per world, in roster order, that runs read and write in place of rows of their own.
//! Until the remaining standalone adapters retire, the adapter uploads the store from JavaScript's
//! records before each call (`shared/simulation/player-store.ts`), and the store reports writes
//! back to those records.
use crate::action_types::Item;
use crate::math::hypot;
use crate::physics::SUBSTEPS;
use crate::world::STEP_HEADER;

/// A player's fixed row (`Row`): role (0 contestant), status (0 active), kit, x, y, heading, hp,
/// maxHp, shield, level, cooldown, attackCd, stun, rank in ID order, view lag (0 when unset).
pub const PLAYER_ROW: usize = 15;

/// A player's packed fields (`PLAYER_ROW` words).
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
}

/// Words of `Extra` uploaded: respawnAt, transit arriveAt, the transit's destination station index (-1 none), railCd,
/// cloak, revealed, boost, the actor's world key (`actor:<id>`) and its hook's (`hook:<id>`, #1214 stage 6d.4), and its
/// kills (6e.2, the kill credit an elimination inside a run reads), and whether it is a bot and has a discovery memory
/// (6e.4, which phase 6 reads). An absent field is NaN.
pub const EXTRA_ROW: usize = 12;
/// Words per heard cue (`HeardCue`: x, y, tick, until), after each player's carried items in the upload (6e.4).
pub const CUE: usize = 4;
/// Words per player uploaded: `Row` (`PLAYER_ROW` words), `movedThisTick` (0 when unset), then `Extra`.
pub const STORE_ROW: usize = PLAYER_ROW + 1 + EXTRA_ROW;

/// Words of a player's equipment header in the upload, after every player's fixed row: `selectedSlot` (NaN absent),
/// `weapon`, `keys`, `charging` (the charger's index, -1 none, -2 an unknown charger), the inventory's length (-1 none),
/// whether reserves follow and their three families, whether a reload follows and its slot, instance and until. The
/// inventory's items follow, ten words each (`action_types::Item`; -1 first for an empty slot).
pub const EQUIP_HEAD: usize = 13;
/// Words per carried item (`action_types::Item::row`).
pub const ITEM_ROW: usize = 10;

/// A player's equipment (#1214 stage 6c.3c.1). Items keep their absence mask, so the records' key order survives. Each
/// item's token names the record that mirrors it (6c.3c.2): the upload numbers the carried records in roster and slot
/// order, and a new item takes the next token when the store takes it (`put_items`), in the order the adapter builds it.
#[derive(Clone, Default)]
pub(crate) struct Equip {
    pub(crate) selected: f64,
    pub(crate) weapon: f64,
    pub(crate) keys: f64,
    pub(crate) charging: f64,
    pub(crate) inventory: Option<Vec<Option<Item>>>,
    pub(crate) reserves: Option<[f64; 3]>,
    pub(crate) reload: Option<[f64; 3]>,
}

/// An empty slot's row, as `appendItem` writes it.
const EMPTY_ROW: [f64; ITEM_ROW] = [
    -1.0,
    f64::NAN,
    f64::NAN,
    f64::NAN,
    f64::NAN,
    f64::NAN,
    f64::NAN,
    f64::NAN,
    f64::NAN,
    63.0,
];

/// One inventory row as the adapters write it: `None` for an empty slot.
fn item(row: &[f64]) -> Option<Item> {
    (row[0] != -1.0).then(|| Item::read(row))
}

/// Write `count` inventory rows from `rows` into slots `0..count`, as `putInventory` and phase 3's loop write them. A new
/// item (token -1) takes the next token, in slot order, as the adapter files the record it builds.
fn put_items(q: &mut Equip, next_token: &mut f64, rows: &[f64], count: usize) {
    let inventory = q.inventory.get_or_insert_with(Vec::new);
    if inventory.len() < count {
        inventory.resize(count, None);
    }
    for (k, slot) in inventory.iter_mut().take(count).enumerate() {
        *slot = item(&rows[k * ITEM_ROW..(k + 1) * ITEM_ROW]).map(|mut i| {
            if i.token < 0.0 {
                i.token = *next_token;
                *next_token += 1.0;
            }
            i
        });
    }
}

/// The fields phase 1 reads beyond `Row`.
#[derive(Clone, Copy, Default)]
pub(crate) struct Extra {
    pub(crate) respawn_at: f64,
    pub(crate) arrive_at: f64,
    pub(crate) destination: f64,
    pub(crate) rail_cd: f64,
    pub(crate) cloak: f64,
    pub(crate) revealed: f64,
    pub(crate) boost: f64,
    pub(crate) key: f64,
    /// The world key of this player's hook (`hook:<id>`), interned by JavaScript, so the core names a hook it launches
    /// with the key JavaScript's table holds.
    pub(crate) hook_key: f64,
    /// `kills`, which the kill credit counts on (6e.2).
    pub(crate) kills: f64,
    /// Whether the player is a bot, and whether it holds a discovery memory (`p.discovery`): phase 6 reads both (6e.4).
    pub(crate) bot: f64,
    pub(crate) discovery: f64,
}

#[derive(Default)]
pub struct Players {
    /// Each player's fields, in roster order.
    pub(crate) rows: Vec<Row>,
    /// Each player's `movedThisTick`, in roster order.
    pub(crate) moved: Vec<f64>,
    /// Each player's further fields, in roster order.
    pub(crate) extra: Vec<Extra>,
    /// Each player's equipment, in roster order.
    pub(crate) equip: Vec<Equip>,
    /// The cues each player heard (`p.heard`), in roster order (#1214 stage 6e.4): phase 3 reads and writes them.
    pub(crate) heard: Vec<Vec<[f64; CUE]>>,
    /// The token the next new item takes (`put_items`).
    pub(crate) next_token: f64,
    input: Vec<f64>,
}

impl Players {
    /// The upload buffer, resized to `words`: every player's fixed row, then each one's equipment.
    pub fn input(&mut self, words: usize) -> &mut [f64] {
        self.input.resize(words, 0.0);
        &mut self.input
    }

    /// Replace the store with the uploaded rows.
    pub fn load(&mut self, count: usize) {
        assert!(
            self.input.len() >= count * STORE_ROW,
            "the upload holds every player"
        );
        self.rows.clear();
        self.moved.clear();
        self.extra.clear();
        self.equip.clear();
        self.heard.clear();
        let mut at = count * STORE_ROW;
        for _ in 0..count {
            let h = &self.input[at..at + EQUIP_HEAD];
            at += EQUIP_HEAD;
            let inventory = (h[4] >= 0.0).then(|| {
                let items = (0..h[4] as usize)
                    .map(|k| item(&self.input[at + k * ITEM_ROW..at + (k + 1) * ITEM_ROW]))
                    .collect();
                at += h[4] as usize * ITEM_ROW;
                items
            });
            let cues = self.input[at] as usize;
            self.heard.push(
                self.input[at + 1..at + 1 + cues * CUE]
                    .as_chunks::<CUE>()
                    .0
                    .to_vec(),
            );
            at += 1 + cues * CUE;
            self.equip.push(Equip {
                selected: h[0],
                weapon: h[1],
                keys: h[2],
                charging: h[3],
                inventory,
                reserves: (h[5] != 0.0).then_some([h[6], h[7], h[8]]),
                reload: (h[9] != 0.0).then_some([h[10], h[11], h[12]]),
            });
        }
        assert_eq!(
            at,
            self.input.len(),
            "the upload ends with the last equipment"
        );
        self.next_token = self
            .equip
            .iter()
            .flat_map(|q| q.inventory.iter().flatten().flatten())
            .map(|i| i.token + 1.0)
            .fold(0.0, f64::max);
        for row in self.input[..count * STORE_ROW].as_chunks::<STORE_ROW>().0 {
            self.rows.push(Row::read(&row[..PLAYER_ROW]));
            self.moved.push(row[PLAYER_ROW]);
            let e = &row[PLAYER_ROW + 1..];
            self.extra.push(Extra {
                respawn_at: e[0],
                arrive_at: e[1],
                destination: e[2],
                rail_cd: e[3],
                cloak: e[4],
                revealed: e[5],
                boost: e[6],
                key: e[7],
                hook_key: e[8],
                kills: e[9],
                bot: e[10],
                discovery: e[11],
            });
        }
    }

    /// The store in the upload's layout, written into the upload buffer, for tests that hold it equal to a fresh upload.
    pub fn dump(&mut self) -> &[f64] {
        let mut words = std::mem::take(&mut self.input);
        words.clear();
        for ((r, e), &moved) in self.rows.iter().zip(&self.extra).zip(&self.moved) {
            words.extend_from_slice(&[
                r.role,
                r.status,
                r.kit,
                r.x,
                r.y,
                r.heading,
                r.hp,
                r.max_hp,
                r.shield,
                r.level,
                r.cooldown,
                r.attack_cd,
                r.stun,
                r.rank,
                r.lag,
                moved,
                e.respawn_at,
                e.arrive_at,
                e.destination,
                e.rail_cd,
                e.cloak,
                e.revealed,
                e.boost,
                e.key,
                e.hook_key,
                e.kills,
                e.bot,
                e.discovery,
            ]);
        }
        for (q, cues) in self.equip.iter().zip(&self.heard) {
            let (res, rel) = (q.reserves.unwrap_or([0.0; 3]), q.reload.unwrap_or([0.0; 3]));
            words.extend_from_slice(&[
                q.selected,
                q.weapon,
                q.keys,
                q.charging,
                q.inventory.as_ref().map_or(-1.0, |i| i.len() as f64),
                if q.reserves.is_some() { 1.0 } else { 0.0 },
                res[0],
                res[1],
                res[2],
                if q.reload.is_some() { 1.0 } else { 0.0 },
                rel[0],
                rel[1],
                rel[2],
            ]);
            for slot in q.inventory.iter().flatten() {
                words.extend_from_slice(&slot.as_ref().map_or(EMPTY_ROW, Item::row));
            }
            words.push(cues.len() as f64);
            words.extend(cues.iter().flatten());
        }
        self.input = words;
        &self.input
    }

    /// Phase 3's action player (`action_types::Player`) takes the store's fields, by its roster index.
    pub(crate) fn fill_action(&self, p: &mut crate::action_types::Player) {
        let (s, e) = (&self.rows[p.roster], &self.extra[p.roster]);
        p.key = e.key as u32;
        (p.role, p.status, p.kit) = (s.role, s.status, s.kit as usize);
        (p.x, p.y, p.heading) = (s.x, s.y, s.heading);
        (p.hp, p.max_hp, p.shield) = (s.hp, s.max_hp, s.shield);
        (p.attack_cd, p.cooldown, p.stun, p.level) = (s.attack_cd, s.cooldown, s.stun, s.level);
        (p.cloak, p.revealed, p.boost) = (e.cloak, e.revealed, e.boost);
    }

    /// An action player's equipment from the store: selection, weapon, reserves and reload, and the inventory when the
    /// adapter asked for it (`inventory`), as it would have packed them.
    pub(crate) fn fill_equipment(&self, p: &mut crate::action_types::Player, inventory: bool) {
        let q = &self.equip[p.roster];
        (p.selected, p.weapon, p.reserves, p.reload) = (q.selected, q.weapon, q.reserves, q.reload);
        if inventory {
            p.inventory = q.inventory.clone();
        }
    }

    /// How many players the store holds.
    pub fn len(&self) -> usize {
        self.extra.len()
    }

    /// Phase 4's write-back (`tick.ts`): each active player whose body the step moved takes its path's end as its pose,
    /// and the path's length as `movedThisTick`, summed substep by substep as `world.ts`'s `step` sums it. `step` is the
    /// world's step output (`World::step`).
    pub(crate) fn after_step(&mut self, step: &[f64]) {
        if step.len() <= STEP_HEADER || step[0] != 0.0 {
            return;
        }
        let n = step[2] as usize;
        let keys = &step[STEP_HEADER..STEP_HEADER + n];
        let base = STEP_HEADER + n;
        for (i, (r, e)) in self.rows.iter_mut().zip(&self.extra).enumerate() {
            if r.status != 0.0 {
                continue;
            }
            let Some(b) = keys.iter().position(|&k| k == e.key) else {
                continue;
            };
            let (mut x, mut y, mut travelled) = (step[base + 2 * b], step[base + 2 * b + 1], 0.0);
            for substep in 1..=SUBSTEPS {
                let at = base + (substep * n + b) * 2;
                let (nx, ny) = (step[at], step[at + 1]);
                travelled += hypot(nx - x, ny - y);
                (x, y) = (nx, ny);
            }
            r.x = x;
            r.y = y;
            self.moved[i] = travelled;
        }
    }

    /// Phase 3's writes to the store's fields, read from its output (`phase_three.rs`) in the order
    /// `shared/simulation/phase-three.ts` applies them: each written player row when the mode writes rows (the loop, a
    /// scenario attack or an elimination), then the log's reveal, elimination and kill-credit facts.
    pub(crate) fn apply_actions(&mut self, mode: f64, out: &[f64]) {
        const OUT_HEADER: usize = 13;
        const ROW: usize = 24;
        let writes = mode < 2.0 || mode == 4.0;
        let mut at = OUT_HEADER;
        for _ in 0..out[7] as usize {
            let row = &out[at..at + ROW];
            let (inventory, reserves, reload, retired) = (row[20], row[21], row[22], row[23]);
            if writes && let Some(r) = self.rows.get_mut(row[0] as usize) {
                r.heading = row[7];
                r.hp = row[8];
                r.shield = row[10];
                r.attack_cd = row[13];
                r.cooldown = row[14];
                if let Some(e) = self.extra.get_mut(row[0] as usize) {
                    e.cloak = row[15];
                    e.boost = row[17];
                }
            }
            at += ROW;
            // The equipment, as `phase-three.ts` writes it: selection and weapon, then reserves, reload and inventory.
            let mut q = self.equip.get_mut(row[0] as usize).filter(|_| writes);
            if let Some(q) = q.as_mut() {
                q.selected = row[11];
                q.weapon = row[12];
            }
            if reserves != 0.0 {
                if let Some(q) = q.as_mut() {
                    q.reserves = Some([out[at], out[at + 1], out[at + 2]]);
                }
                at += 3;
            }
            if reload != 0.0 {
                if let Some(q) = q.as_mut() {
                    q.reload = Some([out[at], out[at + 1], out[at + 2]]);
                }
                at += 3;
            } else if let Some(q) = q.as_mut() {
                q.reload = None;
            }
            if inventory >= 0.0 {
                if let Some(q) = q.as_mut() {
                    put_items(q, &mut self.next_token, &out[at..], inventory as usize);
                }
                at += inventory as usize * ITEM_ROW;
            }
            at += retired as usize * ITEM_ROW;
        }
        // Each registration fact: id, phase, body key (#1214 stage 6e.1).
        at += out[8] as usize * 3;
        self.apply_action_log(&out[at..at + out[9] as usize]);
    }

    /// Phase 3's log facts that write the store (charging cleared, a reveal, an elimination, kill credit, reload
    /// cleared), in order. A run applies each part before it syncs inside itself (#1214 stage 6e.2), so the sync reads
    /// the eliminated target's status; each is an assignment, so `apply_actions` applying them again after is the same.
    pub(crate) fn apply_action_log(&mut self, log: &[f64]) {
        let out = log;
        let (mut at, end) = (0, log.len());
        while at < end {
            let (op, len) = (out[at], out[at + 1] as usize);
            let p = &out[at + 2..at + 2 + len];
            let i = p.first().map_or(usize::MAX, |&i| i as usize);
            match op as u32 {
                10 => {
                    if let Some(q) = self.equip.get_mut(i) {
                        q.charging = -1.0;
                    }
                }
                11 => {
                    if let Some(e) = self.extra.get_mut(i) {
                        e.revealed = p[1];
                    }
                }
                3 => {
                    // The cues a shot left a hearer: the whole list (6e.4).
                    if let Some(h) = self.heard.get_mut(i) {
                        *h = p[2..2 + p[1] as usize * CUE].as_chunks::<CUE>().0.to_vec();
                    }
                }
                14 => {
                    if let Some(q) = self.equip.get_mut(i) {
                        q.reload = None;
                    }
                }
                12 => {
                    if let Some(q) = self.equip.get_mut(i) {
                        q.charging = -1.0;
                    }
                    if let (Some(r), Some(e)) = (self.rows.get_mut(i), self.extra.get_mut(i)) {
                        r.status = if p[3].is_nan() { 1.0 } else { 2.0 };
                        if !p[3].is_nan() {
                            e.respawn_at = p[3];
                        }
                    }
                }
                13 => {
                    if let Some(e) = self.extra.get_mut(i) {
                        e.kills = p[1];
                    }
                    if !p[2].is_nan()
                        && let Some(r) = self.rows.get_mut(i)
                    {
                        r.level = p[2];
                        r.max_hp = p[3];
                    }
                }
                _ => {}
            }
            at += 2 + len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upload_replaces_the_store_in_roster_order() {
        let mut players = Players::default();
        // Two fixed rows, then the first player's equipment with one weapon and an empty slot, the second's with none,
        // each ending with an empty list of heard cues.
        let words = 2 * STORE_ROW + EQUIP_HEAD + 2 * ITEM_ROW + 1 + EQUIP_HEAD + 1;
        let input = players.input(words);
        for (i, word) in input[..2 * STORE_ROW].iter_mut().enumerate() {
            *word = i as f64;
        }
        let first = 2 * STORE_ROW;
        input[first..first + EQUIP_HEAD].copy_from_slice(&[
            1.0, 2.0, 3.0, -1.0, 2.0, 1.0, 4.0, 5.0, 6.0, 0.0, 0.0, 0.0, 0.0,
        ]);
        let items = first + EQUIP_HEAD;
        input[items..items + ITEM_ROW].copy_from_slice(&[
            0.0,
            1.0,
            7.0,
            f64::NAN,
            f64::NAN,
            9.0,
            9.0,
            1.0,
            0.0,
            6.0,
        ]);
        input[items + ITEM_ROW..items + 2 * ITEM_ROW].copy_from_slice(&EMPTY_ROW);
        let second = items + 2 * ITEM_ROW + 1;
        input[second..second + EQUIP_HEAD].copy_from_slice(&[
            f64::NAN,
            0.0,
            0.0,
            -1.0,
            -1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ]);
        players.load(2);
        assert_eq!(players.len(), 2);
        assert_eq!(players.rows[1].role, STORE_ROW as f64);
        assert_eq!(
            players.moved,
            vec![PLAYER_ROW as f64, (STORE_ROW + PLAYER_ROW) as f64]
        );
        assert_eq!(players.extra[0].respawn_at, (PLAYER_ROW + 1) as f64);
        assert_eq!(players.extra[1].key, (2 * STORE_ROW - 5) as f64);
        assert_eq!(players.extra[1].hook_key, (2 * STORE_ROW - 4) as f64);
        assert_eq!(players.extra[1].kills, (2 * STORE_ROW - 3) as f64);
        assert_eq!(players.extra[1].discovery, (2 * STORE_ROW - 1) as f64);
        assert!(players.heard.iter().all(Vec::is_empty));
        let q = &players.equip[0];
        assert_eq!(
            (q.selected, q.weapon, q.keys, q.charging),
            (1.0, 2.0, 3.0, -1.0)
        );
        assert_eq!(q.reserves, Some([4.0, 5.0, 6.0]));
        assert!(q.reload.is_none());
        let inventory = q.inventory.as_ref().expect("an inventory");
        assert_eq!(
            (
                inventory.len(),
                inventory[0].as_ref().map(|i| i.ammo),
                inventory[1].is_none()
            ),
            (2, Some(7.0), true)
        );
        assert!(players.equip[1].inventory.is_none());
        // The dump gives the upload back, tokens written 0.
        let dumped = players.dump().to_vec();
        assert_eq!(dumped.len(), words);
        assert_eq!(dumped[items + 2], 7.0);
    }
}
