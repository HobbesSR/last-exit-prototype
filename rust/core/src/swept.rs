//! The swept geometry query, ported from TypeScript bit for bit (#1229 stage 5d.1, docs/27 "The
//! state flip"): `segmentShapeDistance` (`shared/shape-queries.ts`), `firstContact` and
//! `geometryContact` (`shared/simulation/swept.ts`).
//!
//! The TypeScript keeps its callers until the flip, so the two copies are held equal by
//! `tests/swept-core.test.js` (docs/27 "Step 5b.2").
//!
//! - **Uploaded once per map:** the static shapes in physics-geometry order, each with a flag for
//!   whether shots see them, and every gate's closed shape in `map.gates` order.
//! - **Read live:** which gates are open, from the gate set's mask (`sight::GateSet::open`).
//! - **Order matters:** `first_contact` brackets each shape's bisection by the contact found
//!   before it, so shapes are met in the TypeScript's order: statics, closed gates, then extras.
//!   The grid only narrows the candidates; each is still tested by the same box test.
//! - **Polygon containment** is SAT.js 0.9's `pointInPolygon` (a one-micro-unit box tested against
//!   the polygon with `testPolygonPolygon`): the same expressions in the same order.
//!
//! The containment test is translated from SAT.js 0.9.0, Copyright 2012 - 2021 Jim Riecken
//! <jimr@jimr.ca>, released under the MIT License (https://github.com/jriecken/sat-js). The
//! licence's full text is in `THIRD-PARTY-NOTICES.txt` (docs/21.1).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use crate::collision::{Body, or_zero};
use crate::math::{hypot, js_max, js_min};
use crate::sight::GateSet;

const BISECTION_STEPS: usize = 26;

/// `shared/shape.ts`'s `Shape`.
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    Circle {
        x: f64,
        y: f64,
        r: f64,
    },
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
    Polygon {
        x: f64,
        y: f64,
        points: Vec<[f64; 2]>,
    },
}

impl Shape {
    /// `bounds` (`shared/shape.ts`) as `[x, y, w, h]`.
    pub fn bounds(&self) -> [f64; 4] {
        match self {
            Shape::Circle { x, y, r } => [x - r, y - r, r * 2.0, r * 2.0],
            Shape::Rect { x, y, w, h } => [*x, *y, *w, *h],
            Shape::Polygon { x, y, points } => {
                let (mut left, mut top, mut right, mut bottom) = (
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                );
                for p in points {
                    left = js_min(left, x + p[0]);
                    right = js_max(right, x + p[0]);
                    top = js_min(top, y + p[1]);
                    bottom = js_max(bottom, y + p[1]);
                }
                [left, top, right - left, bottom - top]
            }
        }
    }
}

/// Decode shape rows: `kind` (0 circle, 1 rect, 2 polygon), `x`, `y`, `a`, `b`, `n`, then `n` point
/// pairs. A circle's `a` is its radius, a rect's `a` and `b` its width and height.
pub fn shapes_from_rows(rows: &[f64]) -> Vec<Shape> {
    let mut shapes = Vec::new();
    let mut i = 0;
    while i + 6 <= rows.len() {
        let (kind, x, y, a, b, n) = (
            rows[i],
            rows[i + 1],
            rows[i + 2],
            rows[i + 3],
            rows[i + 4],
            rows[i + 5] as usize,
        );
        i += 6;
        shapes.push(if kind == 0.0 {
            Shape::Circle { x, y, r: a }
        } else if kind == 1.0 {
            Shape::Rect { x, y, w: a, h: b }
        } else {
            let points = rows[i..i + 2 * n].as_chunks::<2>().0.to_vec();
            Shape::Polygon { x, y, points }
        });
        i += 2 * n;
    }
    shapes
}

/// A shape with what the queries rebuild: SAT's polygon and the outline's edges.
struct Prepared<'a> {
    shape: &'a Shape,
    body: Option<Body>,
    edges: Vec<([f64; 2], [f64; 2])>,
}

impl<'a> Prepared<'a> {
    fn new(shape: &'a Shape) -> Prepared<'a> {
        let (body, outline): (Option<Body>, Vec<[f64; 2]>) = match shape {
            Shape::Circle { .. } => (None, Vec::new()),
            Shape::Rect { x, y, w, h } => (
                None,
                vec![[*x, *y], [x + w, *y], [x + w, y + h], [*x, y + h]],
            ),
            Shape::Polygon { x, y, points } => (
                Some(Body::polygon(*x, *y, points)),
                points.iter().map(|p| [x + p[0], y + p[1]]).collect(),
            ),
        };
        let len = outline.len();
        let edges = (0..len)
            .map(|i| (outline[i], outline[(i + 1) % len]))
            .collect();
        Prepared { shape, body, edges }
    }

    /// `contains` (`shared/shape-queries.ts`) for a rect or polygon.
    fn contains(&self, x: f64, y: f64) -> bool {
        match (self.shape, &self.body) {
            (Shape::Rect { x: sx, y: sy, w, h }, _) => {
                x >= *sx && x <= sx + w && y >= *sy && y <= sy + h
            }
            (Shape::Polygon { .. }, Some(body)) => point_in_polygon(or_zero(x), or_zero(y), body),
            _ => unreachable!("circles are measured analytically"),
        }
    }

    fn distance(&self, a: [f64; 2], b: [f64; 2]) -> f64 {
        if let Shape::Circle { x, y, r } = self.shape {
            return js_max(0.0, point_distance([*x, *y], a, b) - r);
        }
        if self.contains(a[0], a[1]) || self.contains(b[0], b[1]) {
            return 0.0;
        }
        let mut distance = f64::INFINITY;
        for &(c, d) in &self.edges {
            let (x, y) = (cross(a, b, c), cross(a, b, d));
            let (u, v) = (cross(c, d, a), cross(c, d, b));
            // Strict crossing; collinear contact is covered by the point distances.
            if ((x < 0.0 && y > 0.0) || (x > 0.0 && y < 0.0))
                && ((u < 0.0 && v > 0.0) || (u > 0.0 && v < 0.0))
            {
                return 0.0;
            }
            distance = js_min(
                js_min(
                    js_min(
                        js_min(distance, point_distance(a, c, d)),
                        point_distance(b, c, d),
                    ),
                    point_distance(c, a, b),
                ),
                point_distance(d, a, b),
            );
        }
        distance
    }
}

fn cross(p: [f64; 2], q: [f64; 2], r: [f64; 2]) -> f64 {
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
}

fn point_distance(p: [f64; 2], c: [f64; 2], d: [f64; 2]) -> f64 {
    let (dx, dy) = (d[0] - c[0], d[1] - c[1]);
    let n = dx * dx + dy * dy;
    // `n ? ... : 0`: zero and NaN are both falsy.
    let t = if n != 0.0 && !n.is_nan() {
        js_max(
            0.0,
            js_min(1.0, ((p[0] - c[0]) * dx + (p[1] - c[1]) * dy) / n),
        )
    } else {
        0.0
    };
    hypot(p[0] - c[0] - t * dx, p[1] - c[1] - t * dy)
}

/// SAT's `TEST_POINT`: a 0.000001 box at the origin as a polygon, built once.
fn test_point() -> &'static Body {
    static BODY: OnceLock<Body> = OnceLock::new();
    BODY.get_or_init(|| Body::rect(0.0, 0.0, 0.000001, 0.000001))
}

/// SAT's `pointInPolygon(p, poly)`: `testPolygonPolygon(TEST_POINT at p, poly, response)`, then the
/// response's `aInB`. Only `aInB` is read, so the overlap bookkeeping is left out.
fn point_in_polygon(px: f64, py: f64, poly: &Body) -> bool {
    let (
        Body::Polygon {
            points: a_points,
            normals: a_normals,
            ..
        },
        Body::Polygon {
            x: bx,
            y: by,
            points: b_points,
            normals: b_normals,
            ..
        },
    ) = (test_point(), poly)
    else {
        return false;
    };
    let mut a_in_b = true;
    let offset = [bx - px, by - py];
    for axis in a_normals.iter().chain(b_normals.iter()) {
        if is_separating_axis(offset, a_points, b_points, *axis, &mut a_in_b) {
            return false;
        }
    }
    a_in_b
}

/// SAT's `flattenPointsOn`.
fn flatten_points_on(points: &[[f64; 2]], normal: [f64; 2]) -> [f64; 2] {
    let (mut min, mut max) = (f64::MAX, -f64::MAX);
    for p in points {
        let dot = p[0] * normal[0] + p[1] * normal[1];
        if dot < min {
            min = dot;
        }
        if dot > max {
            max = dot;
        }
    }
    [min, max]
}

/// SAT's `isSeparatingAxis`, keeping the response's `aInB`.
fn is_separating_axis(
    offset: [f64; 2],
    a_points: &[[f64; 2]],
    b_points: &[[f64; 2]],
    axis: [f64; 2],
    a_in_b: &mut bool,
) -> bool {
    let projected = offset[0] * axis[0] + offset[1] * axis[1];
    let a = flatten_points_on(a_points, axis);
    let mut b = flatten_points_on(b_points, axis);
    b[0] += projected;
    b[1] += projected;
    if a[0] > b[1] || b[0] > a[1] {
        return true;
    }
    if a[0] < b[0] || a[1] > b[1] {
        *a_in_b = false;
    }
    false
}

/// `segmentShapeDistance` (`shared/shape-queries.ts`).
pub fn segment_shape_distance(a: [f64; 2], b: [f64; 2], shape: &Shape) -> f64 {
    Prepared::new(shape).distance(a, b)
}

/// `firstContact`: the first contact of a radius-`radius` point swept from `a` to `b` with any
/// shape, in the order given; infinity when clear.
pub fn first_contact<'a>(
    a: [f64; 2],
    b: [f64; 2],
    shapes: impl IntoIterator<Item = &'a Shape>,
    radius: f64,
) -> f64 {
    let left = js_min(a[0], b[0]) - radius;
    let right = js_max(a[0], b[0]) + radius;
    let top = js_min(a[1], b[1]) - radius;
    let bottom = js_max(a[1], b[1]) + radius;
    let mut first = f64::INFINITY;
    for shape in shapes {
        let [bx, by, bw, bh] = shape.bounds();
        if bx > right || by > bottom || bx + bw < left || by + bh < top {
            continue;
        }
        let prepared = Prepared::new(shape);
        if prepared.distance(a, b) > radius {
            continue;
        }
        if prepared.distance(a, a) <= radius {
            return 0.0;
        }
        let (mut lo, mut hi) = (0.0, if first < f64::INFINITY { first } else { 1.0 });
        // A prior collider may already be earlier than this one.
        let clipped = [a[0] + (b[0] - a[0]) * hi, a[1] + (b[1] - a[1]) * hi];
        if prepared.distance(a, clipped) > radius {
            continue;
        }
        for _ in 0..BISECTION_STEPS {
            let mid = (lo + hi) / 2.0;
            let end = [a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid];
            if prepared.distance(a, end) <= radius {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        first = js_min(first, lo);
    }
    first
}

/// `BUCKET` in `shared/buckets.ts`.
const CELL: f64 = 200.0;
/// A shape covering more cells than this, or a query box that does, skips the grid.
const MAX_CELLS: f64 = 4096.0;

/// Shapes in a uniform grid. A shape with a box the grid cannot hold goes in `always`.
struct Grid {
    cells: BTreeMap<(i64, i64), Vec<u32>>,
    always: Vec<u32>,
    count: usize,
}

/// The cells `[left, right] x [top, bottom]` covers, or `None` when it is not finite or too big.
fn cell_range(left: f64, top: f64, right: f64, bottom: f64) -> Option<(i64, i64, i64, i64)> {
    if !(left.is_finite() && top.is_finite() && right.is_finite() && bottom.is_finite()) {
        return None;
    }
    let (c0, c1) = ((left / CELL).floor(), (right / CELL).floor());
    let (r0, r1) = ((top / CELL).floor(), (bottom / CELL).floor());
    if c0.abs() > 1e9 || c1.abs() > 1e9 || r0.abs() > 1e9 || r1.abs() > 1e9 {
        return None;
    }
    if (c1 - c0 + 1.0) * (r1 - r0 + 1.0) > MAX_CELLS {
        return None;
    }
    Some((c0 as i64, c1 as i64, r0 as i64, r1 as i64))
}

impl Grid {
    fn new(shapes: &[Shape]) -> Grid {
        let mut grid = Grid {
            cells: BTreeMap::new(),
            always: Vec::new(),
            count: shapes.len(),
        };
        for (i, shape) in shapes.iter().enumerate() {
            let [x, y, w, h] = shape.bounds();
            match cell_range(x, y, x + w, y + h) {
                Some((c0, c1, r0, r1)) => {
                    for c in c0..=c1 {
                        for r in r0..=r1 {
                            grid.cells.entry((c, r)).or_default().push(i as u32);
                        }
                    }
                }
                None => grid.always.push(i as u32),
            }
        }
        grid
    }

    /// Indices of every shape whose box may meet the query box, ascending and once each. A superset
    /// of those that do: `first_contact`'s own box test decides.
    fn candidates(&self, left: f64, top: f64, right: f64, bottom: f64) -> Vec<u32> {
        let Some((c0, c1, r0, r1)) = cell_range(left, top, right, bottom) else {
            return (0..self.count as u32).collect();
        };
        let mut found: Vec<u32> = self.always.clone();
        for c in c0..=c1 {
            for r in r0..=r1 {
                if let Some(list) = self.cells.get(&(c, r)) {
                    found.extend_from_slice(list);
                }
            }
        }
        found.sort_unstable();
        found.dedup();
        found
    }
}

/// A map's sweep geometry, uploaded once (`staticIndex` and `gateIndex` in `shared/simulation/swept.ts`).
pub struct SweptMap {
    statics: Vec<Shape>,
    /// False for a see-through static, which shots pass.
    shots: Vec<bool>,
    gates: Vec<Shape>,
    static_grid: Grid,
    gate_grid: Grid,
}

impl SweptMap {
    pub fn new(statics: Vec<Shape>, shots: Vec<bool>, gates: Vec<Shape>) -> SweptMap {
        assert_eq!(statics.len(), shots.len());
        SweptMap {
            static_grid: Grid::new(&statics),
            gate_grid: Grid::new(&gates),
            statics,
            shots,
            gates,
        }
    }

    /// `geometryContact`: the first contact with the static shapes under the policy, then the closed
    /// gates (`gates.open` is per gate list index), then `extra`.
    pub fn contact(
        &self,
        gates: &GateSet,
        pass_see_through: bool,
        a: [f64; 2],
        b: [f64; 2],
        radius: f64,
        extra: &[Shape],
    ) -> f64 {
        let left = js_min(a[0], b[0]) - radius;
        let right = js_max(a[0], b[0]) + radius;
        let top = js_min(a[1], b[1]) - radius;
        let bottom = js_max(a[1], b[1]) + radius;
        let static_ids = self.static_grid.candidates(left, top, right, bottom);
        let gate_ids = self.gate_grid.candidates(left, top, right, bottom);
        let mut shapes: Vec<&Shape> =
            Vec::with_capacity(static_ids.len() + gate_ids.len() + extra.len());
        for &i in &static_ids {
            if !pass_see_through || self.shots[i as usize] {
                shapes.push(&self.statics[i as usize]);
            }
        }
        for &i in &gate_ids {
            if gates.open.get(i as usize).copied().unwrap_or(0) == 0 {
                shapes.push(&self.gates[i as usize]);
            }
        }
        shapes.extend(extra);
        first_contact(a, b, shapes, radius)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sweep_stops_before_the_first_shape_in_its_way() {
        let wall = Shape::Rect {
            x: 100.0,
            y: -50.0,
            w: 20.0,
            h: 100.0,
        };
        let t = first_contact([0.0, 0.0], [200.0, 0.0], [&wall], 10.0);
        assert!(t > 0.44 && t < 0.451, "{t}");
        assert_eq!(
            first_contact([0.0, 0.0], [50.0, 0.0], [&wall], 10.0),
            f64::INFINITY
        );
        assert_eq!(
            first_contact([110.0, 0.0], [200.0, 0.0], [&wall], 10.0),
            0.0
        );
    }

    #[test]
    fn a_polygon_contains_its_inside_and_not_its_outside() {
        let tri = Shape::Polygon {
            x: 10.0,
            y: 10.0,
            points: vec![[0.0, 0.0], [0.0, 0.0], [40.0, 0.0], [0.0, 40.0]],
        };
        assert_eq!(
            segment_shape_distance([20.0, 20.0], [20.0, 20.0], &tri),
            0.0
        );
        assert!(segment_shape_distance([45.0, 45.0], [45.0, 45.0], &tri) > 0.0);
    }

    #[test]
    fn rows_decode_each_kind() {
        let rows = [
            0.0, 1.0, 2.0, 3.0, 0.0, 0.0, 1.0, 1.0, 2.0, 3.0, 4.0, 0.0, 2.0, 5.0, 6.0, 0.0, 0.0,
            2.0, 1.0, 2.0, 3.0, 4.0,
        ];
        let shapes = shapes_from_rows(&rows);
        assert_eq!(shapes.len(), 3);
        assert_eq!(
            shapes[2],
            Shape::Polygon {
                x: 5.0,
                y: 6.0,
                points: vec![[1.0, 2.0], [3.0, 4.0]]
            }
        );
    }
}
