//! Knowledge-gated navigation over the room's validated flat tiles (22.6.2).

mod diagnostics;
mod geometry;
pub(crate) mod portal;
mod search;

pub use search::{Knowledge, ROUTE_BUDGET, Route, RouteSearch, RouteStatus};

use crate::runtime_map::Tile;

#[derive(Clone, Copy)]
pub(crate) struct Grid {
    pub width: f64,
    pub height: f64,
    pub size: f64,
    pub cols: usize,
    pub rows: usize,
}

impl Grid {
    fn cell_at(self, [x, y]: [f64; 2]) -> Option<usize> {
        (x >= 0.0 && y >= 0.0 && x < self.width && y < self.height).then(|| {
            (y / self.size).floor() as usize * self.cols + (x / self.size).floor() as usize
        })
    }

    fn bounds(self, cell: usize) -> [f64; 4] {
        let x = (cell % self.cols) as f64 * self.size;
        let y = (cell / self.cols) as f64 * self.size;
        [
            x,
            y,
            self.size.min(self.width - x),
            self.size.min(self.height - y),
        ]
    }

    /// Support depends only on public dimensions and the body clearance.
    fn support(self, cell: usize, clearance: f64) -> impl Iterator<Item = usize> {
        let reach = clearance + 0.2 + 1.0; // tileReach, shared/free-space.ts
        let [x, y, w, h] = self.bounds(cell);
        let first_col = ((x - reach) / self.size).floor() as usize;
        let last_col = (((x + w + reach) / self.size).floor() as usize).min(self.cols - 1);
        let first_row = ((y - reach) / self.size).floor() as usize;
        let last_row = (((y + h + reach) / self.size).floor() as usize).min(self.rows - 1);
        (first_row..=last_row)
            .flat_map(move |row| (first_col..=last_col).map(move |col| row * self.cols + col))
    }

    fn neighbour(self, cell: usize, side: usize) -> Option<usize> {
        let (col, row) = (cell % self.cols, cell / self.cols);
        match side {
            0 if col > 0 => Some(cell - 1),
            1 if row > 0 => Some(cell - self.cols),
            2 if col + 1 < self.cols => Some(cell + 1),
            3 if row + 1 < self.rows => Some(cell + self.cols),
            _ => None,
        }
    }
}

fn side_edges(tile: &Tile<'_>, bounds: [f64; 4]) -> [Vec<usize>; 4] {
    let mut sides = [const { Vec::new() }; 4];
    for slot in 0..tile.twins.len() {
        if tile.twins.i32(slot) < 0
            && let Some(side) = geometry::side_of(bounds, geometry::edge(tile, slot))
        {
            sides[side].push(slot);
        }
    }
    sides
}
