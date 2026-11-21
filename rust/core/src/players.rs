//! The game's players as the core keeps them (#1214, docs/27 "The state flip", step 6c).
//!
//! One store per world, in roster order, that the converted runs read and write in place of rows of their own: phase
//! 5's combat (`combat.rs`) and phase 6's environment and traps (`hazards.rs`), which share `combat::Row`. The other
//! phases still pack their own rows from JavaScript's records, so until the last of them converts the adapter uploads
//! the store from those records before each converted call (`shared/simulation/player-store.ts`). A converted run
//! leaves its writes in the store, and reports them to the records, the mirror, as before.
use crate::combat::{PLAYER_ROW, Row};

/// Words per player uploaded: `combat::Row` (`PLAYER_ROW` words), then `movedThisTick` (0 when unset).
pub const STORE_ROW: usize = PLAYER_ROW + 1;

#[derive(Default)]
pub struct Players {
    /// Each player's fields, in roster order.
    pub(crate) rows: Vec<Row>,
    /// Each player's `movedThisTick`, in roster order.
    pub(crate) moved: Vec<f64>,
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
        for row in self.input.as_chunks::<STORE_ROW>().0 {
            self.rows.push(Row::read(&row[..PLAYER_ROW]));
            self.moved.push(row[PLAYER_ROW]);
        }
    }

    /// The players' rows, taken for a run, which gives them back with `restore`.
    pub(crate) fn take(&mut self, count: usize) -> Vec<Row> {
        assert_eq!(self.rows.len(), count, "the store holds the roster");
        std::mem::take(&mut self.rows)
    }

    pub(crate) fn restore(&mut self, rows: Vec<Row>) {
        self.rows = rows;
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
        assert_eq!(players.rows.len(), 2);
        assert_eq!(players.rows[1].role, STORE_ROW as f64);
        assert_eq!(
            players.moved,
            vec![PLAYER_ROW as f64, (2 * STORE_ROW - 1) as f64]
        );
        let rows = players.take(2);
        assert!(players.rows.is_empty());
        players.restore(rows);
        assert_eq!(players.rows.len(), 2);
    }
}
