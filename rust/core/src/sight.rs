//! Sight casting: `visibilityPolygon`, ported from `shared/sight.ts` (#1175 stage 2, docs/27), whose
//! TypeScript cast has since retired.
//!
//! Its input is a derived flat index, not the map. JavaScript builds it from the map
//! (`shared/sight-core.ts`) and uploads it once:
//! - **A sight index:** the edges of every obstacle that blocks sight, and the cells they are listed in.
//! - **A gate set:** each gate's edges, its cells, and a mask of which gates are open, which the
//!   adapter rewrites before each call.
//!
//! It equalled the TypeScript's bit for bit, and `tests/sight-core.test.js` now pins its polygons by
//! digest. So it follows that cast operation for operation: the same visiting order, the same stable
//! sorts, the same floating-point expressions, and the crate's own `atan2`/`cos`/`sin`. Keep it so;
//! a moved digest is a gameplay change (docs/31).

use crate::math::{atan2, cos, sin};
use core::f64::consts::PI;

/// Cell side, in world units: `BUCKET` in `shared/buckets.ts`.
const BUCKET: f64 = 200.0;
const TAU: f64 = PI * 2.0;
/// Sample angles straddle +-pi by the corner offset; keep them covered.
const SEAM: f64 = PI + 1e-4;

/// One edge as `[ax, ay, bx, by]`.
type Edge = [f64; 4];

/// JavaScript's `Math.min`: NaN if either is, and -0 below +0.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// JavaScript's `Math.max`: NaN if either is, and +0 above -0.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// A bucket grid in compressed rows: the cells from (`col0`, `row0`), `cols` by `rows`, column
/// outer, each listing its entries in the order the TypeScript buckets hold them.
///
/// Uploaded as one `i32` array: `col0, row0, cols, rows`, then `cols * rows + 1` offsets into the
/// entries, then the entries.
struct Grid {
    col0: i64,
    row0: i64,
    cols: i64,
    rows: i64,
    offsets: Vec<u32>,
    entries: Vec<u32>,
}

impl Grid {
    fn from_words(words: &[i32]) -> Grid {
        let (col0, row0, cols, rows) = (words[0], words[1], words[2], words[3]);
        let cells = (cols.max(0) as usize) * (rows.max(0) as usize);
        let offsets: Vec<u32> = words[4..5 + cells].iter().map(|&w| w as u32).collect();
        let entries: Vec<u32> = words[5 + cells..].iter().map(|&w| w as u32).collect();
        Grid {
            col0: col0.into(),
            row0: row0.into(),
            cols: cols.into(),
            rows: rows.into(),
            offsets,
            entries,
        }
    }

    /// Each entry list of the cells the box touches, as `eachCellIn` visits them: columns outer,
    /// from `floor(left / BUCKET)` to `floor(right / BUCKET)`. Cells outside the grid are empty,
    /// so skipping them visits the same lists in the same order.
    fn each_cell_in(
        &self,
        left: f64,
        top: f64,
        right: f64,
        bottom: f64,
        mut visit: impl FnMut(&[u32]),
    ) {
        let (x0, x1) = ((left / BUCKET).floor(), (right / BUCKET).floor());
        let (y0, y1) = ((top / BUCKET).floor(), (bottom / BUCKET).floor());
        if x0.is_nan()
            || x1.is_nan()
            || y0.is_nan()
            || y1.is_nan()
            || self.cols <= 0
            || self.rows <= 0
        {
            return;
        }
        let clamp = |v: f64, lo: i64, hi: i64| -> i64 {
            if v < lo as f64 {
                lo
            } else if v > hi as f64 {
                hi
            } else {
                v as i64
            }
        };
        let (last_col, last_row) = (self.col0 + self.cols - 1, self.row0 + self.rows - 1);
        if x1 < self.col0 as f64
            || x0 > last_col as f64
            || y1 < self.row0 as f64
            || y0 > last_row as f64
        {
            return;
        }
        let (c0, c1) = (
            clamp(x0, self.col0, last_col),
            clamp(x1, self.col0, last_col),
        );
        let (r0, r1) = (
            clamp(y0, self.row0, last_row),
            clamp(y1, self.row0, last_row),
        );
        for col in c0..=c1 {
            for row in r0..=r1 {
                let cell = ((col - self.col0) * self.rows + (row - self.row0)) as usize;
                let (start, end) = (self.offsets[cell] as usize, self.offsets[cell + 1] as usize);
                if start < end {
                    visit(&self.entries[start..end]);
                }
            }
        }
    }
}

/// Which indices a query has already met: `Visited` in `shared/buckets.ts`.
struct Visited {
    marks: Vec<u32>,
    mark: u32,
}

impl Visited {
    fn new(size: usize) -> Visited {
        Visited {
            marks: vec![0; size],
            mark: 0,
        }
    }
    fn begin(&mut self) {
        self.mark = self.mark.wrapping_add(1);
        if self.mark == 0 {
            self.marks.fill(0);
            self.mark = 1;
        }
    }
    fn first(&mut self, i: usize) -> bool {
        if self.marks[i] == self.mark {
            return false;
        }
        self.marks[i] = self.mark;
        true
    }
}

/// The edges that block sight, from the obstacle list, with the polygon's output buffer.
pub struct SightIndex {
    segments: Vec<Edge>,
    grid: Grid,
    visited: Visited,
    /// The last polygon: `x, y, angle, length` per point.
    points: Vec<f64>,
    /// Ray-edge tests the last polygon made: `work.visibilityRays` in the profiler.
    tests: u32,
}

impl SightIndex {
    /// `segments` is `[ax, ay, bx, by]` per edge; `grid` lists segment indices (see `Grid`).
    pub fn new(segments: &[f64], grid: &[i32]) -> SightIndex {
        let segments: Vec<Edge> = segments.as_chunks::<4>().0.to_vec();
        let visited = Visited::new(segments.len());
        SightIndex {
            segments,
            grid: Grid::from_words(grid),
            visited,
            points: Vec::new(),
            tests: 0,
        }
    }
    pub fn points(&self) -> &[f64] {
        &self.points
    }
    pub fn tests(&self) -> u32 {
        self.tests
    }
}

/// A gate list's edges and cells, and which gates are open now.
pub struct GateSet {
    edges: Vec<Edge>,
    /// Gate `i`'s edges are `edges[offsets[i]..offsets[i + 1]]`.
    offsets: Vec<u32>,
    grid: Grid,
    visited: Visited,
    /// Nonzero where the gate is open. The adapter writes it before each call.
    pub open: Vec<u8>,
}

impl GateSet {
    pub fn new(edges: &[f64], offsets: &[u32], grid: &[i32]) -> GateSet {
        let count = offsets.len().saturating_sub(1);
        GateSet {
            edges: edges.as_chunks::<4>().0.to_vec(),
            offsets: offsets.to_vec(),
            grid: Grid::from_words(grid),
            visited: Visited::new(count),
            open: vec![0; count],
        }
    }
}

/// `hitRay`: the distance along the unit ray from `(ox, oy)` to the edge, or infinity.
fn hit_ray(ox: f64, oy: f64, dx: f64, dy: f64, edge: &Edge) -> f64 {
    let (sx, sy) = (edge[2] - edge[0], edge[3] - edge[1]);
    let cross = dx * sy - dy * sx;
    if cross.abs() < 1e-9 {
        return f64::INFINITY;
    }
    let (ax, ay) = (edge[0] - ox, edge[1] - oy);
    let t = (ax * sy - ay * sx) / cross;
    let u = (ax * dy - ay * dx) / cross;
    if t >= 0.0 && (0.0..=1.0).contains(&u) {
        t
    } else {
        f64::INFINITY
    }
}

#[derive(Clone, Copy)]
struct Span {
    edge: Edge,
    lo: f64,
    hi: f64,
}

/// `visibilityPolygon(map, origin, radius)`, written into `index.points`. Returns the point count.
pub fn visibility_polygon(
    index: &mut SightIndex,
    gates: &mut GateSet,
    ox: f64,
    oy: f64,
    radius: f64,
) -> usize {
    let mut angles: Vec<f64> = (0..100).map(|i| f64::from(i) * PI / 50.0 - PI).collect();
    let mut spans: Vec<Span> = Vec::new();
    let mut always: Vec<Edge> = Vec::new();
    let mut consider = |edge: &Edge| {
        let [ax, ay, bx, by] = *edge;
        if js_min(ax, bx) >= ox + radius
            || js_max(ax, bx) <= ox - radius
            || js_min(ay, by) >= oy + radius
            || js_max(ay, by) <= oy - radius
        {
            return;
        }
        let ea = atan2(ay - oy, ax - ox);
        let eb = atan2(by - oy, bx - ox);
        angles.extend_from_slice(&[
            ea - 0.00001,
            ea,
            ea + 0.00001,
            eb - 0.00001,
            eb,
            eb + 0.00001,
        ]);
        let (sx, sy) = (bx - ax, by - ay);
        let (px, py) = (ox - ax, oy - ay);
        let cross = sx * py - sy * px;
        let length_sq = sx * sx + sy * sy;
        let along = sx * px + sy * py;
        if cross * cross <= 1e-12 * length_sq && along >= -1e-9 && along <= length_sq + 1e-9 {
            always.push(*edge);
            return;
        }
        let (lo, hi) = (js_min(ea, eb), js_max(ea, eb));
        if hi - lo > PI {
            spans.push(Span {
                edge: *edge,
                lo: hi,
                hi: SEAM,
            });
            spans.push(Span {
                edge: *edge,
                lo: -SEAM,
                hi: lo,
            });
            return;
        }
        spans.push(Span {
            edge: *edge,
            lo,
            hi,
        });
        if hi >= PI - 1e-4 {
            spans.push(Span {
                edge: *edge,
                lo: lo - TAU,
                hi: hi - TAU,
            });
        }
        if lo <= 1e-4 - PI {
            spans.push(Span {
                edge: *edge,
                lo: lo + TAU,
                hi: hi + TAU,
            });
        }
    };
    let (left, top, right, bottom) = (ox - radius, oy - radius, ox + radius, oy + radius);
    index.visited.begin();
    gates.visited.begin();
    let (segments, visited) = (&index.segments, &mut index.visited);
    index.grid.each_cell_in(left, top, right, bottom, |list| {
        for &i in list {
            if visited.first(i as usize) {
                consider(&segments[i as usize]);
            }
        }
    });
    let (edges, offsets, open, gate_visited) = (
        &gates.edges,
        &gates.offsets,
        &gates.open,
        &mut gates.visited,
    );
    gates.grid.each_cell_in(left, top, right, bottom, |list| {
        for &i in list {
            let i = i as usize;
            if open[i] == 0 && gate_visited.first(i) {
                for edge in &edges[offsets[i] as usize..offsets[i + 1] as usize] {
                    consider(edge);
                }
            }
        }
    });
    // Both sorts are stable, as V8's is, and compare as `a - b` does: equal values keep their order.
    let order = |a: f64, b: f64| a.partial_cmp(&b).unwrap_or(core::cmp::Ordering::Equal);
    angles.sort_by(|a, b| order(*a, *b));
    spans.sort_by(|a, b| order(a.lo, b.lo));
    let mut active: Vec<Span> = Vec::new();
    let (mut entering, mut tests) = (0usize, 0u32);
    index.points.clear();
    for &angle in &angles {
        while entering < spans.len() && spans[entering].lo <= angle {
            active.push(spans[entering]);
            entering += 1;
        }
        let mut i = active.len();
        while i > 0 {
            i -= 1;
            if active[i].hi < angle {
                active.swap_remove(i);
            }
        }
        let (dx, dy) = (cos(angle), sin(angle));
        let mut length = radius;
        for span in &active {
            tests += 1;
            let hit = hit_ray(ox, oy, dx, dy, &span.edge);
            if hit < length {
                length = hit;
            }
        }
        for edge in &always {
            tests += 1;
            let hit = hit_ray(ox, oy, dx, dy, edge);
            if hit < length {
                length = hit;
            }
        }
        index
            .points
            .extend_from_slice(&[ox + dx * length, oy + dy * length, angle, length]);
    }
    index.tests = tests;
    angles.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_of(cells: &[((i32, i32), Vec<i32>)]) -> Vec<i32> {
        let (c0, c1) = (
            cells.iter().map(|c| c.0.0).min().unwrap(),
            cells.iter().map(|c| c.0.0).max().unwrap(),
        );
        let (r0, r1) = (
            cells.iter().map(|c| c.0.1).min().unwrap(),
            cells.iter().map(|c| c.0.1).max().unwrap(),
        );
        let (cols, rows) = (c1 - c0 + 1, r1 - r0 + 1);
        let mut lists = vec![Vec::new(); (cols * rows) as usize];
        for ((c, r), list) in cells {
            lists[((c - c0) * rows + (r - r0)) as usize] = list.clone();
        }
        let mut words = vec![c0, r0, cols, rows, 0];
        let mut total = 0;
        for list in &lists {
            total += list.len() as i32;
            words.push(total);
        }
        for list in lists {
            words.extend(list);
        }
        words
    }

    #[test]
    fn an_empty_map_sees_to_the_radius() {
        let mut index = SightIndex::new(&[], &[0, 0, 0, 0, 0]);
        let mut gates = GateSet::new(&[], &[0], &[0, 0, 0, 0, 0]);
        let n = visibility_polygon(&mut index, &mut gates, 100.0, 100.0, 50.0);
        assert_eq!(n, 100);
        assert!(
            index
                .points()
                .as_chunks::<4>()
                .0
                .iter()
                .all(|p| p[3] == 50.0)
        );
    }

    #[test]
    fn a_wall_shortens_the_rays_that_meet_it_and_a_closed_gate_does_too() {
        // A vertical wall at x = 150 from y = 50 to 150, listed in cell (0, 0).
        let mut index =
            SightIndex::new(&[150.0, 50.0, 150.0, 150.0], &grid_of(&[((0, 0), vec![0])]));
        let mut gates = GateSet::new(
            &[50.0, 50.0, 50.0, 150.0],
            &[0, 1],
            &grid_of(&[((0, 0), vec![0])]),
        );
        gates.open[0] = 1;
        visibility_polygon(&mut index, &mut gates, 100.0, 100.0, 120.0);
        let east = index
            .points()
            .as_chunks::<4>()
            .0
            .iter()
            .min_by(|a, b| a[2].abs().total_cmp(&b[2].abs()))
            .unwrap()[3];
        let west = index
            .points()
            .as_chunks::<4>()
            .0
            .iter()
            .find(|p| p[2] == -PI)
            .unwrap()[3];
        assert!((east - 50.0).abs() < 1e-6, "east {east}");
        assert_eq!(west, 120.0);
        gates.open[0] = 0;
        visibility_polygon(&mut index, &mut gates, 100.0, 100.0, 120.0);
        let west = index
            .points()
            .as_chunks::<4>()
            .0
            .iter()
            .find(|p| p[2] == -PI)
            .unwrap()[3];
        assert_eq!(west, 50.0);
    }

    #[test]
    fn js_min_and_max_order_signed_zeros() {
        assert!(js_min(0.0, -0.0).is_sign_negative() && js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_min(f64::NAN, 1.0).is_nan());
    }
}
