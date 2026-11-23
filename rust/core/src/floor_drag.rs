//! Floor drag, phase 4's rule before the solve (docs/27 "The state flip", step 5, #1226): a loose
//! prop's or loot's damping is its profile's, scaled by the drag of the floor it stands on.
//!
//! It was `applyFloorDrag` in `shared/simulation/world-physics.ts`. The surfaces arrive once per
//! world, already in the motor's order (priority descending, then ID), and the first surface
//! containing the body's position decides; a surface without a drag of its own scales by 1, as
//! `?.drag ?? 1` did, without falling through to the next. The containment test is half-open,
//! `x <= p < x + w`, in the same `f64` arithmetic.

use crate::swept::Grid;

/// What a body's damping follows: nothing (actors, statics), the loot profile or the prop profile.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    None,
    Loot,
    Prop,
}

/// Values per surface row: `x, y, w, h, drag` (drag 1 when the surface sets none).
pub const SURFACE_STRIDE: usize = 5;

/// One world's floors and the two damping profiles, as `[linear, angular]`.
pub struct Floor {
    surfaces: Vec<[f64; SURFACE_STRIDE]>,
    loot: [f64; 2],
    prop: [f64; 2],
    index: Option<Grid>,
}

impl Floor {
    /// From the adapter's buffer: loot linear, loot angular, prop linear, prop angular, then the
    /// surface rows in the motor's order.
    pub fn from_input(input: &[f64]) -> Self {
        let (bases, rows) = input.split_at(4);
        Self {
            surfaces: rows.as_chunks::<SURFACE_STRIDE>().0.to_vec(),
            loot: [bases[0], bases[1]],
            prop: [bases[2], bases[3]],
            index: None,
        }
    }

    pub(crate) fn indexed(mut self) -> Self {
        self.index = Some(Grid::for_bounds(
            self.surfaces.iter().map(|&[x, y, w, h, _]| [x, y, w, h]),
        ));
        self
    }

    fn drag_at(&self, x: f64, y: f64) -> f64 {
        let contains = |f: &&[f64; SURFACE_STRIDE]| {
            x >= f[0] && x < f[0] + f[2] && y >= f[1] && y < f[1] + f[3]
        };
        let surface = if let Some(index) = &self.index {
            index
                .at(x, y)
                .into_iter()
                .map(|i| &self.surfaces[i as usize])
                .find(contains)
        } else {
            self.surfaces.iter().find(contains)
        };
        surface.map_or(1.0, |f| f[4])
    }

    /// The damping a body of `class` at `(x, y)` should have, or `None` when its class has none.
    pub fn damping(&self, class: Class, x: f64, y: f64) -> Option<[f64; 2]> {
        let base = match class {
            Class::None => return None,
            Class::Loot => self.loot,
            Class::Prop => self.prop,
        };
        let drag = self.drag_at(x, y);
        Some([base[0] * drag, base[1] * drag])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn floor() -> Floor {
        Floor::from_input(&[
            2.0, 3.0, 5.0, 7.0, // loot, prop
            0.0, 0.0, 10.0, 10.0, 0.5, // first in the motor's order wins
            0.0, 0.0, 100.0, 100.0, 0.25, //
            50.0, 50.0, 10.0, 10.0, 1.0, // no drag of its own: scales by 1
        ])
    }

    #[test]
    fn the_first_containing_surface_decides() {
        let floor = floor();
        assert_eq!(floor.damping(Class::Loot, 5.0, 5.0), Some([1.0, 1.5]));
        assert_eq!(floor.damping(Class::Prop, 20.0, 5.0), Some([1.25, 1.75]));
        assert_eq!(floor.damping(Class::Prop, 200.0, 5.0), Some([5.0, 7.0]));
        assert_eq!(floor.damping(Class::None, 5.0, 5.0), None);
    }

    #[test]
    fn containment_is_half_open() {
        let floor = floor();
        assert_eq!(floor.damping(Class::Loot, 10.0, 5.0), Some([0.5, 0.75]));
        assert_eq!(floor.damping(Class::Loot, 0.0, 0.0), Some([1.0, 1.5]));
    }
}
