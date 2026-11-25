//! The movement sweep used for bot steering, with the caller's door observations.
use crate::{
    collision::CollisionMap,
    sight::GateSet,
    swept::{Shape, segment_shape_distance},
    tick::Point,
};

pub(super) fn clear(
    map: Option<&CollisionMap>,
    gates: &GateSet,
    a: Point,
    b: Point,
    radius: f64,
    open: impl Fn(usize) -> bool,
) -> bool {
    if map.is_some_and(|map| !map.segment_clear(a, b, radius)) {
        return false;
    }
    let left = a[0].min(b[0]) - radius;
    let right = a[0].max(b[0]) + radius;
    let top = a[1].min(b[1]) - radius;
    let bottom = a[1].max(b[1]) + radius;
    let mut blocked = false;
    gates
        .grid
        .each_cell_in(left, top, right, bottom, |entries| {
            if blocked {
                return;
            }
            for &slot in entries {
                let slot = slot as usize;
                if open(slot) {
                    continue;
                }
                let [x, y, w, h] = gates.boxes[slot];
                if x <= right
                    && y <= bottom
                    && x + w >= left
                    && y + h >= top
                    && segment_shape_distance(a, b, &Shape::Rect { x, y, w, h }) < radius
                {
                    blocked = true;
                    break;
                }
            }
        });
    !blocked
}
