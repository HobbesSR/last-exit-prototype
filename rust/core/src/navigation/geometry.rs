use crate::math::hypot;
use crate::runtime_map::Tile;
use std::collections::BTreeMap;

pub(super) type Point = [f64; 2];
pub(super) type Portal = [Point; 2];

fn vertex(tile: &Tile<'_>, slot: usize) -> Point {
    tile.point(tile.triangles.u32(slot) as usize).unwrap()
}

pub(super) fn edge(tile: &Tile<'_>, slot: usize) -> Portal {
    let base = slot / 3 * 3;
    [vertex(tile, slot), vertex(tile, base + (slot % 3 + 1) % 3)]
}

pub(super) fn centre(tile: &Tile<'_>, triangle: usize) -> Point {
    let a = vertex(tile, triangle * 3);
    let b = vertex(tile, triangle * 3 + 1);
    let c = vertex(tile, triangle * 3 + 2);
    [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0]
}

pub(super) fn cross(a: Point, b: Point, c: Point) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

pub(crate) fn closest(p: Point, a: Point, b: Point) -> Point {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let n = dx * dx + dy * dy;
    let t = if n != 0.0 {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n).clamp(0.0, 1.0) + 0.0
    } else {
        0.0
    };
    [a[0] + t * dx, a[1] + t * dy]
}

fn locate(tile: &Tile<'_>, point: Point) -> Option<usize> {
    let col = ((point[0] - tile.locator_origin[0]) / tile.locator_size).floor();
    let row = ((point[1] - tile.locator_origin[1]) / tile.locator_size).floor();
    let [cols, rows] = tile.locator_dimensions;
    if col < 0.0 || row < 0.0 || col >= cols as f64 || row >= rows as f64 {
        return None;
    }
    let cell = row as usize * cols + col as usize;
    for i in tile.locator_starts.u32(cell)..tile.locator_starts.u32(cell + 1) {
        let t = tile.locator_items.u32(i as usize) as usize;
        let inside = (0..3).all(|k| {
            let [a, b] = edge(tile, t * 3 + k);
            let dx = b[0] - a[0];
            let dy = b[1] - a[1];
            dx * (point[1] - a[1]) - dy * (point[0] - a[0]) >= -1e-6 * hypot(dx, dy)
        });
        if inside {
            return Some(t);
        }
    }
    None
}

pub(super) fn entry(tile: &Tile<'_>, point: Point, reach: f64) -> Option<(usize, Point, bool)> {
    if let Some(t) = locate(tile, point) {
        return Some((t, point, false));
    }
    let [cols, rows] = tile.locator_dimensions;
    let c0 = ((point[0] - reach - tile.locator_origin[0]) / tile.locator_size)
        .floor()
        .max(0.0) as i64;
    let c1 = ((point[0] + reach - tile.locator_origin[0]) / tile.locator_size)
        .floor()
        .min(cols as f64 - 1.0) as i64;
    let r0 = ((point[1] - reach - tile.locator_origin[1]) / tile.locator_size)
        .floor()
        .max(0.0) as i64;
    let r1 = ((point[1] + reach - tile.locator_origin[1]) / tile.locator_size)
        .floor()
        .min(rows as f64 - 1.0) as i64;
    let mut best = reach;
    let mut found: Option<(usize, Point, bool)> = None;
    for r in r0..=r1 {
        for c in c0..=c1 {
            let cell = r as usize * cols + c as usize;
            for i in tile.locator_starts.u32(cell)..tile.locator_starts.u32(cell + 1) {
                let t = tile.locator_items.u32(i as usize) as usize;
                for k in 0..3 {
                    if tile.twins.i32(t * 3 + k) >= 0 {
                        continue;
                    }
                    let [a, b] = edge(tile, t * 3 + k);
                    let near = closest(point, a, b);
                    let d = hypot(near[0] - point[0], near[1] - point[1]);
                    if d < best || (d == best && found.is_some_and(|f| t < f.0)) {
                        let third = vertex(tile, t * 3 + (k + 2) % 3);
                        let cx = (a[0] + b[0] + third[0]) / 3.0 - near[0];
                        let cy = (a[1] + b[1] + third[1]) / 3.0 - near[1];
                        let n = hypot(cx, cy);
                        best = d;
                        found = Some((t, [near[0] + cx / n * 0.01, near[1] + cy / n * 0.01], true));
                    }
                }
            }
        }
    }
    found
}

pub(super) fn side_of([x, y, w, h]: [f64; 4], [p, q]: Portal) -> Option<usize> {
    if p[0] == x && q[0] == x {
        Some(0)
    } else if p[1] == y && q[1] == y {
        Some(1)
    } else if p[0] == x + w && q[0] == x + w {
        Some(2)
    } else if p[1] == y + h && q[1] == y + h {
        Some(3)
    } else {
        None
    }
}

pub(super) fn side_segment([x, y, w, h]: [f64; 4], side: usize) -> Portal {
    match side {
        0 => [[x, y], [x, y + h]],
        1 => [[x, y], [x + w, y]],
        2 => [[x + w, y], [x + w, y + h]],
        _ => [[x, y + h], [x + w, y + h]],
    }
}

pub(super) fn overlap([p, q]: Portal, [r, s]: Portal, side: usize) -> Option<Portal> {
    let along = if side.is_multiple_of(2) { 1 } else { 0 };
    let lo = p[along].min(q[along]).max(r[along].min(s[along]));
    let hi = p[along].max(q[along]).min(r[along].max(s[along]));
    if hi - lo <= 1e-6 {
        return None;
    }
    Some(if along == 1 {
        [[p[0], lo], [p[0], hi]]
    } else {
        [[lo, p[1]], [hi, p[1]]]
    })
}

fn on_segment(p: Point, a: Point, b: Point) -> bool {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let n = dx * dx + dy * dy;
    let side = dx * (p[1] - a[1]) - dy * (p[0] - a[0]);
    if side * side > 1e-12 * n {
        return false;
    }
    let t = if n != 0.0 {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n).clamp(0.0, 1.0)
    } else {
        0.0
    };
    hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) <= 1e-6
}

pub(super) fn pull_taut(from: Point, to: Point, portals: &[Portal]) -> Vec<Point> {
    // IDs follow the JavaScript coordinate-keyed map, with distinct start and goal IDs.
    let mut ids_by_point = BTreeMap::new();
    let mut ends: Vec<([isize; 2], Portal)> = vec![([-1, -1], [from, from])];
    for &portal in portals {
        let mut ids = [0; 2];
        for k in 0..2 {
            // JavaScript's coordinate keys treat positive and negative zero as the same point.
            let key = portal[k].map(|coordinate| {
                if coordinate == 0.0 {
                    0
                } else {
                    coordinate.to_bits()
                }
            });
            let next = ids_by_point.len() as isize;
            ids[k] = *ids_by_point.entry(key).or_insert(next);
        }
        ends.push((ids, portal));
    }
    ends.push(([-2, -2], [to, to]));
    let mut apex = -1;
    let mut a = from;
    let mut apex_at;
    let mut left = -1;
    let mut lpoint = from;
    let mut left_at = 0;
    let mut right = -1;
    let mut rpoint = from;
    let mut right_at = 0;
    let mut path = vec![from];
    let mut i = 1;
    while i < ends.len() {
        let ([l, r], [pl, pr]) = ends[i];
        if l != apex && r != apex && on_segment(a, pl, pr) {
            i += 1;
            continue;
        }
        if r != apex && (right == apex || cross(a, rpoint, pr) >= 0.0) {
            if left == apex || cross(a, pr, lpoint) > 0.0 {
                right = r;
                rpoint = pr;
                right_at = i;
            } else {
                path.push(lpoint);
                apex = left;
                a = lpoint;
                apex_at = left_at;
                right = left;
                rpoint = lpoint;
                right_at = left_at;
                i = apex_at + 1;
                continue;
            }
        }
        if l != apex && (left == apex || cross(a, pl, lpoint) >= 0.0) {
            if right == apex || cross(a, rpoint, pl) > 0.0 {
                left = l;
                lpoint = pl;
                left_at = i;
            } else {
                path.push(rpoint);
                apex = right;
                a = rpoint;
                apex_at = right_at;
                left = right;
                lpoint = rpoint;
                left_at = right_at;
                i = apex_at + 1;
                continue;
            }
        }
        i += 1;
    }
    if *path.last().unwrap() != to {
        path.push(to);
    }
    path
}

fn meet(a: Point, b: Point, c: Point, d: Point) -> Option<Point> {
    let rx = b[0] - a[0];
    let ry = b[1] - a[1];
    let sx = d[0] - c[0];
    let sy = d[1] - c[1];
    let den = rx * sy - ry * sx;
    let eps = 1e-6;
    if den.abs() > eps * hypot(rx, ry) * hypot(sx, sy) {
        let t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
        let u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
        let tol = eps / eps.max(hypot(rx, ry));
        let tol_u = eps / eps.max(hypot(sx, sy));
        return if t >= -tol && t <= 1.0 + tol && u >= -tol_u && u <= 1.0 + tol_u {
            Some([a[0] + t * rx, a[1] + t * ry])
        } else {
            None
        };
    }
    for p in [a, b] {
        let n = closest(p, c, d);
        if hypot(n[0] - p[0], n[1] - p[1]) <= eps {
            return Some(p);
        }
    }
    None
}

pub(super) fn cut_at(path: &[Point], portals: &[Portal]) -> Vec<Point> {
    let mut segment = 0;
    let mut crossing = path[0];
    for &[c, d] in portals {
        while segment < path.len() - 1 {
            if let Some(hit) = meet(path[segment], path[segment + 1], c, d) {
                crossing = hit;
                break;
            }
            segment += 1;
        }
    }
    let mut result = path[..=segment].to_vec();
    result.push(crossing);
    result.dedup();
    result
}
