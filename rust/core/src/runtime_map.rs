//! Borrowed, validated views over the flat runtime navigation package.

use std::borrow::Cow;

const POINT_SCALE: f64 = 256.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeError;

type Result<T> = std::result::Result<T, DecodeError>;

#[derive(Clone, Copy)]
pub struct ValidationOptions<'a> {
    pub width: f64,
    pub height: f64,
    pub grid_size: f64,
    pub grid_cols: usize,
    pub grid_rows: usize,
    pub gate_count: usize,
    pub clearances: &'a [f64],
    pub single_role: bool,
}

/// Little-endian scalars read directly from a borrowed byte section, without alignment assumptions.
#[derive(Clone, Copy)]
pub struct Values<'a> {
    bytes: &'a [u8],
    width: usize,
}
impl<'a> Values<'a> {
    pub fn len(self) -> usize {
        self.bytes.len() / self.width
    }
    pub fn is_empty(self) -> bool {
        self.bytes.is_empty()
    }
    pub fn u16(self, i: usize) -> u16 {
        u16::from_le_bytes(self.bytes[i * 2..i * 2 + 2].try_into().unwrap())
    }
    pub fn u32(self, i: usize) -> u32 {
        u32::from_le_bytes(self.bytes[i * 4..i * 4 + 4].try_into().unwrap())
    }
    pub fn i32(self, i: usize) -> i32 {
        i32::from_le_bytes(self.bytes[i * 4..i * 4 + 4].try_into().unwrap())
    }
    pub fn f64(self, i: usize) -> f64 {
        f64::from_le_bytes(self.bytes[i * 8..i * 8 + 8].try_into().unwrap())
    }
    pub fn slice(self, start: usize, len: usize) -> Self {
        Self {
            bytes: &self.bytes[start * self.width..(start + len) * self.width],
            width: self.width,
        }
    }
}

pub struct RuntimeMap<'a> {
    bytes: &'a [u8],
    sections: Cow<'a, [(usize, usize)]>,
    pub version: u32,
    graph_present: bool,
    layers: usize,
}

/// Validated offsets for rebinding to the same immutable package without revalidation.
#[derive(Clone)]
pub struct RuntimeMapLayout {
    sections: Vec<(usize, usize)>,
    version: u32,
    graph_present: bool,
    layers: usize,
}
impl RuntimeMapLayout {
    /// # Safety
    /// `bytes` must contain the exact immutable package validated for this layout.
    pub unsafe fn bind<'a>(&'a self, bytes: &'a [u8]) -> RuntimeMap<'a> {
        RuntimeMap {
            bytes,
            sections: Cow::Borrowed(&self.sections),
            version: self.version,
            graph_present: self.graph_present,
            layers: self.layers,
        }
    }
}
#[derive(Clone, Copy)]
pub struct Graph<'a> {
    geometry: Values<'a>,
    rows: Values<'a>,
    pub owner: Values<'a>,
    adjacency: Values<'a>,
    stands: Values<'a>,
}

pub struct Region<'a> {
    pub bounds: [f64; 4],
    pub portals: Values<'a>,
}

pub struct Portal<'a> {
    pub position: [f64; 2],
    pub regions: [usize; 2],
    pub slots: [usize; 2],
    stands: Values<'a>,
}

impl Portal<'_> {
    pub fn stands(&self) -> impl ExactSizeIterator<Item = [f64; 2]> + '_ {
        (0..self.stands.len() / 2).map(|i| [self.stands.f64(i * 2), self.stands.f64(i * 2 + 1)])
    }
}
#[derive(Clone, Copy)]
pub struct Layer<'a> {
    pub config: Values<'a>,
    pub dims: Values<'a>,
    pub rows: Values<'a>,
    pub geometry: Values<'a>,
    pub points: Values<'a>,
    pub ints: Values<'a>,
    pub sets: Values<'a>,
    pub members: Values<'a>,
    pub compact: bool,
}

/// One tile's borrowed query inputs, in the writer's triangle and gate-set order.
pub struct Tile<'a> {
    pub bounds: [f64; 4],
    pub reach: f64,
    points: Values<'a>,
    compact: bool,
    pub triangles: Values<'a>,
    pub twins: Values<'a>,
    pub locator_origin: [f64; 2],
    pub locator_size: f64,
    pub locator_dimensions: [usize; 2],
    pub locator_starts: Values<'a>,
    pub locator_items: Values<'a>,
    pub triangle_gate_sets: Values<'a>,
    gate_sets: Values<'a>,
    gate_members: Values<'a>,
}

impl<'a> Tile<'a> {
    pub fn point(&self, index: usize) -> Option<[f64; 2]> {
        if index >= self.points.len() / 2 {
            return None;
        }
        let at = index * 2;
        Some(if self.compact {
            [
                self.bounds[0] + f64::from(self.points.u16(at)) / POINT_SCALE,
                self.bounds[1] + f64::from(self.points.u16(at + 1)) / POINT_SCALE,
            ]
        } else {
            [self.points.f64(at), self.points.f64(at + 1)]
        })
    }

    pub fn gate_set(&self, index: usize) -> Option<Values<'a>> {
        if index >= self.gate_sets.len() / 2 {
            return None;
        }
        let at = index * 2;
        Some(self.gate_members.slice(
            self.gate_sets.u32(at) as usize,
            self.gate_sets.u32(at + 1) as usize,
        ))
    }
}

fn add(a: usize, b: usize) -> Result<usize> {
    a.checked_add(b).ok_or(DecodeError)
}
fn mul(a: usize, b: usize) -> Result<usize> {
    a.checked_mul(b).ok_or(DecodeError)
}
fn within(start: usize, len: usize, total: usize) -> Result<()> {
    if start <= total && len <= total - start {
        Ok(())
    } else {
        Err(DecodeError)
    }
}
fn finite(v: Values<'_>) -> Result<()> {
    if (0..v.len()).all(|i| v.f64(i).is_finite()) {
        Ok(())
    } else {
        Err(DecodeError)
    }
}

impl<'a> RuntimeMap<'a> {
    pub fn parse(bytes: &'a [u8], options: ValidationOptions<'_>) -> Result<Self> {
        if bytes.len() < 8 {
            return Err(DecodeError);
        }
        let head = Values { bytes, width: 4 };
        let version = head.u32(0);
        let count = head.u32(1) as usize;
        if !(version == 1 || version == 2)
            || (options.single_role && version != 2)
            || count > 22
            || count > (bytes.len() - 8) / 8
            || !options.width.is_finite()
            || options.width <= 0.0
            || !options.height.is_finite()
            || options.height <= 0.0
            || !options.grid_size.is_finite()
            || options.grid_size <= 0.0
            || (options.width / options.grid_size).ceil() != options.grid_cols as f64
            || (options.height / options.grid_size).ceil() != options.grid_rows as f64
            || options
                .clearances
                .iter()
                .any(|x| !x.is_finite() || *x <= 0.0)
        {
            return Err(DecodeError);
        }
        let mut sections = Vec::with_capacity(count);
        let mut end = add(8, mul(count, 8)?)?;
        for i in 0..count {
            let offset = head.u32(2 + i * 2) as usize;
            let len = head.u32(3 + i * 2) as usize;
            let aligned = add(end, 7)? & !7;
            if offset != aligned {
                return Err(DecodeError);
            }
            within(offset, len, bytes.len())?;
            sections.push((offset, len));
            end = add(offset, len)?;
        }
        if end != bytes.len() {
            return Err(DecodeError);
        }
        let mut map = Self {
            bytes,
            sections: Cow::Owned(sections),
            version,
            graph_present: false,
            layers: 0,
        };
        let header = map.section(0, 4)?;
        if header.len() != 2 || header.u32(0) > 1 {
            return Err(DecodeError);
        }
        map.graph_present = header.u32(0) == 1;
        map.layers = header.u32(1) as usize;
        let expected = if options.single_role { 1 } else { 2 };
        if map.layers != expected
            || options.clearances.len() != expected
            || count != 1 + expected * 8 + usize::from(map.graph_present) * 5
        {
            return Err(DecodeError);
        }
        if map.graph_present {
            let graph = map.graph().ok_or(DecodeError)?;
            graph.validate()?;
        }
        for i in 0..map.layers {
            let layer = map.layer(i).ok_or(DecodeError)?;
            layer.validate(&options)?;
            let clearance = layer.config.f64(0);
            if !options.clearances.contains(&clearance)
                || (i == 1
                    && map
                        .layer(0)
                        .is_some_and(|first| first.clearance() == clearance))
            {
                return Err(DecodeError);
            }
        }
        Ok(map)
    }
    pub fn into_layout(self) -> RuntimeMapLayout {
        RuntimeMapLayout {
            sections: self.sections.into_owned(),
            version: self.version,
            graph_present: self.graph_present,
            layers: self.layers,
        }
    }
    fn section(&self, i: usize, width: usize) -> Result<Values<'a>> {
        let &(offset, len) = self.sections.get(i).ok_or(DecodeError)?;
        if len % width != 0 {
            return Err(DecodeError);
        }
        Ok(Values {
            bytes: &self.bytes[offset..offset + len],
            width,
        })
    }
    pub fn graph(&self) -> Option<Graph<'a>> {
        if !self.graph_present {
            return None;
        }
        Some(Graph {
            geometry: self.section(1, 8).ok()?,
            rows: self.section(2, 4).ok()?,
            owner: self.section(3, 4).ok()?,
            adjacency: self.section(4, 4).ok()?,
            stands: self.section(5, 8).ok()?,
        })
    }
    pub fn layer_count(&self) -> usize {
        self.layers
    }
    pub fn layer(&self, i: usize) -> Option<Layer<'a>> {
        if i >= self.layers {
            return None;
        }
        let s = 1 + usize::from(self.graph_present) * 5 + i * 8;
        Some(Layer {
            config: self.section(s, 8).ok()?,
            dims: self.section(s + 1, 4).ok()?,
            rows: self.section(s + 2, 4).ok()?,
            geometry: self.section(s + 3, 8).ok()?,
            points: self
                .section(s + 4, if self.version == 2 { 2 } else { 8 })
                .ok()?,
            ints: self.section(s + 5, 4).ok()?,
            sets: self.section(s + 6, 4).ok()?,
            members: self.section(s + 7, 4).ok()?,
            compact: self.version == 2,
        })
    }
}

impl<'a> Graph<'a> {
    pub(crate) fn portal_count(&self) -> usize {
        self.rows.u32(3) as usize
    }

    pub fn grid(&self) -> (f64, usize, usize) {
        (
            self.geometry.f64(0),
            self.rows.u32(0) as usize,
            self.rows.u32(1) as usize,
        )
    }

    pub fn region(&self, index: usize) -> Option<Region<'a>> {
        if index >= self.rows.u32(2) as usize {
            return None;
        }
        let g = 1 + index * 4;
        let r = 4 + index * 2;
        Some(Region {
            bounds: std::array::from_fn(|i| self.geometry.f64(g + i)),
            portals: self
                .adjacency
                .slice(self.rows.u32(r) as usize, self.rows.u32(r + 1) as usize),
        })
    }

    pub fn portal(&self, index: usize) -> Option<Portal<'a>> {
        if index >= self.portal_count() {
            return None;
        }
        let regions = self.rows.u32(2) as usize;
        let g = 1 + regions * 4 + index * 2;
        let r = 4 + regions * 2 + index * 6;
        Some(Portal {
            position: [self.geometry.f64(g), self.geometry.f64(g + 1)],
            regions: [self.rows.u32(r) as usize, self.rows.u32(r + 1) as usize],
            slots: [self.rows.u32(r + 2) as usize, self.rows.u32(r + 3) as usize],
            stands: self.stands.slice(
                self.rows.u32(r + 4) as usize * 2,
                self.rows.u32(r + 5) as usize * 2,
            ),
        })
    }

    fn validate(self) -> Result<()> {
        let (g, r, o, a, s) = (
            self.geometry,
            self.rows,
            self.owner,
            self.adjacency,
            self.stands,
        );
        if r.len() < 4 {
            return Err(DecodeError);
        }
        let (cols, down, nr, np) = (
            r.u32(0) as usize,
            r.u32(1) as usize,
            r.u32(2) as usize,
            r.u32(3) as usize,
        );
        if cols == 0
            || down == 0
            || o.len() != mul(cols, down)?
            || g.len() != add(add(1, mul(nr, 4)?)?, mul(np, 2)?)?
            || r.len() != add(add(4, mul(nr, 2)?)?, mul(np, 6)?)?
            || s.len() % 2 != 0
            || g.f64(0) <= 0.0
        {
            return Err(DecodeError);
        }
        finite(g)?;
        finite(s)?;
        for i in 0..o.len() {
            let n = o.i32(i);
            if n < -1 || (n >= 0 && n as usize >= nr) {
                return Err(DecodeError);
            }
        }
        let mut adjacency_end = 0;
        for i in 0..nr {
            let row = 4 + i * 2;
            let start = r.u32(row) as usize;
            let len = r.u32(row + 1) as usize;
            if start != adjacency_end {
                return Err(DecodeError);
            }
            within(start, len, a.len())?;
            adjacency_end = start + len;
            if g.f64(1 + i * 4 + 2) < 0.0 || g.f64(1 + i * 4 + 3) < 0.0 {
                return Err(DecodeError);
            }
            for (slot, j) in (start..adjacency_end).enumerate() {
                let p = a.u32(j) as usize;
                if p >= np {
                    return Err(DecodeError);
                }
                let pr = 4 + nr * 2 + p * 6;
                if !(0..2).any(|side| {
                    r.u32(pr + side) as usize == i && r.u32(pr + 2 + side) as usize == slot
                }) {
                    return Err(DecodeError);
                }
            }
        }
        let mut stands_end = 0;
        for i in 0..np {
            let row = 4 + nr * 2 + i * 6;
            let start = r.u32(row + 4) as usize;
            let len = r.u32(row + 5) as usize;
            if start != stands_end {
                return Err(DecodeError);
            }
            within(start, len, s.len() / 2)?;
            stands_end = start + len;
            for side in 0..2 {
                let region = r.u32(row + side) as usize;
                let slot = r.u32(row + 2 + side) as usize;
                if region >= nr {
                    return Err(DecodeError);
                }
                let rr = 4 + region * 2;
                let start = r.u32(rr) as usize;
                let len = r.u32(rr + 1) as usize;
                if slot >= len || a.u32(start + slot) as usize != i {
                    return Err(DecodeError);
                }
            }
        }
        if adjacency_end != a.len() || stands_end != s.len() / 2 {
            return Err(DecodeError);
        }
        Ok(())
    }
}

impl<'a> Layer<'a> {
    pub fn clearance(&self) -> f64 {
        self.config.f64(0)
    }

    pub fn tile(&self, index: usize) -> Option<Tile<'a>> {
        if index >= self.dims.u32(1) as usize {
            return None;
        }
        let r = |at| self.rows.u32(index * 10 + at) as usize;
        let g = |at| self.geometry.f64(index * 8 + at);
        let (ip, tl, sl, il) = (r(2), r(3), r(4), r(5));
        let starts = ip + tl * 2;
        let items = starts + sl;
        Some(Tile {
            bounds: [g(3), g(4), g(5), g(6)],
            reach: g(7),
            points: self.points.slice(r(0), r(1)),
            compact: self.compact,
            triangles: self.ints.slice(ip, tl),
            twins: self.ints.slice(ip + tl, tl),
            locator_origin: [g(0), g(1)],
            locator_size: g(2),
            locator_dimensions: [r(6), r(7)],
            locator_starts: self.ints.slice(starts, sl),
            locator_items: self.ints.slice(items, il),
            triangle_gate_sets: self.ints.slice(items + il, tl / 3),
            gate_sets: self.sets.slice(r(8) * 2, r(9) * 2),
            gate_members: self.members,
        })
    }

    fn validate(self, o: &ValidationOptions<'_>) -> Result<()> {
        let (c, d, r, g, p, ints, sets, members) = (
            self.config,
            self.dims,
            self.rows,
            self.geometry,
            self.points,
            self.ints,
            self.sets,
            self.members,
        );
        let count = mul(o.grid_cols, o.grid_rows)?;
        if c.len() != 2
            || d.len() != 2
            || c.f64(1) != o.grid_size
            || d.u32(0) as usize != o.grid_cols
            || d.u32(1) as usize != count
            || r.len() != mul(count, 10)?
            || g.len() != mul(count, 8)?
            || sets.len() % 2 != 0
        {
            return Err(DecodeError);
        }
        finite(g)?;
        if !self.compact {
            finite(p)?;
        }
        for i in 0..members.len() {
            if members.u32(i) as usize >= o.gate_count {
                return Err(DecodeError);
            }
        }
        let mut members_end = 0;
        for i in (0..sets.len()).step_by(2) {
            let start = sets.u32(i) as usize;
            let len = sets.u32(i + 1) as usize;
            if start != members_end {
                return Err(DecodeError);
            }
            within(start, len, members.len())?;
            members_end = start + len;
        }
        if members_end != members.len() {
            return Err(DecodeError);
        }
        let (mut pe, mut ie, mut se) = (0, 0, 0);
        for i in 0..count {
            let row = i * 10;
            let geo = i * 8;
            let mut v = [0usize; 10];
            for (j, value) in v.iter_mut().enumerate() {
                *value = r.u32(row + j) as usize;
            }
            let [fp, fl, ip, tl, sl, il, lc, lr, set_at, set_count] = v;
            let int_count = add(add(add(mul(tl, 2)?, sl)?, il)?, tl / 3)?;
            if fp != pe || ip != ie || set_at != se {
                return Err(DecodeError);
            }
            within(fp, fl, p.len())?;
            within(ip, int_count, ints.len())?;
            within(set_at, set_count, sets.len() / 2)?;
            pe = add(pe, fl)?;
            ie = add(ie, int_count)?;
            se = add(se, set_count)?;
            let x = (i % o.grid_cols) as f64 * o.grid_size;
            let y = (i / o.grid_cols) as f64 * o.grid_size;
            if fl % 2 != 0
                || tl % 3 != 0
                || sl != add(mul(lc, lr)?, 1)?
                || g.f64(geo + 2) <= 0.0
                || g.f64(geo + 7) < 0.0
                || g.f64(geo + 3) != x
                || g.f64(geo + 4) != y
                || g.f64(geo + 5) != o.grid_size.min(o.width - x)
                || g.f64(geo + 6) != o.grid_size.min(o.height - y)
            {
                return Err(DecodeError);
            }
            if self.compact {
                let maxx = (g.f64(geo + 5) * POINT_SCALE).round();
                let maxy = (g.f64(geo + 6) * POINT_SCALE).round();
                for j in (fp..fp + fl).step_by(2) {
                    if p.u16(j) as f64 > maxx || p.u16(j + 1) as f64 > maxy {
                        return Err(DecodeError);
                    }
                }
            }
            for j in 0..tl {
                let v = ints.i32(ip + j);
                let twin = ints.i32(ip + tl + j);
                if v < 0
                    || v as usize >= fl / 2
                    || twin < -1
                    || (twin >= 0
                        && (twin as usize >= tl
                            || i64::from(ints.i32(ip + tl + twin as usize)) != j as i64))
                {
                    return Err(DecodeError);
                }
            }
            let starts = ip + tl * 2;
            let items = starts + sl;
            let gates = items + il;
            if ints.i32(starts) != 0 || i64::from(ints.i32(starts + sl - 1)) != il as i64 {
                return Err(DecodeError);
            }
            for j in 1..sl {
                if ints.i32(starts + j) < ints.i32(starts + j - 1)
                    || ints.i32(starts + j) as i64 > il as i64
                {
                    return Err(DecodeError);
                }
            }
            for j in 0..il {
                let v = ints.i32(items + j);
                if v < 0 || v as usize >= tl / 3 {
                    return Err(DecodeError);
                }
            }
            for j in 0..tl / 3 {
                let v = ints.i32(gates + j);
                if v < -1 || (v >= 0 && v as usize >= set_count) {
                    return Err(DecodeError);
                }
            }
        }
        if pe != p.len() || ie != ints.len() || se != sets.len() / 2 {
            return Err(DecodeError);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32s(values: &[u32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }
    fn f64s(values: &[f64]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }
    fn package(version: u32, roles: &[f64], graph: bool) -> Vec<u8> {
        let mut sections = vec![u32s(&[u32::from(graph), roles.len() as u32])];
        if graph {
            sections.extend([
                f64s(&[
                    96.0, 0.0, 0.0, 96.0, 192.0, 96.0, 0.0, 96.0, 192.0, 96.0, 48.0,
                ]),
                u32s(&[2, 2, 2, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1]),
                u32s(&[0, 1, u32::MAX, 1]),
                u32s(&[0, 0]),
                f64s(&[94.0, 48.0]),
            ]);
        }
        for &role in roles {
            let points = if version == 1 {
                f64s(&[0.0, 0.0, 1.5, 0.0, 0.0, 1.5])
            } else {
                [0u16, 0, 384, 0, 0, 384]
                    .into_iter()
                    .flat_map(u16::to_le_bytes)
                    .collect()
            };
            sections.extend([
                f64s(&[role, 192.0]),
                u32s(&[1, 1]),
                u32s(&[0, 6, 0, 3, 2, 1, 1, 1, 0, 1]),
                f64s(&[0.0, 0.0, 1.0, 0.0, 0.0, 192.0, 192.0, 0.0]),
                points,
                u32s(&[0, 1, 2, u32::MAX, u32::MAX, u32::MAX, 0, 1, 0, 0]),
                u32s(&[0, 2]),
                u32s(&[1, 0]),
            ]);
        }
        let mut bytes = vec![0; 8 + sections.len() * 8];
        bytes[0..4].copy_from_slice(&version.to_le_bytes());
        bytes[4..8].copy_from_slice(&(sections.len() as u32).to_le_bytes());
        for (i, section) in sections.iter().enumerate() {
            bytes.resize(bytes.len().next_multiple_of(8), 0);
            let offset = bytes.len() as u32;
            bytes[8 + i * 8..12 + i * 8].copy_from_slice(&offset.to_le_bytes());
            bytes[12 + i * 8..16 + i * 8].copy_from_slice(&(section.len() as u32).to_le_bytes());
            bytes.extend(section);
        }
        bytes
    }
    fn options(clearances: &[f64], single_role: bool) -> ValidationOptions<'_> {
        ValidationOptions {
            width: 192.0,
            height: 192.0,
            grid_size: 192.0,
            grid_cols: 1,
            grid_rows: 1,
            gate_count: 2,
            clearances,
            single_role,
        }
    }
    #[test]
    fn graphless_versions_and_cached_layout() {
        for (version, roles, single) in [
            (1, vec![25.0, 14.0], false),
            (2, vec![25.0, 14.0], false),
            (2, vec![14.0], true),
        ] {
            let bytes = package(version, &roles, false);
            let map = RuntimeMap::parse(&bytes, options(&roles, single)).unwrap();
            assert!(map.graph().is_none());
            assert_eq!(map.layer_count(), roles.len());
            let layout = map.into_layout();
            let rebound = unsafe { layout.bind(&bytes) };
            let layer = rebound.layer(0).unwrap();
            assert_eq!(layer.clearance(), roles[0]);
            let tile = layer.tile(0).unwrap();
            assert_eq!(tile.point(1), Some([1.5, 0.0]));
            assert_eq!(tile.triangles.i32(2), 2);
            assert_eq!(tile.twins.i32(0), -1);
            assert_eq!(tile.locator_starts.i32(1), 1);
            assert_eq!(tile.gate_set(0).unwrap().u32(0), 1);
            assert_eq!(tile.gate_set(0).unwrap().u32(1), 0);
        }
    }

    #[test]
    fn graph_exposes_ordered_regions_portals_and_stands() {
        let roles = [25.0, 14.0];
        let bytes = package(1, &roles, true);
        let map = RuntimeMap::parse(&bytes, options(&roles, false)).unwrap();
        let graph = map.graph().unwrap();
        assert_eq!(graph.grid(), (96.0, 2, 2));
        assert_eq!(graph.owner.i32(2), -1);
        assert_eq!(graph.region(1).unwrap().portals.u32(0), 0);
        let portal = graph.portal(0).unwrap();
        assert_eq!(portal.regions, [0, 1]);
        assert_eq!(portal.slots, [0, 0]);
        assert_eq!(portal.stands().collect::<Vec<_>>(), [[94.0, 48.0]]);

        let mut bad = bytes;
        let graph_rows = u32::from_le_bytes(bad[24..28].try_into().unwrap()) as usize;
        bad[graph_rows + 11 * 4..graph_rows + 12 * 4].copy_from_slice(&1u32.to_le_bytes());
        assert!(RuntimeMap::parse(&bad, options(&roles, false)).is_err());
    }
    #[test]
    fn rejects_truncation_bad_directory_and_bad_references() {
        let roles = [14.0];
        let bytes = package(2, &roles, false);
        for n in 0..bytes.len() {
            assert!(RuntimeMap::parse(&bytes[..n], options(&roles, true)).is_err());
        }
        let mut bad = bytes.clone();
        bad[8] = 0;
        assert!(RuntimeMap::parse(&bad, options(&roles, true)).is_err());
        let mut bad = bytes.clone();
        let rows = u32::from_le_bytes(bad[32..36].try_into().unwrap()) as usize;
        bad[rows + 16..rows + 20].copy_from_slice(&0u32.to_le_bytes());
        assert!(RuntimeMap::parse(&bad, options(&roles, true)).is_err());
        assert!(RuntimeMap::parse(&package(1, &roles, false), options(&roles, true)).is_err());
    }
}
