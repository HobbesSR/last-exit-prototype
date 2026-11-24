//! Room-owned storage for the validated flat navigation packages (27, #1318).

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
    bounds: [f64; 4],
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
        bounds == Some(self.bounds) && gate_count == self.gate_count
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
        bounds: [0.0, 0.0, width, height],
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
