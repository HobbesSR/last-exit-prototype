//! Synchronous item counter calls (27, D6), independent of a physics world.
//! Input: mode (0 allocate, 1 ensure, 2 register), itemSerial, scatterSerial,
//! first unused label phase, metadata-valid flag, instance-known, lineage-known,
//! then the ten-word Item row. Output: status, counters, allocated ID, Item row,
//! and one registration fact (ID, phase); absent values are NaN.
use crate::action_types::{ABSENT_INSTANCE, Item, MAX_SAFE, safe};
use crate::drop_planner::Allocation;

#[derive(Default)]
pub struct ItemAllocation {
    input: Vec<f64>,
    output: Vec<f64>,
}

impl ItemAllocation {
    fn run(&mut self) -> *const f64 {
        let words = &self.input;
        let mode = words[0];
        let mut item = Item::read(&words[7..17]);
        let mut allocation = Allocation {
            item_serial: words[1],
            scatter_serial: words[2],
            phases: vec![words[3]],
            registered: Vec::new(),
            facts: Vec::new(),
        };
        if words[5] != 0.0 {
            allocation.registered.push(item.instance);
        }
        if words[6] != 0.0 {
            allocation.registered.push(item.lineage);
        }
        let mut status = 0.0;
        let mut id = f64::NAN;
        if mode == 2.0 {
            if !safe(allocation.item_serial)
                || allocation.item_serial < 1.0
                || allocation.item_serial >= MAX_SAFE
            {
                status = 2.0;
            } else {
                id = allocation.item_serial;
                allocation.item_serial += 1.0;
            }
        } else if mode == 1.0 && words[4] == 0.0 {
            status = 3.0;
        } else if mode == 0.0 || item.missing(ABSENT_INSTANCE) {
            if !safe(allocation.scatter_serial) || allocation.scatter_serial < 0.0 {
                status = 1.0;
            } else if let Some(allocated) = allocation.allocate() {
                id = allocated;
                if mode == 1.0 {
                    item.instance = allocated;
                    item.absent &= !ABSENT_INSTANCE;
                }
            } else {
                status = 2.0;
            }
        }
        if mode == 1.0 && status == 0.0 {
            // `ensure` fills lineage before resolving either label; preserve this on error.
            let ok = allocation.ensure(&mut item);
            if !ok {
                status = if !allocation.registered.contains(&item.instance) {
                    4.0
                } else {
                    5.0
                };
            }
        }
        self.output.clear();
        self.output.extend([
            status,
            allocation.item_serial,
            allocation.scatter_serial,
            id,
        ]);
        self.output.extend(item.row());
        self.output
            .extend(allocation.facts.first().copied().unwrap_or([f64::NAN; 2]));
        self.output.as_ptr()
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn item_allocation_new() -> *mut ItemAllocation {
    Box::into_raw(Box::new(ItemAllocation::default()))
}

/// # Safety
/// `state` is the live handle returned by `item_allocation_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn item_allocation_input(state: *mut ItemAllocation, len: usize) -> *mut f64 {
    let state = unsafe { &mut *state };
    state.input.resize(len, f64::NAN);
    state.input.as_mut_ptr()
}

/// # Safety
/// The handle has a complete seventeen-word input. Read the sixteen-word output
/// before another call reuses the same buffer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn item_allocation_run(state: *mut ItemAllocation) -> *const f64 {
    unsafe { &mut *state }.run()
}
