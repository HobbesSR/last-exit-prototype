//! Discovery: one contestant's sample of what it learns this tick, ported from `discover` in
//! `shared/discovery.ts` (#1210, docs/27 "The state flip", step 2).
//!
//! The state stays in JavaScript (D1). The adapter (`shared/discovery.ts`) packs what a sample
//! reads, this module computes what it learns, and the adapter applies that to the memory in the
//! order the TypeScript wrote it:
//! - **Per map, uploaded once** (`DiscoveryMap`): which discovery cells' centres are on playable
//!   ground, the landmarks with their cells, the roofs and the buildings no roof declares, and the
//!   rule's constants, which `discovery.ts` owns.
//! - **Per sample, packed** (`DiscoveryMap::input`): the eye and radius, and for a sample with line
//!   of sight the items near the eye, the remembered items near it, the boxes of the doors near it
//!   and which cells of the reach window are already seen. All of it follows the eye's reach, never
//!   the map (#635).
//! - **Returned** (`DiscoveryMap::output`): the cells to discover and to survey, the cells newly
//!   seen, and which packed items and doors are in sight.
//!
//! It follows the TypeScript operation for operation: the same visiting order, the same
//! floating-point expressions, and the crate's `atan2` and `hypot`. The fixture holds it there.

use crate::math::{atan2, hypot, js_max, js_min};
use crate::sight::{self, GateSet, SightIndex};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

/// The bucket side of the roof index: `ROOF_BUCKET` in `shared/view.ts`.
const ROOF_BUCKET: f64 = 160.0;

/// The words of the input header (`DiscoveryMap::input`).
pub const HEADER: usize = 11;

/// A roof as `roofAt` in `shared/view.ts` reads it.
struct Roof {
    id: u32,
    bounds: [f64; 4],
    origin: [f64; 2],
    cell_size: f64,
    cells: BTreeSet<(i64, i64)>,
}

/// `roofAt`'s index: roofs, then the buildings no roof declares, each listed per bucket in map
/// order. Roof and building ids are interned to integers by the adapter, so equal ids stay equal.
pub struct Roofs {
    roofs: Vec<Roof>,
    buildings: Vec<(u32, [f64; 4])>,
    roof_buckets: BTreeMap<(i64, i64), Vec<u32>>,
    building_buckets: BTreeMap<(i64, i64), Vec<u32>>,
}

fn bucket(v: f64) -> i64 {
    (v / ROOF_BUCKET).floor() as i64
}

/// `bucketOver`: list `item` in every bucket the closed box touches.
fn bucket_over(buckets: &mut BTreeMap<(i64, i64), Vec<u32>>, b: [f64; 4], item: u32) {
    for bx in bucket(b[0])..=bucket(b[2]) {
        for by in bucket(b[1])..=bucket(b[3]) {
            buckets.entry((bx, by)).or_default().push(item);
        }
    }
}

impl Roofs {
    /// A roof or fallback building conceals its contents from eyes outside the same roof.
    pub fn conceals(&self, eye: [f64; 2], target: [f64; 2]) -> bool {
        self.roof_at(target[0], target[1])
            .is_some_and(|roof| self.roof_at(eye[0], eye[1]) != Some(roof))
    }

    /// `roofs`: per roof `id, x, y, w, h, originX, originY, cellSize, cellCount`, then the cells'
    /// `x, y`. `buildings`: `id, x, y, w, h` per building no roof declares.
    fn new(roof_words: &[f64], building_words: &[f64]) -> Roofs {
        let mut roofs = Vec::new();
        let mut roof_buckets = BTreeMap::new();
        let mut at = 0;
        while at < roof_words.len() {
            let w = &roof_words[at..];
            let count = w[8] as usize;
            let cells = (0..count)
                .map(|i| (w[9 + i * 2] as i64, w[10 + i * 2] as i64))
                .collect();
            let bounds = [w[1], w[2], w[3], w[4]];
            bucket_over(
                &mut roof_buckets,
                [
                    bounds[0],
                    bounds[1],
                    bounds[0] + bounds[2],
                    bounds[1] + bounds[3],
                ],
                roofs.len() as u32,
            );
            roofs.push(Roof {
                id: w[0] as u32,
                bounds,
                origin: [w[5], w[6]],
                cell_size: w[7],
                cells,
            });
            at += 9 + count * 2;
        }
        let mut buildings = Vec::new();
        let mut building_buckets = BTreeMap::new();
        for w in building_words.as_chunks::<5>().0 {
            let b = [w[1], w[2], w[3], w[4]];
            bucket_over(
                &mut building_buckets,
                [b[0], b[1], b[0] + b[2], b[1] + b[3]],
                buildings.len() as u32,
            );
            buildings.push((w[0] as u32, b));
        }
        Roofs {
            roofs,
            buildings,
            roof_buckets,
            building_buckets,
        }
    }

    /// `roofAt`: the id of the roof or building over the point, or `None`. A point that is not
    /// finite has no bucket in the TypeScript, so none here.
    pub fn roof_at(&self, x: f64, y: f64) -> Option<u32> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        let key = (bucket(x), bucket(y));
        if let Some(list) = self.roof_buckets.get(&key) {
            for &i in list {
                let r = &self.roofs[i as usize];
                let [bx, by, bw, bh] = r.bounds;
                if x <= bx || x >= bx + bw || y <= by || y >= by + bh {
                    continue;
                }
                let cx = ((x - r.origin[0]) / r.cell_size).floor() as i64;
                let cy = ((y - r.origin[1]) / r.cell_size).floor() as i64;
                if r.cells.contains(&(cx, cy)) {
                    return Some(r.id);
                }
            }
        }
        if let Some(list) = self.building_buckets.get(&key) {
            for &i in list {
                let (id, [bx, by, bw, bh]) = self.buildings[i as usize];
                if x > bx && x < bx + bw && y > by && y < by + bh {
                    return Some(id);
                }
            }
        }
        None
    }
}

/// `litPoint` in `shared/sight.ts`, over the polygon's flat `x, y, angle, length` points.
pub fn lit_point(points: &[f64], ox: f64, oy: f64, x: f64, y: f64) -> bool {
    let n = points.len() / 4;
    if n < 3 {
        return false;
    }
    let angle_of = |i: usize| points[i * 4 + 2];
    let angle = atan2(y - oy, x - ox);
    let (lo, hi) = if angle < angle_of(0) || angle > angle_of(n - 1) {
        (n - 1, 0)
    } else {
        let (mut lo, mut hi) = (0, n - 1);
        while hi - lo > 1 {
            let mid = (lo + hi) >> 1;
            if angle_of(mid) <= angle {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        (lo, hi)
    };
    let (ax, ay) = (points[lo * 4], points[lo * 4 + 1]);
    let (ex, ey) = (points[hi * 4] - ax, points[hi * 4 + 1] - ay);
    let side = ex * (y - ay) - ey * (x - ax);
    let inner = ex * (oy - ay) - ey * (ox - ax);
    if inner == 0.0 {
        return false;
    }
    side == 0.0 || (side > 0.0) == (inner > 0.0)
}

/// What one map gives discovery, with the sample's input and output buffers.
#[derive(Clone)]
pub struct DiscoveryMap {
    cols: f64,
    rows: f64,
    /// `DISCOVERY_CELL_SIZE`, `DISCOVERY_VIEW`'s half extents and `BEACON_RADIUS`.
    cell: f64,
    half_width: f64,
    half_height: f64,
    beacon: f64,
    /// Nonzero where the cell's centre is playable ground (`insideMap`).
    inside: Vec<u8>,
    /// `x, y, cell` per landmark, in `landmarks()` order; the cell is -1 off the map.
    landmarks: Vec<[f64; 3]>,
    roofs: Arc<Roofs>,
    input: Vec<f64>,
    output: Vec<u32>,
}

/// The cells of the window `half_width` by `half_height` about the eye, in row-major order, as
/// `cells` in `discover` visits them.
#[allow(clippy::too_many_arguments)]
fn each_cell(
    map: &DiscoveryMap,
    ex: f64,
    ey: f64,
    half_width: f64,
    half_height: f64,
    any_ground: bool,
    mut visit: impl FnMut(u32, f64, f64),
) {
    let c = map.cell;
    let min_col = js_max(0.0, ((ex - half_width) / c).floor());
    let max_col = js_min(map.cols - 1.0, ((ex + half_width) / c).floor());
    let min_row = js_max(0.0, ((ey - half_height) / c).floor());
    let max_row = js_min(map.rows - 1.0, ((ey + half_height) / c).floor());
    let mut row = min_row;
    while row <= max_row {
        let mut col = min_col;
        while col <= max_col {
            let (cx, cy) = (col * c + c / 2.0, row * c + c / 2.0);
            let idx = row * map.cols + col;
            if (cx - ex).abs() <= half_width
                && (cy - ey).abs() <= half_height
                && (any_ground || map.inside[idx as usize] != 0)
            {
                visit(idx as u32, cx, cy);
            }
            col += 1.0;
        }
        row += 1.0;
    }
}

impl DiscoveryMap {
    /// `constants` is `[cols, rows, cell, halfWidth, halfHeight, beacon]`.
    pub fn new(
        constants: &[f64],
        inside: &[u8],
        landmarks: &[f64],
        roofs: &[f64],
        buildings: &[f64],
    ) -> DiscoveryMap {
        DiscoveryMap {
            cols: constants[0],
            rows: constants[1],
            cell: constants[2],
            half_width: constants[3],
            half_height: constants[4],
            beacon: constants[5],
            inside: inside.to_vec(),
            landmarks: landmarks.as_chunks::<3>().0.to_vec(),
            roofs: Arc::new(Roofs::new(roofs, buildings)),
            input: Vec::new(),
            output: Vec::new(),
        }
    }

    /// The input buffer, resized to `len` words. Its layout:
    /// - the header: `x, y, radius, sighted, items, remembered, gates`, then the reach window's
    ///   `minCol, maxCol, minRow, maxRow`;
    /// - `x, y` per item near the eye, then per remembered item near it;
    /// - `x, y, w, h` per door near it (`gateShape`);
    /// - one word per reach-window cell, row-major, nonzero where the cell is already seen.
    pub fn input(&mut self, len: usize) -> &mut [f64] {
        self.input.resize(len, 0.0);
        &mut self.input
    }

    /// One sample. `sight` is the map's sight index and gate set, with the gates' open mask
    /// already written; it is needed only for a sample with line of sight. The output:
    /// - whether the polygon was built, and its ray-edge tests;
    /// - a count, then the cells, for each of: discovered (view window, then beacons), surveyed
    ///   and newly seen;
    /// - one flag per packed item, remembered item and door, nonzero where it is in sight.
    pub fn sample(&mut self, mut sight: Option<(&mut SightIndex, &mut GateSet)>) -> &[u32] {
        let mut out = std::mem::take(&mut self.output);
        out.clear();
        let input = std::mem::take(&mut self.input);
        let [
            ex,
            ey,
            radius,
            sighted,
            items,
            remembered,
            gates,
            c0,
            c1,
            r0,
            r1,
        ] = <[f64; HEADER]>::try_from(&input[..HEADER]).expect("the header");
        let sighted = sighted != 0.0 && sight.is_some();
        out.extend_from_slice(&[0, 0]);

        let list_start = out.len();
        out.push(0);
        each_cell(
            self,
            ex,
            ey,
            self.half_width,
            self.half_height,
            false,
            |idx, _, _| out.push(idx),
        );
        let beacon_sq = self.beacon * self.beacon;
        for &[lx, ly, cell] in &self.landmarks {
            let (dx, dy) = (lx - ex, ly - ey);
            if dx * dx + dy * dy > beacon_sq || cell < 0.0 {
                continue;
            }
            out.push(cell as u32);
        }
        out[list_start] = (out.len() - list_start - 1) as u32;

        let list_start = out.len();
        out.push(0);
        if sighted {
            each_cell(
                self,
                ex,
                ey,
                self.half_width,
                self.half_height,
                true,
                |idx, _, _| out.push(idx),
            );
        }
        out[list_start] = (out.len() - list_start - 1) as u32;

        let list_start = out.len();
        out.push(0);
        if let (true, Some((index, gate_set))) = (sighted, sight.as_mut()) {
            let radius_sq = radius * radius;
            let roofs = &self.roofs;
            let mut eye_roof: Option<Option<u32>> = None;
            let mut built = false;
            let mut sees = |x: f64, y: f64| -> bool {
                let (dx, dy) = (x - ex, y - ey);
                if dx * dx + dy * dy > radius_sq {
                    return false;
                }
                if let Some(target) = roofs.roof_at(x, y) {
                    let eye = *eye_roof.get_or_insert_with(|| roofs.roof_at(ex, ey));
                    if eye != Some(target) {
                        return false;
                    }
                }
                if !built {
                    sight::visibility_polygon(index, gate_set, ex, ey, radius);
                    built = true;
                }
                lit_point(index.points(), ex, ey, x, y)
            };

            let at = HEADER;
            let (items, remembered, gates) = (items as usize, remembered as usize, gates as usize);
            let mask = at + (items + remembered) * 2 + gates * 4;
            let width = if c1 >= c0 { (c1 - c0) as usize + 1 } else { 0 };
            let mut row = r0;
            while row <= r1 {
                let mut col = c0;
                while col <= c1 {
                    let c = self.cell;
                    let (cx, cy) = (col * c + c / 2.0, row * c + c / 2.0);
                    let idx = row * self.cols + col;
                    let window = (row - r0) as usize * width + (col - c0) as usize;
                    if (cx - ex).abs() <= radius
                        && (cy - ey).abs() <= radius
                        && self.inside[idx as usize] != 0
                        && input[mask + window] == 0.0
                        && sees(cx, cy)
                    {
                        out.push(idx as u32);
                    }
                    col += 1.0;
                }
                row += 1.0;
            }
            out[list_start] = (out.len() - list_start - 1) as u32;

            for i in 0..items + remembered {
                let seen = sees(input[at + i * 2], input[at + i * 2 + 1]);
                out.push(u32::from(seen));
            }
            let doors = at + (items + remembered) * 2;
            for g in input[doors..doors + gates * 4].as_chunks::<4>().0 {
                let [bx, by, bw, bh] = *g;
                let nx = js_max(bx, js_min(bx + bw, ex));
                let ny = js_max(by, js_min(by + bh, ey));
                let (dx, dy) = (ex - nx, ey - ny);
                let d = hypot(dx, dy);
                let seen = d <= radius
                    && if d > 1.0 {
                        sees(nx + dx / d, ny + dy / d)
                    } else {
                        sees(ex, ey)
                    };
                out.push(u32::from(seen));
            }
            if built {
                out[0] = 1;
                out[1] = index.tests();
            }
        }
        self.input = input;
        self.output = out;
        &self.output
    }

    /// The grid's columns and rows and the cell side, for packing a sample's reach window.
    pub(crate) fn grid(&self) -> [f64; 3] {
        [self.cols, self.rows, self.cell]
    }

    /// `roofAt` over this map's roofs, for the parity check.
    pub fn roof_at(&self, x: f64, y: f64) -> Option<u32> {
        self.roofs.roof_at(x, y)
    }

    pub(crate) fn roofs(&self) -> Arc<Roofs> {
        self.roofs.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_map(cols: usize, rows: usize) -> DiscoveryMap {
        let constants = [cols as f64, rows as f64, 192.0, 1200.0, 800.0, 4000.0];
        DiscoveryMap::new(&constants, &vec![1; cols * rows], &[], &[], &[])
    }

    #[test]
    fn a_sample_without_sight_discovers_the_view_window_in_row_major_order() {
        let mut map = open_map(30, 20);
        let input = map.input(HEADER);
        input.copy_from_slice(&[96.0, 96.0, 1200.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, -1.0]);
        let out = map.sample(None).to_vec();
        // Columns 0..=6 (centres within 1200 of 96), rows 0..=4 (within 800).
        assert_eq!(out[2], 7 * 5);
        assert_eq!(out[3..6], [0, 1, 2]);
        assert_eq!(out[3 + 7], 30);
        assert_eq!(out[3 + 35], 0, "no surveyed cells without sight");
    }

    #[test]
    fn a_roof_conceals_what_is_under_it_from_outside_only() {
        let roofs = Roofs::new(
            &[
                7.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 50.0, 1.0, 0.0, 0.0,
            ],
            &[3.0, 400.0, 400.0, 50.0, 50.0],
        );
        assert_eq!(roofs.roof_at(120.0, 120.0), Some(7));
        assert_eq!(
            roofs.roof_at(170.0, 120.0),
            None,
            "outside the roof's cells"
        );
        assert_eq!(roofs.roof_at(100.0, 120.0), None, "the bounds are open");
        assert_eq!(roofs.roof_at(420.0, 420.0), Some(3));
        assert_eq!(roofs.roof_at(f64::NAN, 420.0), None);
    }

    #[test]
    fn lit_point_rejects_a_degenerate_polygon() {
        assert!(!lit_point(&[0.0; 8], 0.0, 0.0, 1.0, 1.0));
    }
}
