//! What contestants learn at the close of a tick (27.2 R11, R12; 27.1 D17, D23, D26).
//!
//! The runner says who learns and from where; the memory and the sample's sight computation
//! stay with the adapter and `crate::discovery` until 3c. Both run after the terminal check and
//! rewind capture, from the committed state, so what is learned in T first shapes intent at T+1.

use super::{ActorId, ActorKind, Carried, GateId, Inbound, Point, Tick};

/// Each contestant samples once in this many ticks (`DISCOVERY_INTERVAL` in
/// `shared/discovery.ts`, which keeps it until the cutover).
pub const DISCOVERY_INTERVAL: Tick = 10;

/// A gate an actor's own attempt saw in T−1, learned in T even when the attempt failed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GateObservation {
    pub actor: ActorId,
    pub gate: GateId,
    pub open: bool,
    pub locked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DiscoverySample {
    pub actor: ActorId,
    /// The committed pose after apply, including a same-tick warp.
    pub eye: Point,
}

/// Applied in order: direct gate observations, then periodic samples, each in canonical order.
#[derive(Debug, Default, PartialEq)]
pub struct Discovery {
    pub gates: Vec<GateObservation>,
    pub samples: Vec<DiscoverySample>,
}

/// Contestants' direct gate observations carried into this tick.
pub(super) fn gate_observations(inbound: &[Inbound]) -> Vec<GateObservation> {
    let mut gates: Vec<_> = inbound
        .iter()
        .filter_map(|entry| match *entry {
            Inbound::Carried(Carried::GateObserved {
                actor,
                gate,
                open,
                locked,
            }) if actor.kind == ActorKind::Contestant => Some(GateObservation {
                actor,
                gate,
                open,
                locked,
            }),
            _ => None,
        })
        .collect();
    gates.sort_by_key(|observation| (observation.actor, observation.gate));
    gates
}

/// The stagger rotates the canonical contestant order's starting point by tick, so each
/// contestant samples once per interval whatever the roster (R11, D26). `contestants` is the
/// canonical order of every contestant, with the committed pose of those still active.
pub(super) fn samples(
    tick: Tick,
    contestants: impl Iterator<Item = (ActorId, Option<Point>)>,
) -> Vec<DiscoverySample> {
    contestants
        .enumerate()
        .filter(|&(index, _)| (tick as usize + index).is_multiple_of(DISCOVERY_INTERVAL as usize))
        .filter_map(|(_, (actor, eye))| eye.map(|eye| DiscoverySample { actor, eye }))
        .collect()
}
