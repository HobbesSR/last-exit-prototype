//! The drop planner's spiral search (`scatterPoint` in `shared/simulation/loot.ts`, #1228 stage 1,
//! docs/27 "The state flip", step 5c.1): where a dropped record lands near its dropper.
//!
//! A spot is free when a disk of 16 at it is on the map and clear of obstacles and closed gates
//! (`can_occupy`), the dropper can reach it (`reach_clear`), it is more than 32 from every listed
//! record and earlier spot of the same drop, and a loot body would fit there: no solid prop meets
//! the loot disk and no active actor's disk does, the test the body sync's item admission makes in
//! `boundary.rs` (it was `physicalDropPlacementClear` in TypeScript). They are tested in that order,
//! as the TypeScript's `&&` tested them, so the prop query runs only where the rest passed.
//!
//! The spiral is 180 spots: spot `j` is at angle `(phase + j) * 2.39996` and radius
//! `36 + floor(j / 12) * 24`, so the farthest is 372 from the origin. JavaScript packs only the
//! records within reach of the spiral (`scatterInCore` in `shared/simulation/boundary.ts`).

use crate::collision::{CollisionMap, can_occupy, reach_clear};
use crate::math::{cos, hypot, sin};
use crate::placement::Disk;
use crate::sight::{GateSet, SightIndex};
use crate::world::World;

/// Spots in the spiral.
pub const SPOTS: u32 = 180;
/// The farthest spot from the origin, `36 + floor(179 / 12) * 24`.
pub const FARTHEST: f64 = 372.0;
/// A spot's distance from listed records and earlier spots must exceed this.
pub const SPACING: f64 = 32.0;
/// The disk tested against the map.
const MAP_RADIUS: f64 = 16.0;

/// The first free spot of the spiral from `origin` at `phase`, or `None`. `taken` is the records
/// near the origin and the drop's earlier spots, `x, y` each; `actors` the active actors' disks.
#[allow(clippy::too_many_arguments)]
pub fn scatter_point(
    world: &mut World,
    map: &mut CollisionMap,
    index: &SightIndex,
    gates: &mut GateSet,
    origin: (f64, f64),
    phase: f64,
    loot_radius: f64,
    actors: &[Disk],
    taken: &[[f64; 2]],
) -> Option<(f64, f64)> {
    for j in 0..SPOTS {
        // As `(phase + j) * 2.39996` and `origin.x + cos(angle) * radius` evaluate, left to right.
        let angle = (phase + f64::from(j)) * 2.39996;
        let radius = 36.0 + f64::from(j / 12) * 24.0;
        let (x, y) = (
            origin.0 + cos(angle) * radius,
            origin.1 + sin(angle) * radius,
        );
        if can_occupy(map, gates, x, y, MAP_RADIUS, false, false)
            && reach_clear(index, gates, origin, (x, y)).0
            && taken.iter().all(|t| hypot(t[0] - x, t[1] - y) > SPACING)
            && !world.overlaps_prop(loot_radius, x, y)
            && actors
                .iter()
                .all(|d| hypot(x - d[0], y - d[1]) >= loot_radius + d[2])
        {
            return Some((x, y));
        }
    }
    None
}
