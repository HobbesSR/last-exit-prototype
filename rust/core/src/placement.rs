//! The physics placement search (`placement` in `shared/simulation/game.ts`, #1234, docs/27 "The state
//! flip", step 5b.3). Every caller shares it: the body sync places actors with it, phase 1 lands a
//! transit with it, and phase 6's instant transit asks it through `physics_placement`.
//!
//! A spot is free when the disk is clear of the map (`can_occupy`, with the gates as the mask says),
//! of every admitted actor's disk, and of every solid prop in the world, tested in that order, as
//! the TypeScript's `&&` tested them. The origin is tried first, then 24 rings of 32 spots, 4 units
//! apart, from angle 0 counterclockwise.

use crate::collision::{CollisionMap, can_occupy};
use crate::math::{cos, hypot, sin};
use crate::sight::GateSet;
use crate::world::World;
use std::f64::consts::PI;

/// An admitted actor's disk: `x, y, radius`.
pub type Disk = [f64; 3];

/// Where a disk of `radius` may be placed nearest `origin`, or `None` when no spot is free.
/// `admitted` is read as it stands, so a caller placing several actors passes those it has placed.
pub fn placement(
    world: &mut World,
    map: &mut CollisionMap,
    gates: &mut GateSet,
    radius: f64,
    origin: (f64, f64),
    admitted: &[Disk],
) -> Option<(f64, f64)> {
    let mut free = |x: f64, y: f64| {
        can_occupy(map, gates, x, y, radius, false, false)
            && admitted
                .iter()
                .all(|q| hypot(x - q[0], y - q[1]) >= radius + q[2])
            && !world.overlaps_prop(radius, x, y)
    };
    if free(origin.0, origin.1) {
        return Some(origin);
    }
    for ring in 1..=24 {
        let ring = f64::from(ring);
        for i in 0..32 {
            // As `i * Math.PI / 16` and `origin.x + cos(angle) * ring * 4` evaluate, left to right.
            let angle = f64::from(i) * PI / 16.0;
            let x = origin.0 + cos(angle) * ring * 4.0;
            let y = origin.1 + sin(angle) * ring * 4.0;
            if free(x, y) {
                return Some((x, y));
            }
        }
    }
    None
}
