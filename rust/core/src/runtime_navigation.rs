//! Room-owned storage for the validated flat navigation packages (27, #1318).

use crate::navigation::Grid;
use crate::runtime_map::{Graph, Layer, RuntimeMap, RuntimeMapLayout, ValidationOptions};
use std::{ptr::NonNull, rc::Rc, slice};

struct Package {
    bytes: NonNull<u8>,
    len: usize,
    layout: RuntimeMapLayout,
}

impl Package {
    fn view(&self) -> RuntimeMap<'_> {
        // SAFETY: the allocation is owned here and is unchanged since validation.
        unsafe {
            self.layout
                .bind(slice::from_raw_parts(self.bytes.as_ptr(), self.len))
        }
    }
}

impl Drop for Package {
    fn drop(&mut self) {
        // SAFETY: this package owns a `core_alloc` buffer of exactly this size.
        unsafe { crate::core_free(self.bytes.as_ptr(), self.len) };
    }
}

/// The two clearances for a room. A deferred package stores contestant tiles separately.
pub struct RuntimeNavigation {
    primary: Package,
    contestant: Option<Package>,
    grid: Grid,
    gate_count: usize,
}

impl RuntimeNavigation {
    pub fn graph(&self) -> Option<Graph<'_>> {
        self.primary.view().graph()
    }

    pub fn layer(&self, clearance: f64) -> Option<Layer<'_>> {
        let primary = self.primary.view();
        (0..primary.layer_count())
            .filter_map(|i| primary.layer(i))
            .chain(self.contestant.as_ref().and_then(|p| p.view().layer(0)))
            .find(|layer| layer.clearance() == clearance)
    }

    pub(crate) fn matches(&self, bounds: Option<[f64; 4]>, gate_count: usize) -> bool {
        bounds == Some([0.0, 0.0, self.grid.width, self.grid.height])
            && gate_count == self.gate_count
    }

    pub(crate) fn grid(&self) -> Grid {
        self.grid
    }

    pub(crate) fn cell_count(&self) -> usize {
        self.grid.cols * self.grid.rows
    }

    pub(crate) fn gate_count(&self) -> usize {
        self.gate_count
    }
}

/// Validates and takes ownership of both uploaded buffers on success. With a deferred
/// package, `contestant` supplies the required, separately prepared contestant clearance.
/// A null return leaves ownership with the caller.
///
/// # Safety
/// Each supplied pointer is a distinct, fully initialized `core_alloc` allocation of the
/// stated length. An absent contestant pointer is null with zero length. On success the
/// caller may lend read-only views while the handle lives and must never write or free either buffer.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn runtime_navigation_new(
    primary: *mut u8,
    primary_len: usize,
    contestant: *mut u8,
    contestant_len: usize,
    width: f64,
    height: f64,
    grid_size: f64,
    grid_cols: usize,
    grid_rows: usize,
    gate_count: usize,
    gladiator_clearance: f64,
    contestant_clearance: f64,
) -> *mut Rc<RuntimeNavigation> {
    let refused = std::ptr::null_mut();
    let Some(primary) = NonNull::new(primary) else {
        return refused;
    };
    let contestant = NonNull::new(contestant);
    if contestant.is_none() != (contestant_len == 0)
        || contestant == Some(primary)
        || gladiator_clearance == contestant_clearance
    {
        return refused;
    }
    let deferred = contestant.is_some();
    let clearances = [gladiator_clearance, contestant_clearance];
    let options = |clearances| ValidationOptions {
        width,
        height,
        grid_size,
        grid_cols,
        grid_rows,
        gate_count,
        clearances,
        single_role: deferred,
    };
    // SAFETY: the upload buffers are fully initialized and live for this call.
    let primary_bytes = unsafe { slice::from_raw_parts(primary.as_ptr(), primary_len) };
    let Ok(primary_view) = RuntimeMap::parse(
        primary_bytes,
        options(if deferred {
            &clearances[..1]
        } else {
            &clearances
        }),
    ) else {
        return refused;
    };
    let contestant = if let Some(bytes) = contestant {
        // SAFETY: the second upload is also fully initialized and live for this call.
        let uploaded = unsafe { slice::from_raw_parts(bytes.as_ptr(), contestant_len) };
        let Ok(view) = RuntimeMap::parse(uploaded, options(&clearances[1..])) else {
            return refused;
        };
        if view.graph().is_some() {
            return refused;
        }
        Some(Package {
            bytes,
            len: contestant_len,
            layout: view.into_layout(),
        })
    } else {
        None
    };
    Box::into_raw(Box::new(Rc::new(RuntimeNavigation {
        primary: Package {
            bytes: primary,
            len: primary_len,
            layout: primary_view.into_layout(),
        },
        contestant,
        grid: Grid {
            width,
            height,
            size: grid_size,
            cols: grid_cols,
            rows: grid_rows,
        },
        gate_count,
    })))
}

/// Releases the room's reference. An attached match keeps its own reference.
///
/// # Safety
/// `navigation` came from `runtime_navigation_new` and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn runtime_navigation_free(navigation: *mut Rc<RuntimeNavigation>) {
    // SAFETY: the caller owns the handle.
    drop(unsafe { Box::from_raw(navigation) });
}

#[cfg(test)]
impl RuntimeNavigation {
    fn from_sections(
        sections: &[Vec<u8>],
        width: f64,
        height: f64,
        grid_size: f64,
        grid_cols: usize,
        grid_rows: usize,
        gate_count: usize,
    ) -> Rc<Self> {
        let mut bytes = vec![0; 8 + sections.len() * 8];
        bytes[0..4].copy_from_slice(&2u32.to_le_bytes());
        bytes[4..8].copy_from_slice(&(sections.len() as u32).to_le_bytes());
        for (i, section) in sections.iter().enumerate() {
            bytes.resize(bytes.len().next_multiple_of(8), 0);
            let offset = bytes.len() as u32;
            bytes[8 + i * 8..12 + i * 8].copy_from_slice(&offset.to_le_bytes());
            bytes[12 + i * 8..16 + i * 8].copy_from_slice(&(section.len() as u32).to_le_bytes());
            bytes.extend(section);
        }
        let ptr = crate::core_alloc(bytes.len());
        assert!(!ptr.is_null());
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
        let handle = unsafe {
            runtime_navigation_new(
                ptr,
                bytes.len(),
                std::ptr::null_mut(),
                0,
                width,
                height,
                grid_size,
                grid_cols,
                grid_rows,
                gate_count,
                25.0,
                14.0,
            )
        };
        assert!(!handle.is_null());
        unsafe { *Box::from_raw(handle) }
    }

    /// Builds a minimal `RuntimeNavigation` whose portal graph holds `regions` (`[x, y, w, h]`).
    pub(crate) fn for_regions(width: f64, height: f64, regions: &[[f64; 4]]) -> Rc<Self> {
        let u32s =
            |values: &[u32]| -> Vec<u8> { values.iter().flat_map(|v| v.to_le_bytes()).collect() };
        let f64s =
            |values: &[f64]| -> Vec<u8> { values.iter().flat_map(|v| v.to_le_bytes()).collect() };
        let grid_size = width.max(height);
        let nr = regions.len() as u32;
        let mut geom = Vec::with_capacity(1 + regions.len() * 4);
        geom.push(96.0);
        for r in regions {
            geom.extend_from_slice(r);
        }
        let mut rows = vec![1, 1, nr, 0];
        rows.resize(4 + regions.len() * 2, 0);
        let mut sections = vec![
            u32s(&[1, 2]),
            f64s(&geom),
            u32s(&rows),
            u32s(&[0]),
            Vec::new(),
            Vec::new(),
        ];
        for role in [25.0, 14.0] {
            let points: Vec<u8> = [0u16, 0, 384, 0, 0, 384]
                .into_iter()
                .flat_map(u16::to_le_bytes)
                .collect();
            sections.extend([
                f64s(&[role, grid_size]),
                u32s(&[1, 1]),
                u32s(&[0, 6, 0, 3, 2, 1, 1, 1, 0, 1]),
                f64s(&[0.0, 0.0, 1.0, 0.0, 0.0, width, height, 0.0]),
                points,
                u32s(&[0, 1, 2, u32::MAX, u32::MAX, u32::MAX, 0, 1, 0, 0]),
                u32s(&[0, 2]),
                u32s(&[1, 0]),
            ]);
        }
        Self::from_sections(&sections, width, height, grid_size, 1, 1, 2)
    }

    /// Builds a minimal `RuntimeNavigation` over a `cols x rows` grid of `192`-unit cells,
    /// assigning `cell_gate(col, row)` (when `Some(id)`) to every triangle in that cell.
    pub(crate) fn for_cells(
        cols: usize,
        rows: usize,
        gate_count: usize,
        cell_gate: impl Fn(usize, usize) -> Option<u32>,
    ) -> Rc<Self> {
        const CELL: f64 = 192.0;
        const EDGE: u16 = 192 * 256;
        let u32s =
            |values: &[u32]| -> Vec<u8> { values.iter().flat_map(|v| v.to_le_bytes()).collect() };
        let i32s =
            |values: &[i32]| -> Vec<u8> { values.iter().flat_map(|v| v.to_le_bytes()).collect() };
        let f64s =
            |values: &[f64]| -> Vec<u8> { values.iter().flat_map(|v| v.to_le_bytes()).collect() };
        let count = cols * rows;
        let width = cols as f64 * CELL;
        let height = rows as f64 * CELL;
        let mut sections = vec![u32s(&[0, 2])];
        for role in [25.0, 14.0] {
            let mut row_vals = Vec::with_capacity(count * 10);
            let mut geom_vals = Vec::with_capacity(count * 8);
            let mut point_vals = Vec::with_capacity(count * 8);
            let mut int_vals = Vec::with_capacity(count * 18);
            let mut set_vals = Vec::new();
            let mut member_vals = Vec::new();
            for row in 0..rows {
                for col in 0..cols {
                    let fp = point_vals.len() as u32;
                    let ip = int_vals.len() as u32;
                    let set_at = (set_vals.len() / 2) as u32;
                    let (gate_set, set_count) = match cell_gate(col, row) {
                        Some(gate) => {
                            let start = member_vals.len() as u32;
                            member_vals.push(gate);
                            set_vals.extend([start, 1]);
                            (0, 1)
                        }
                        None => (-1, 0),
                    };
                    row_vals.extend([fp, 8, ip, 6, 2, 2, 1, 1, set_at, set_count]);
                    let x = col as f64 * CELL;
                    let y = row as f64 * CELL;
                    geom_vals.extend([x, y, CELL, x, y, CELL, CELL, 0.0]);
                    point_vals.extend([0u16, 0, EDGE, 0, EDGE, EDGE, 0, EDGE]);
                    int_vals.extend([
                        0, 1, 3, 1, 2, 3, // triangles
                        -1, 5, -1, -1, -1, 1, // twins
                        0, 2, // locator_starts
                        0, 1, // locator_items
                        gate_set, gate_set, // triangle_gate_sets
                    ]);
                }
            }
            let points: Vec<u8> = point_vals.into_iter().flat_map(u16::to_le_bytes).collect();
            sections.extend([
                f64s(&[role, CELL]),
                u32s(&[cols as u32, count as u32]),
                u32s(&row_vals),
                f64s(&geom_vals),
                points,
                i32s(&int_vals),
                u32s(&set_vals),
                u32s(&member_vals),
            ]);
        }
        Self::from_sections(&sections, width, height, CELL, cols, rows, gate_count)
    }
}
