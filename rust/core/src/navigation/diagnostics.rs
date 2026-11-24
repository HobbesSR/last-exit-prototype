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
///
/// # Safety
/// The navigation handle is live. Flags points to len initialized bytes for this call.
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

/// Advances one slice and returns the total expansions so far.
///
/// # Safety
/// The diagnostic handle is live and exclusive.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_route_advance(handle: *mut RouteDiagnostic, limit: usize) -> usize {
    // SAFETY: the caller supplies exclusive access to the live search.
    let diagnostic = unsafe { &mut *handle };
    if diagnostic.output.is_empty()
        && let Some(route) = diagnostic.search.advance(limit)
    {
        diagnostic.output = encode(route);
    }
    diagnostic.search.expansions()
}

/// # Safety
/// The diagnostic handle is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_route_output_len(handle: *const RouteDiagnostic) -> usize {
    // SAFETY: the caller supplies a live search.
    unsafe { (*handle).output.len() }
}

/// # Safety
/// The handle is live. The returned pointer is read-only and valid until the handle is freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_route_output(handle: *const RouteDiagnostic) -> *const f64 {
    // SAFETY: the caller supplies a live search.
    unsafe { (*handle).output.as_ptr() }
}

/// # Safety
/// The handle came from a route start call and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_route_free(handle: *mut RouteDiagnostic) {
    // SAFETY: the caller owns the search.
    drop(unsafe { Box::from_raw(handle) });
}

pub struct CorridorDiagnostic {
    map: Rc<RuntimeNavigation>,
    corridor: Option<Corridor>,
}

/// # Safety
/// The navigation handle is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_corridor_new(
    navigation: *const Rc<RuntimeNavigation>,
) -> *mut CorridorDiagnostic {
    // SAFETY: the caller lends the live handle.
    let map = Rc::clone(unsafe { &*navigation });
    Box::into_raw(Box::new(CorridorDiagnostic {
        map,
        corridor: None,
    }))
}

/// # Safety
/// The handle is live and exclusive. Out points to two writable aligned f64 words.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_corridor_leg(
    handle: *mut CorridorDiagnostic,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    out: *mut [f64; 2],
) {
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
/// The handle is live and exclusive.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_corridor_abandon(handle: *mut CorridorDiagnostic) {
    // SAFETY: the caller supplies exclusive access to the live handle.
    Corridor::abandon(unsafe { &mut (*handle).corridor });
}

/// # Safety
/// The handle came from core_corridor_new and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn core_corridor_free(handle: *mut CorridorDiagnostic) {
    // SAFETY: the caller owns the handle.
    drop(unsafe { Box::from_raw(handle) });
}
