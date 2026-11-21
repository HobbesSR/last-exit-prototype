//! The game's players as the core keeps them (#1214, docs/27 "The state flip", step 6c).
//!
//! One store per world, in roster order, that the converted runs read and write in place of rows of their own: phase
//! 5's combat (`combat.rs`) and phase 6's environment and traps (`hazards.rs`), which share `combat::Row`, and phase 1
//! (`phase_one.rs`), which also reads `Extra`. The other phases still pack their own rows from JavaScript's records,
//! so until the last of them converts the adapter uploads the store from those records before each converted call
//! (`shared/simulation/player-store.ts`). A converted run leaves its writes in the store, and reports them to the
//! records, the mirror, as before.
use crate::combat::{PLAYER_ROW, Row};
use crate::math::hypot;
use crate::physics::SUBSTEPS;
use crate::world::STEP_HEADER;

/// Words of `Extra` uploaded: respawnAt, transit arriveAt, the transit's destination station index (-1 none), railCd,
/// cloak, revealed, boost, and the actor's world key (`actor:<id>`). An absent field is NaN.
pub const EXTRA_ROW: usize = 8;
/// Words per player uploaded: `combat::Row` (`PLAYER_ROW` words), `movedThisTick` (0 when unset), then `Extra`.
pub const STORE_ROW: usize = PLAYER_ROW + 1 + EXTRA_ROW;

/// The fields phase 1 reads beyond `combat::Row`.
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
}

#[derive(Default)]
pub struct Players {
    /// Each player's fields, in roster order.
    pub(crate) rows: Vec<Row>,
    /// Each player's `movedThisTick`, in roster order.
    pub(crate) moved: Vec<f64>,
    /// Each player's further fields, in roster order.
    pub(crate) extra: Vec<Extra>,
    input: Vec<f64>,
}

impl Players {
    /// The upload buffer, resized for `count` players.
    pub fn input(&mut self, count: usize) -> &mut [f64] {
        self.input.resize(count * STORE_ROW, 0.0);
        &mut self.input
    }

    /// Replace the store with the uploaded rows.
    pub fn load(&mut self, count: usize) {
        assert_eq!(
            self.input.len(),
            count * STORE_ROW,
            "the upload holds every player"
        );
        self.rows.clear();
        self.moved.clear();
        self.extra.clear();
        for row in self.input.as_chunks::<STORE_ROW>().0 {
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
            ]);
        }
        self.input = words;
        &self.input
    }

    /// How many players the store holds.
    pub fn len(&self) -> usize {
        self.extra.len()
    }

    /// Whether the store holds no players.
    pub fn is_empty(&self) -> bool {
        self.extra.is_empty()
    }

    /// The players' rows, taken for a run, which gives them back with `restore`.
    pub(crate) fn take(&mut self, count: usize) -> Vec<Row> {
        assert_eq!(self.rows.len(), count, "the store holds the roster");
        std::mem::take(&mut self.rows)
    }

    pub(crate) fn restore(&mut self, rows: Vec<Row>) {
        self.rows = rows;
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

    /// Phase 6's per-actor loop's writes to the store's fields, read from its output (`phase_six.rs`) in the order
    /// `shared/simulation/phase-six.ts` applies them: an extraction's status, a delayed transit's status, arrival and
    /// destination, an instant transit's landing and rail cooldown, and a sensor's reveal.
    pub(crate) fn apply_interactions(&mut self, out: &[f64]) {
        const OUT_HEADER: usize = 11;
        let mut at = OUT_HEADER + out[7] as usize * 2;
        let end = at + out[8] as usize;
        while at < end {
            let (op, len) = (out[at], out[at + 1] as usize);
            let p = &out[at + 2..at + 2 + len];
            let i = p.first().map_or(usize::MAX, |&i| i as usize);
            if let (Some(r), Some(e)) = (self.rows.get_mut(i), self.extra.get_mut(i)) {
                match op as u32 {
                    2 => r.status = 3.0,
                    6 => {
                        r.status = 5.0;
                        e.destination = p[1];
                        e.arrive_at = p[2];
                    }
                    7 => {
                        r.x = p[1];
                        r.y = p[2];
                        e.rail_cd = p[3];
                    }
                    16 => e.revealed = p[1],
                    _ => {}
                }
            }
            at += 2 + len;
        }
    }

    /// Phase 3's writes to the store's fields, read from its output (`phase_three.rs`) in the order
    /// `shared/simulation/phase-three.ts` applies them: each written player row when the mode writes rows (the loop, a
    /// scenario attack or an elimination), then the log's reveal, elimination and kill-credit facts.
    pub(crate) fn apply_actions(&mut self, mode: f64, out: &[f64]) {
        const OUT_HEADER: usize = 13;
        const ROW: usize = 24;
        const ITEM_ROW: usize = 10;
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
            if reserves != 0.0 {
                at += 3;
            }
            if reload != 0.0 {
                at += 3;
            }
            if inventory >= 0.0 {
                at += inventory as usize * ITEM_ROW;
            }
            at += retired as usize * ITEM_ROW;
        }
        at += out[8] as usize * 2;
        let end = at + out[9] as usize;
        while at < end {
            let (op, len) = (out[at], out[at + 1] as usize);
            let p = &out[at + 2..at + 2 + len];
            let i = p.first().map_or(usize::MAX, |&i| i as usize);
            match op as u32 {
                11 => {
                    if let Some(e) = self.extra.get_mut(i) {
                        e.revealed = p[1];
                    }
                }
                12 => {
                    if let (Some(r), Some(e)) = (self.rows.get_mut(i), self.extra.get_mut(i)) {
                        r.status = if p[3].is_nan() { 1.0 } else { 2.0 };
                        if !p[3].is_nan() {
                            e.respawn_at = p[3];
                        }
                    }
                }
                13 => {
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
        let input = players.input(2);
        for (i, word) in input.iter_mut().enumerate() {
            *word = i as f64;
        }
        players.load(2);
        assert_eq!(players.len(), 2);
        assert_eq!(players.rows[1].role, STORE_ROW as f64);
        assert_eq!(
            players.moved,
            vec![PLAYER_ROW as f64, (STORE_ROW + PLAYER_ROW) as f64]
        );
        assert_eq!(players.extra[0].respawn_at, (PLAYER_ROW + 1) as f64);
        assert_eq!(players.extra[1].key, (2 * STORE_ROW - 1) as f64);
        let rows = players.take(2);
        assert!(players.rows.is_empty());
        players.restore(rows);
        assert_eq!(players.rows.len(), 2);
    }
}
