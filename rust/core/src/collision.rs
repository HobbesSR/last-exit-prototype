//! The map's collision queries, ported from TypeScript bit for bit (#1233, docs/27 step 5b.2):
//! `canOccupy` (`shared/movement.ts`, with `insideMap` from `shared/playable-area.ts`), and
//! `lineClear` and `reachClear` (`shared/sight.ts`).
//!
//! The TypeScript keeps its other callers (movement, bots, tools), so the two copies are held
//! equal by `tests/collision-core.test.js`, as the roof rule is (docs/27 "Step 2"). Giving each
//! one owner again is #1215 and #1222.
//!
//! - **Uploaded once per map:** the playable cells and the colliders (`CollisionMap`); the sight
//!   index (`SightIndex`, with its see-through edges) and the gate set (`GateSet`, with each
//!   gate's box) are sight's handles, shared.
//! - **Read live:** which gates are open, from the gate set's mask, which the adapter writes
//!   before each call.
//! - **Disk tests** are SAT.js 0.9's (`testCircleCircle`, `testCirclePolygon`), which
//!   `shared/shape-queries.ts` calls: the same expressions in the same order, including its
//!   `x || 0` on constructed vectors and its merging of consecutive duplicate points.
//!
//! The disk tests are translated from SAT.js 0.9.0, Copyright 2012 - 2021 Jim Riecken
//! <jimr@jimr.ca>, released under the MIT License (https://github.com/jriecken/sat-js). The
//! licence's full text is in `THIRD-PARTY-NOTICES.txt` (docs/21.1).

use crate::math::{hypot, js_max, js_min};
use crate::sight::{BUCKET, Edge, GateSet, Grid, SightIndex, Visited, hit_ray};

/// SAT's `new Vector(x, y)` stores `x || 0`: -0 and NaN become 0.
pub(crate) fn or_zero(v: f64) -> f64 {
    if v == 0.0 || v.is_nan() { 0.0 } else { v }
}

/// A shape readied for disk tests: SAT's `Circle`, or its `Polygon` with the calculated points
/// and edges (`_recalc`, at angle 0 and offset 0).
pub(crate) enum Body {
    Circle {
        x: f64,
        y: f64,
        r: f64,
    },
    Polygon {
        x: f64,
        y: f64,
        points: Vec<[f64; 2]>,
        edges: Vec<[f64; 2]>,
        /// SAT's `normals`: each edge turned by `perp` then `normalize`.
        normals: Vec<[f64; 2]>,
    },
}

impl Body {
    /// `new SAT.Circle(new SAT.Vector(x, y), r)`.
    pub(crate) fn circle(x: f64, y: f64, r: f64) -> Body {
        Body::Circle {
            x: or_zero(x),
            y: or_zero(y),
            r: or_zero(r),
        }
    }

    /// `new SAT.Box(new SAT.Vector(x, y), w, h).toPolygon()`.
    pub(crate) fn rect(x: f64, y: f64, w: f64, h: f64) -> Body {
        let (w, h) = (or_zero(w), or_zero(h));
        Body::polygon(x, y, &[[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]])
    }

    /// `new SAT.Polygon(new SAT.Vector(x, y), points.map(p => new SAT.Vector(p.x, p.y)))`.
    pub(crate) fn polygon(x: f64, y: f64, points: &[[f64; 2]]) -> Body {
        let mut points: Vec<[f64; 2]> = points
            .iter()
            .map(|p| [or_zero(p[0]), or_zero(p[1])])
            .collect();
        // `setPoints` drops a point equal to the next, the last compared with the first; a lone
        // point is the same object as its next and stays.
        let mut i = 0;
        while i < points.len() {
            let next = if i < points.len() - 1 { i + 1 } else { 0 };
            if next != i && points[i] == points[next] {
                points.remove(i);
                continue;
            }
            i += 1;
        }
        // `_recalc`: each calculated point is the point plus the zero offset.
        let points: Vec<[f64; 2]> = points.iter().map(|p| [p[0] + 0.0, p[1] + 0.0]).collect();
        let len = points.len();
        let edges = (0..len)
            .map(|i| {
                let (p1, p2) = (points[i], points[if i < len - 1 { i + 1 } else { 0 }]);
                [p2[0] - p1[0], p2[1] - p1[1]]
            })
            .collect::<Vec<[f64; 2]>>();
        let normals = edges
            .iter()
            .map(|e| {
                let (mut nx, mut ny) = (e[1], -e[0]);
                let d = (nx * nx + ny * ny).sqrt();
                if d > 0.0 {
                    (nx, ny) = (nx / d, ny / d);
                }
                [nx, ny]
            })
            .collect();
        Body::Polygon {
            x: or_zero(x),
            y: or_zero(y),
            points,
            edges,
            normals,
        }
    }
}

const LEFT: i32 = -1;
const MIDDLE: i32 = 0;
const RIGHT: i32 = 1;

/// SAT's `voronoiRegion(line, point)`.
fn voronoi_region(line: [f64; 2], px: f64, py: f64) -> i32 {
    let len2 = line[0] * line[0] + line[1] * line[1];
    let dp = px * line[0] + py * line[1];
    if dp < 0.0 {
        LEFT
    } else if dp > len2 {
        RIGHT
    } else {
        MIDDLE
    }
}

/// `diskPenetration` (`shared/shape-queries.ts`): whether a disk of `radius` at `x`, `y` touches the
/// body, contact counting, and if so the response's `overlap`, its depth.
pub(crate) fn disk_penetration(x: f64, y: f64, radius: f64, body: &Body) -> Option<f64> {
    match body {
        Body::Circle { x: bx, y: by, r } => {
            // `testCircleCircle(disk, body)`: b's position plus its offset, less a's and a's offset.
            let dx = ((bx + 0.0) - x) - 0.0;
            let dy = ((by + 0.0) - y) - 0.0;
            let total = radius + r;
            let distance_sq = dx * dx + dy * dy;
            if distance_sq > total * total {
                return None;
            }
            Some(total - distance_sq.sqrt())
        }
        Body::Polygon {
            x: px,
            y: py,
            points,
            edges,
            ..
        } => {
            // `testPolygonCircle(polygon, disk)`, which `testCirclePolygon` runs; the depth is unchanged
            // by its swap.
            let (cx, cy) = ((x + 0.0) - px, (y + 0.0) - py);
            let len = points.len();
            let mut best = f64::MAX;
            for i in 0..len {
                let next = if i == len - 1 { 0 } else { i + 1 };
                let prev = if i == 0 { len - 1 } else { i - 1 };
                let (mut qx, mut qy) = (cx - points[i][0], cy - points[i][1]);
                let mut overlap = None;
                match voronoi_region(edges[i], qx, qy) {
                    LEFT => {
                        let (rx, ry) = (cx - points[prev][0], cy - points[prev][1]);
                        if voronoi_region(edges[prev], rx, ry) == RIGHT {
                            let dist = (qx * qx + qy * qy).sqrt();
                            if dist > radius {
                                return None;
                            }
                            overlap = Some(radius - dist);
                        }
                    }
                    RIGHT => {
                        (qx, qy) = (cx - points[next][0], cy - points[next][1]);
                        if voronoi_region(edges[next], qx, qy) == LEFT {
                            let dist = (qx * qx + qy * qy).sqrt();
                            if dist > radius {
                                return None;
                            }
                            overlap = Some(radius - dist);
                        }
                    }
                    _ => {
                        // The edge turned to its unit normal: `perp` then `normalize`.
                        let (mut nx, mut ny) = (edges[i][1], -edges[i][0]);
                        let d = (nx * nx + ny * ny).sqrt();
                        if d > 0.0 {
                            (nx, ny) = (nx / d, ny / d);
                        }
                        let dist = qx * nx + qy * ny;
                        if dist > 0.0 && dist.abs() > radius {
                            return None;
                        }
                        overlap = Some(radius - dist);
                    }
                }
                if let Some(overlap) = overlap
                    && overlap.abs() < best.abs()
                {
                    best = overlap;
                }
            }
            Some(best)
        }
    }
}

/// One obstacle as collision reads it: its bounds, whether sight passes it, and its body.
struct Collider {
    bounds: [f64; 4],
    see_through: bool,
    body: Body,
}

/// `nearBounds` (`shared/shape.ts`).
fn near_bounds(b: &[f64; 4], x: f64, y: f64, radius: f64) -> bool {
    x + radius >= b[0]
        && x - radius <= b[0] + b[2]
        && y + radius >= b[1]
        && y - radius <= b[1] + b[3]
}

/// A map's collision data, uploaded once (`collisionTables` in `shared/movement.ts`).
pub struct CollisionMap {
    width: f64,
    height: f64,
    cell_size: f64,
    cols: usize,
    rows: usize,
    /// One byte per playable-area cell, row-major, nonzero where the cell is playable ground.
    occupied: Vec<u8>,
    colliders: Vec<Collider>,
    grid: Grid,
    visited: Visited,
}

/// Collider kinds in the upload.
const RECT: f64 = 0.0;
const CIRCLE: f64 = 1.0;

impl CollisionMap {
    /// `constants` is `width, height, cellSize, cols, rows`; `occupied` has `cols * rows` bytes.
    /// Collider `i` is `colliders[offsets[i]..offsets[i + 1]]`: `kind, seeThrough, box x, y, w, h,
    /// x, y`, then `r` for a circle, `w, h` for a rect, or `n` and `n` points for a polygon.
    /// `grid` lists collider indices (`sight::Grid`).
    pub fn new(
        constants: &[f64],
        occupied: &[u8],
        colliders: &[f64],
        offsets: &[u32],
        grid: &[i32],
    ) -> CollisionMap {
        let colliders: Vec<Collider> = offsets
            .windows(2)
            .map(|w| {
                let c = &colliders[w[0] as usize..w[1] as usize];
                let body = if c[0] == CIRCLE {
                    Body::circle(c[6], c[7], c[8])
                } else if c[0] == RECT {
                    Body::rect(c[6], c[7], c[8], c[9])
                } else {
                    let points: Vec<[f64; 2]> =
                        c[9..9 + 2 * c[8] as usize].as_chunks::<2>().0.to_vec();
                    Body::polygon(c[6], c[7], &points)
                };
                Collider {
                    bounds: [c[2], c[3], c[4], c[5]],
                    see_through: c[1] != 0.0,
                    body,
                }
            })
            .collect();
        let visited = Visited::new(colliders.len());
        CollisionMap {
            width: constants[0],
            height: constants[1],
            cell_size: constants[2],
            cols: constants[3] as usize,
            rows: constants[4] as usize,
            occupied: occupied.to_vec(),
            colliders,
            grid: Grid::from_words(grid),
            visited,
        }
    }

    /// `occupiedCell` over the uploaded cells; a cell outside them is not playable.
    fn occupied(&self, col: f64, row: f64) -> bool {
        if !(col >= 0.0 && row >= 0.0 && col < self.cols as f64 && row < self.rows as f64) {
            return false;
        }
        self.occupied[row as usize * self.cols + col as usize] != 0
    }

    /// `insideMap`: whether a disk of `radius` at `x`, `y` lies wholly on playable ground.
    pub fn inside(&self, x: f64, y: f64, radius: f64) -> bool {
        let (width, height, size) = (self.width, self.height, self.cell_size);
        if !x.is_finite()
            || !y.is_finite()
            || !radius.is_finite()
            || radius < 0.0
            || x - radius < 0.0
            || y - radius < 0.0
            || x + radius > width
            || y + radius > height
            || x >= width
            || y >= height
        {
            return false;
        }
        if radius == 0.0 {
            return self.occupied((x / size).floor(), (y / size).floor());
        }
        let left = js_max(0.0, ((x - radius) / size).floor());
        let right = js_min((width / size).ceil() - 1.0, ((x + radius) / size).floor());
        let top = js_max(0.0, ((y - radius) / size).floor());
        let bottom = js_min((height / size).ceil() - 1.0, ((y + radius) / size).floor());
        let mut row = top;
        while row <= bottom {
            let mut col = left;
            while col <= right {
                if !self.occupied(col, row) {
                    let near_x = js_max(col * size, js_min((col + 1.0) * size, x));
                    let near_y = js_max(row * size, js_min((row + 1.0) * size, y));
                    let (ex, ey) = (x - near_x, y - near_y);
                    if ex * ex + ey * ey < radius * radius {
                        return false;
                    }
                }
                col += 1.0;
            }
            row += 1.0;
        }
        true
    }

    /// A collider's disk test, for the parity check: its depth, or -1 when apart.
    pub fn depth(&self, i: usize, x: f64, y: f64, radius: f64) -> f64 {
        self.colliders
            .get(i)
            .and_then(|c| disk_penetration(x, y, radius, &c.body))
            .unwrap_or(-1.0)
    }
}

/// `canOccupy`: whether a disk of `radius` at `x`, `y` is on the map, clear of every obstacle by
/// more than 0.01 (see-through ones skipped for a projectile), and, unless `ignore_gates`, clear of
/// every closed gate, contact counting. The answer is one boolean, so the order the candidates are
/// met in cannot change it; they are found through the same cells all the same.
pub fn can_occupy(
    map: &mut CollisionMap,
    gates: &mut GateSet,
    x: f64,
    y: f64,
    radius: f64,
    ignore_gates: bool,
    projectile: bool,
) -> bool {
    if !map.inside(x, y, radius) {
        return false;
    }
    let (left, top, right, bottom) = (x - radius, y - radius, x + radius, y + radius);
    let mut blocked = false;
    map.visited.begin();
    let (colliders, visited) = (&map.colliders, &mut map.visited);
    map.grid.each_cell_in(left, top, right, bottom, |list| {
        if blocked {
            return;
        }
        for &i in list {
            let i = i as usize;
            if !visited.first(i) {
                continue;
            }
            let c = &colliders[i];
            if (projectile && c.see_through) || !near_bounds(&c.bounds, x, y, radius) {
                continue;
            }
            if disk_penetration(x, y, radius, &c.body).is_some_and(|depth| depth > 0.01) {
                blocked = true;
                return;
            }
        }
    });
    if blocked {
        return false;
    }
    if ignore_gates {
        return true;
    }
    gates.visited.begin();
    let (boxes, bodies, open, visited) =
        (&gates.boxes, &gates.bodies, &gates.open, &mut gates.visited);
    gates.grid.each_cell_in(left, top, right, bottom, |list| {
        if blocked {
            return;
        }
        for &i in list {
            let i = i as usize;
            if !visited.first(i) || open[i] != 0 || !near_bounds(&boxes[i], x, y, radius) {
                continue;
            }
            if disk_penetration(x, y, radius, &bodies[i]).is_some() {
                blocked = true;
                return;
            }
        }
    });
    !blocked
}

/// `cellsAlong` (`shared/buckets.ts`) without a clamping grid: each cell of a `size` grid within
/// `radius` of segment `ab`, row by row, until `visit` returns true. Returns whether it did.
///
/// The cells are counted as `f64`, as the TypeScript counts them. A segment with an infinite end
/// would loop there without end; here it visits nothing, which no caller reaches.
fn some_along(
    a: (f64, f64),
    b: (f64, f64),
    radius: f64,
    size: f64,
    mut visit: impl FnMut(f64, f64) -> bool,
) -> bool {
    let top = ((js_min(a.1, b.1) - radius) / size).floor();
    let bottom = ((js_max(a.1, b.1) + radius) / size).floor();
    if top.is_infinite() || bottom.is_infinite() {
        return false;
    }
    let dy = b.1 - a.1;
    let mut row = top;
    while row <= bottom {
        let (mut t0, mut t1) = (0.0, 1.0);
        if dy != 0.0 && !dy.is_nan() {
            let u = (row * size - radius - a.1) / dy;
            let v = ((row + 1.0) * size + radius - a.1) / dy;
            t0 = js_max(0.0, js_min(u, v));
            t1 = js_min(1.0, js_max(u, v));
            if t0 > t1 {
                row += 1.0;
                continue;
            }
        }
        let x0 = a.0 + t0 * (b.0 - a.0);
        let x1 = a.0 + t1 * (b.0 - a.0);
        let right = ((js_max(x0, x1) + radius) / size).floor();
        let mut col = ((js_min(x0, x1) - radius) / size).floor();
        if col.is_infinite() || right.is_infinite() {
            return false;
        }
        while col <= right {
            if visit(col, row) {
                return true;
            }
            col += 1.0;
        }
        row += 1.0;
    }
    false
}

/// `SIGHT_PAD` in `shared/sight.ts`.
const SIGHT_PAD: f64 = 1.0;

/// `lineClear(map, a, b)`: whether no obstacle edge that blocks sight, nor any closed gate's edge,
/// crosses the segment short of its end. A gate the caller ignores is written open in the mask.
/// Returns the answer and the ray-edge tests made (`work.rayEdgeTests`).
pub fn line_clear(
    index: &SightIndex,
    gates: &GateSet,
    a: (f64, f64),
    b: (f64, f64),
) -> (bool, u32) {
    let length = hypot(b.0 - a.0, b.1 - a.1);
    if length < 0.01 {
        return (true, 0);
    }
    let (dx, dy) = ((b.0 - a.0) / length, (b.1 - a.1) / length);
    let (left, right) = (js_min(a.0, b.0), js_max(a.0, b.0));
    let (top, bottom) = (js_min(a.1, b.1), js_max(a.1, b.1));
    let mut tests = 0u32;
    let mut blocks = |edge: &Edge| {
        tests += 1;
        js_max(edge[0], edge[2]) >= left
            && js_min(edge[0], edge[2]) <= right
            && js_max(edge[1], edge[3]) >= top
            && js_min(edge[1], edge[3]) <= bottom
            && hit_ray(a.0, a.1, dx, dy, edge) < length - 0.1
    };
    let blocked = some_along(a, b, SIGHT_PAD, BUCKET, |col, row| {
        index
            .grid
            .at(col, row)
            .iter()
            .any(|&i| blocks(&index.segments[i as usize]))
    }) || some_along(a, b, SIGHT_PAD, BUCKET, |col, row| {
        gates.grid.at(col, row).iter().any(|&i| {
            let i = i as usize;
            if gates.open[i] != 0 {
                return false;
            }
            let [x, y, w, h] = gates.boxes[i];
            x + w >= left
                && x <= right
                && y + h >= top
                && y <= bottom
                && gates.edges.of(i).iter().any(&mut blocks)
        })
    });
    (!blocked, tests)
}

/// `reachClear`: `lineClear`, and no see-through obstacle's edge crosses the segment, since hands
/// stop at a window or a pipe. Returns the answer and `lineClear`'s tests.
pub fn reach_clear(
    index: &SightIndex,
    gates: &GateSet,
    a: (f64, f64),
    b: (f64, f64),
) -> (bool, u32) {
    let (clear, tests) = line_clear(index, gates, a, b);
    if !clear {
        return (false, tests);
    }
    let length = hypot(b.0 - a.0, b.1 - a.1);
    if length < 0.01 {
        return (true, tests);
    }
    let (dx, dy) = ((b.0 - a.0) / length, (b.1 - a.1) / length);
    let blocked = some_along(a, b, SIGHT_PAD, BUCKET, |col, row| {
        index.through_grid.at(col, row).iter().any(|&i| {
            index
                .through
                .of(i as usize)
                .iter()
                .any(|edge| hit_ray(a.0, a.1, dx, dy, edge) < length)
        })
    });
    (!blocked, tests)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sight::tests::grid_of;

    const EMPTY: [i32; 5] = [0, 0, 0, 0, 0];

    fn open_map(
        width: f64,
        height: f64,
        colliders: &[f64],
        offsets: &[u32],
        grid: &[i32],
    ) -> CollisionMap {
        let (cols, rows) = (
            (width / 100.0).ceil() as usize,
            (height / 100.0).ceil() as usize,
        );
        CollisionMap::new(
            &[width, height, 100.0, cols as f64, rows as f64],
            &vec![1; cols * rows],
            colliders,
            offsets,
            grid,
        )
    }

    #[test]
    fn a_disk_touching_a_box_is_in_contact_and_one_inside_is_deep() {
        let body = Body::rect(100.0, 100.0, 50.0, 50.0);
        assert_eq!(disk_penetration(90.0, 120.0, 10.0, &body), Some(0.0));
        assert_eq!(disk_penetration(89.0, 120.0, 10.0, &body), None);
        assert_eq!(disk_penetration(125.0, 105.0, 10.0, &body), Some(15.0));
        // A corner is the Voronoi vertex case.
        assert_eq!(disk_penetration(160.0, 160.0, 10.0, &body), None);
        assert!(disk_penetration(155.0, 155.0, 10.0, &body).is_some());
    }

    #[test]
    fn duplicate_points_merge_and_signed_zeros_clear() {
        let Body::Polygon { points, x, .. } = Body::polygon(
            -0.0,
            0.0,
            &[[0.0, 0.0], [-0.0, 0.0], [10.0, 0.0], [0.0, 10.0]],
        ) else {
            unreachable!()
        };
        assert_eq!(points.len(), 3);
        assert!(x.is_sign_positive());
        assert_eq!(Body::rect(0.0, 0.0, 0.0, 10.0).polygon_len(), 2);
    }

    impl Body {
        fn polygon_len(&self) -> usize {
            match self {
                Body::Polygon { points, .. } => points.len(),
                Body::Circle { .. } => 0,
            }
        }
    }

    #[test]
    fn can_occupy_reads_the_tolerance_the_area_and_the_open_mask() {
        // A circle obstacle at (300, 300) r 20, listed in cell (1, 1).
        let mut map = open_map(
            800.0,
            800.0,
            &[CIRCLE, 0.0, 280.0, 280.0, 40.0, 40.0, 300.0, 300.0, 20.0],
            &[0, 9],
            &grid_of(&[((1, 1), vec![0])]),
        );
        let mut gates = GateSet::new(
            &[],
            &[0, 0],
            &[500.0, 500.0, 26.0, 54.0],
            &grid_of(&[((2, 2), vec![0])]),
        );
        // 0.005 deep is within the tolerance; 0.02 is not.
        assert!(can_occupy(
            &mut map, &mut gates, 330.005, 300.0, 10.0, false, false
        ));
        assert!(!can_occupy(
            &mut map, &mut gates, 329.98, 300.0, 10.0, false, false
        ));
        // Off the map, or across its edge.
        assert!(!can_occupy(
            &mut map, &mut gates, 5.0, 400.0, 10.0, false, false
        ));
        assert!(!can_occupy(
            &mut map,
            &mut gates,
            f64::NAN,
            400.0,
            10.0,
            false,
            false
        ));
        // A closed gate blocks on contact; open, or ignored, it does not.
        assert!(!can_occupy(
            &mut map, &mut gates, 516.0, 520.0, 3.0, false, false
        ));
        assert!(can_occupy(
            &mut map, &mut gates, 516.0, 520.0, 3.0, true, false
        ));
        gates.open[0] = 1;
        assert!(can_occupy(
            &mut map, &mut gates, 516.0, 520.0, 3.0, false, false
        ));
    }

    #[test]
    fn a_hole_in_the_area_blocks_the_disks_that_reach_it() {
        let mut occupied = vec![1u8; 16];
        occupied[4 + 1] = 0; // col 1, row 1
        let mut map = CollisionMap::new(
            &[400.0, 400.0, 100.0, 4.0, 4.0],
            &occupied,
            &[],
            &[0],
            &EMPTY,
        );
        let mut gates = GateSet::new(&[], &[0], &[], &EMPTY);
        assert!(!can_occupy(
            &mut map, &mut gates, 150.0, 150.0, 0.0, false, false
        ));
        assert!(!can_occupy(
            &mut map, &mut gates, 95.0, 150.0, 10.0, false, false
        ));
        assert!(can_occupy(
            &mut map, &mut gates, 90.0, 150.0, 10.0, false, false
        ));
    }

    #[test]
    fn reach_stops_at_see_through_edges_where_sight_does_not() {
        let window = [100.0, 0.0, 100.0, 300.0];
        let index = SightIndex::new(
            &[],
            &EMPTY,
            &window,
            &[0, 1],
            &grid_of(&[((0, 0), vec![0]), ((0, 1), vec![0])]),
        );
        let gates = GateSet::new(&[], &[0], &[], &EMPTY);
        assert!(line_clear(&index, &gates, (50.0, 50.0), (150.0, 50.0)).0);
        assert!(!reach_clear(&index, &gates, (50.0, 50.0), (150.0, 50.0)).0);
        assert!(reach_clear(&index, &gates, (50.0, 50.0), (90.0, 250.0)).0);
    }

    #[test]
    fn a_closed_gate_blocks_a_line_until_its_mask_opens_it() {
        let index = SightIndex::new(&[], &EMPTY, &[], &[0], &EMPTY);
        let mut gates = GateSet::new(
            &[
                100.0, 0.0, 110.0, 0.0, 110.0, 0.0, 110.0, 50.0, 110.0, 50.0, 100.0, 50.0, 100.0,
                50.0, 100.0, 0.0,
            ],
            &[0, 4],
            &[100.0, 0.0, 10.0, 50.0],
            &grid_of(&[((0, 0), vec![0])]),
        );
        let (clear, tests) = line_clear(&index, &gates, (50.0, 25.0), (150.0, 25.0));
        assert!(!clear && tests > 0);
        gates.open[0] = 1;
        assert_eq!(
            line_clear(&index, &gates, (50.0, 25.0), (150.0, 25.0)),
            (true, 0)
        );
        assert_eq!(
            line_clear(&index, &gates, (50.0, 25.0), (50.005, 25.0)),
            (true, 0)
        );
    }
}
