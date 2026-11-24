//! Route and corridor diagnostics for comparisons across the WASM boundary.

use super::{Knowledge, Route, RouteSearch, RouteStatus, portal::Corridor};
use crate::runtime_navigation::RuntimeNavigation;
use std::{ptr, rc::Rc, slice};

pub struct RouteDiagnostic {
    search: RouteSearch,
    output: Vec<f64>,
}

impl RouteDiagnostic {
    fn new(search: RouteSearch) -> *mut Self {
        Box::into_raw(Box::new(Self {
            search,
            output: Vec::new(),
        }))
    }
}

fn encode(route: &Route) -> Vec<f64> {
    let status = match route.status {
        RouteStatus::Complete => 0.0,
        RouteStatus::Speculative => 1.0,
        RouteStatus::NoKnownRoute => 2.0,
        RouteStatus::InvalidEndpoint => 3.0,
        RouteStatus::BudgetExhausted => 4.0,
    };
    let mut output = vec![
        status,
        route.length,
        route.expansions as f64,
        route.tiles as f64,
        route.revision as f64,
        route.keys as f64,
        route.points.len() as f64,
        route.prefix.len() as f64,
        route.doors.len() as f64,
    ];
    output.extend(route.points.iter().chain(&route.prefix).flatten().copied());
    output.extend(route.doors.iter().map(|gate| f64::from(gate.0)));
    output
}

/// Starts a diagnostic using one byte per public grid cell followed by one byte per gate slot:
/// cells are unknown/known (0/1); gates are unobserved, closed unlocked, closed locked, or open (0-3).
/// Returns null if either pointer is null or the input is refused.
///
/// # Safety
/// A non-null navigation handle is live. Non-null flags points to len initialized bytes.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn core_route_start(
    navigation: *const Rc<RuntimeNavigation>,
    clearance: f64,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    budget: usize,
    keys: usize,
    revision: u32,
    flags: *const u8,
    len: usize,
) -> *mut RouteDiagnostic {
    if navigation.is_null() || flags.is_null() {
        return ptr::null_mut();
    }
    // SAFETY: the caller lends the live handle and input for this call.
    let (map, flags) = unsafe { (&*navigation, slice::from_raw_parts(flags, len)) };
    let Some(knowledge) = Knowledge::from_flags(map, flags, keys, revision.into()) else {
        return ptr::null_mut();
    };
    RouteSearch::new(
        Rc::clone(map),
        clearance,
        knowledge,
        [from_x, from_y],
        [to_x, to_y],
        budget,
    )
    .map_or(ptr::null_mut(), RouteDiagnostic::new)
}

/// Advances one slice and returns the total expansions so far, or zero for a null handle.
///
/// # Safety
/// A non-null diagnostic handle is live and exclusive.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_route_advance(handle: *mut RouteDiagnostic, limit: usize) -> usize {
    // SAFETY: the caller supplies exclusive access to the live search.
    let Some(diagnostic) = (unsafe { handle.as_mut() }) else {
        return 0;
    };
    if diagnostic.output.is_empty()
        && let Some(route) = diagnostic.search.advance(limit)
    {
        diagnostic.output = encode(route);
    }
    diagnostic.search.expansions()
}

/// Returns the number of output words, or zero for a null handle.
///
/// # Safety
/// A non-null diagnostic handle is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_route_output_len(handle: *const RouteDiagnostic) -> usize {
    // SAFETY: the caller supplies a live search.
    unsafe { handle.as_ref() }.map_or(0, |diagnostic| diagnostic.output.len())
}

/// Returns a read-only pointer valid until the handle is freed, or null for a null handle.
///
/// # Safety
/// A non-null diagnostic handle is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_route_output(handle: *const RouteDiagnostic) -> *const f64 {
    // SAFETY: the caller supplies a live search.
    unsafe { handle.as_ref() }.map_or(ptr::null(), |diagnostic| diagnostic.output.as_ptr())
}

/// # Safety
/// A non-null handle came from a route start call and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_route_free(handle: *mut RouteDiagnostic) {
    if !handle.is_null() {
        // SAFETY: the caller owns the search.
        drop(unsafe { Box::from_raw(handle) });
    }
}

pub struct CorridorDiagnostic {
    map: Rc<RuntimeNavigation>,
    corridor: Option<Corridor>,
}

/// Returns null for a null navigation handle.
///
/// # Safety
/// A non-null navigation handle is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_corridor_new(
    navigation: *const Rc<RuntimeNavigation>,
) -> *mut CorridorDiagnostic {
    // SAFETY: the caller lends the live handle.
    let Some(navigation) = (unsafe { navigation.as_ref() }) else {
        return ptr::null_mut();
    };
    let map = Rc::clone(navigation);
    Box::into_raw(Box::new(CorridorDiagnostic {
        map,
        corridor: None,
    }))
}

/// Writes the leg endpoint when both pointers are non-null.
///
/// # Safety
/// A non-null handle is live and exclusive. Non-null out points to two writable aligned f64 words.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_corridor_leg(
    handle: *mut CorridorDiagnostic,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    out: *mut [f64; 2],
) {
    if handle.is_null() || out.is_null() {
        return;
    }
    // SAFETY: the caller supplies a live handle and writable output.
    let diagnostic = unsafe { &mut *handle };
    let leg = Corridor::leg_goal(
        &mut diagnostic.corridor,
        diagnostic.map.graph(),
        [from_x, from_y],
        [to_x, to_y],
    );
    unsafe { out.write(leg) };
}

/// # Safety
/// A non-null handle is live and exclusive.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_corridor_abandon(handle: *mut CorridorDiagnostic) {
    // SAFETY: the caller supplies exclusive access to the live handle.
    if let Some(diagnostic) = unsafe { handle.as_mut() } {
        Corridor::abandon(&mut diagnostic.corridor);
    }
}

/// # Safety
/// A non-null handle came from core_corridor_new and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_corridor_free(handle: *mut CorridorDiagnostic) {
    if !handle.is_null() {
        // SAFETY: the caller owns the handle.
        drop(unsafe { Box::from_raw(handle) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_handles_have_empty_output_and_leave_the_leg_unchanged() {
        let mut leg = [1.0, 2.0];
        // SAFETY: null handles are accepted. Leg is a live, aligned output buffer.
        unsafe {
            assert!(core_corridor_new(ptr::null()).is_null());
            core_corridor_leg(ptr::null_mut(), 0.0, 0.0, 3.0, 4.0, &mut leg);
            assert_eq!(leg, [1.0, 2.0]);
            core_corridor_abandon(ptr::null_mut());
            core_corridor_free(ptr::null_mut());
            assert_eq!(core_route_advance(ptr::null_mut(), 10), 0);
            assert_eq!(core_route_output_len(ptr::null()), 0);
            assert!(core_route_output(ptr::null()).is_null());
            core_route_free(ptr::null_mut());
        }
    }
}
