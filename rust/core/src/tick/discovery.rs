//! What contestants learn at the close of a tick (27.2 R11, R12; 27.1 D17, D23, D26).
//!
//! The runner says who learns and from where, then applies it to each contestant's [`Memory`]
//! through `crate::discovery`, the rule `shared/discovery.ts` also runs. Both run after the
//! terminal check and rewind capture, from the committed state, so what is learned in T first
//! shapes intent at T+1. A projection of T pairs T's snapshot with the memory after T's
//! discovery, since both are the close of T (D27).

use std::collections::{BTreeMap, BTreeSet};

use super::{
    ActorId, ActorKind, Carried, EquipmentKind, GateId, GroundItem, Inbound, ItemId, Loot, Point,
    State, Tick,
};
use crate::discovery::{DiscoveryMap, HEADER};
use crate::sight::{GateSet, SightIndex};

/// Each contestant samples once in this many ticks. Replay folding uses the same interval
/// (`DISCOVERY_INTERVAL` in `shared/discovery.ts`).
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

/// How far a line-of-sight sample sees (`DISCOVERY_RADIUS` in `shared/discovery.ts`).
pub const DISCOVERY_RADIUS: f64 = 1200.0;

/// A door as one contestant last observed it, never the live gate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DoorMemory {
    pub open: bool,
    pub locked: bool,
}

/// An item as it was last seen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RememberedItem {
    pub at: Point,
    pub item: GroundItem,
}

/// One contestant's discovery memory (`DiscoveryMemory` in `shared/types.ts`). Everyone learns the
/// view window's geometry. Bots also sample with line of sight, which fills in the rest.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Memory {
    /// Cells whose geometry the view window or a beacon has shown: what the minimap draws.
    pub discovered: BTreeSet<u32>,
    /// Cells a bot has had in line of sight.
    pub seen: BTreeSet<u32>,
    /// Seen cells in the order successive samples first observed them.
    pub seen_order: Vec<u32>,
    /// Every cell a bot's view window has covered: the layout its navigation may treat as known.
    pub surveyed: BTreeSet<u32>,
    /// Keyed by ID for the sorted memory projection.
    pub items: BTreeMap<ItemId, RememberedItem>,
    /// Remembered item IDs in first-observed order, excluding forgotten items.
    pub item_order: Vec<ItemId>,
    pub gates: BTreeMap<GateId, DoorMemory>,
    /// Counts each change, so a plan made before one is known to be stale.
    pub revision: u64,
}

impl Memory {
    /// `observeGate`: whether the memory changed.
    fn observe(&mut self, gate: GateId, door: DoorMemory) -> bool {
        self.gates.insert(gate, door) != Some(door)
    }
}

fn is_cell(item: &GroundItem) -> bool {
    matches!(
        item.loot,
        Loot::Equipment(equipment) if matches!(equipment.kind, EquipmentKind::Cell { .. })
    )
}

/// The map's discovery tables, plus the sight index and gate set its line-of-sight samples cast
/// through. These are the match's own copies, since a sample writes the polygon buffers.
pub(super) struct Sampler {
    map: DiscoveryMap,
    sight: SightIndex,
    gates: GateSet,
}

impl Sampler {
    pub(super) fn new(map: DiscoveryMap, sight: SightIndex, gates: GateSet) -> Self {
        Self { map, sight, gates }
    }

    /// `discover` for one eye. Packs what the sample reads near the eye, runs the rule and applies
    /// what it learned in the rule's order. `ground` lists every placed ground item with its pose.
    pub(super) fn sample(
        &mut self,
        memory: &mut Memory,
        eye: Point,
        sighted: bool,
        state: &State,
        ground: &[(ItemId, Point, GroundItem)],
    ) {
        let [cols, rows, cell] = self.map.grid();
        let radius = DISCOVERY_RADIUS;
        let [ex, ey] = eye;
        let within = |[x, y]: Point| {
            let (dx, dy) = (x - ex, y - ey);
            dx * dx + dy * dy <= radius * radius
        };
        let mut near = Vec::new();
        let mut held = Vec::new();
        let mut doors = Vec::new();
        let (mut c0, mut c1, mut r0, mut r1) = (0.0, -1.0, 0.0, -1.0);
        if sighted {
            near.extend(ground.iter().filter(|(_, at, _)| within(*at)).copied());
            // Remembered cells are always rechecked, then other remembered items in reach.
            held.extend(
                memory
                    .items
                    .iter()
                    .filter(|(_, m)| is_cell(&m.item))
                    .map(|(&id, m)| (id, m.at)),
            );
            held.extend(
                memory
                    .items
                    .iter()
                    .filter(|(_, m)| !is_cell(&m.item) && within(m.at))
                    .map(|(&id, m)| (id, m.at)),
            );
            doors.extend(
                self.gates
                    .boxes
                    .iter()
                    .enumerate()
                    .filter(|&(_, &[x, y, w, h])| {
                        x <= ex + radius
                            && ex - radius <= x + w
                            && y <= ey + radius
                            && ey - radius <= y + h
                    })
                    .map(|(index, &door)| (GateId(index as u32), door)),
            );
            let min_col = ((ex - radius) / cell).floor().max(0.0);
            let max_col = ((ex + radius) / cell).floor().min(cols - 1.0);
            let min_row = ((ey - radius) / cell).floor().max(0.0);
            let max_row = ((ey + radius) / cell).floor().min(rows - 1.0);
            if min_col <= max_col && min_row <= max_row {
                (c0, c1, r0, r1) = (min_col, max_col, min_row, max_row);
            }
        }

        let width = (c1 - c0 + 1.0) as usize;
        let height = (r1 - r0 + 1.0) as usize;
        let len = HEADER + (near.len() + held.len()) * 2 + doors.len() * 4 + width * height;
        let input = self.map.input(len);
        input[..HEADER].copy_from_slice(&[
            ex,
            ey,
            radius,
            f64::from(u8::from(sighted)),
            near.len() as f64,
            held.len() as f64,
            doors.len() as f64,
            c0,
            c1,
            r0,
            r1,
        ]);
        let mut at = HEADER;
        let points = near
            .iter()
            .map(|&(_, p, _)| p)
            .chain(held.iter().map(|&(_, p)| p));
        for [x, y] in points {
            input[at] = x;
            input[at + 1] = y;
            at += 2;
        }
        for (_, door) in &doors {
            input[at..at + 4].copy_from_slice(door);
            at += 4;
        }
        for row in 0..height {
            for col in 0..width {
                let index = (r0 as usize + row) * cols as usize + c0 as usize + col;
                input[at] = f64::from(u8::from(memory.seen.contains(&(index as u32))));
                at += 1;
            }
        }
        for (index, open) in self.gates.open.iter_mut().enumerate() {
            *open = u8::from(
                state
                    .gates
                    .get(&GateId(index as u32))
                    .is_some_and(|gate| gate.open),
            );
        }
        let sight = sighted.then_some((&mut self.sight, &mut self.gates));
        let out = self.map.sample(sight).to_vec();

        let mut at = 2;
        let mut list = || {
            let count = out[at] as usize;
            at += 1 + count;
            &out[at - count..at]
        };
        let found = list();
        let surveyed = list();
        let seen = list();
        let mut flags = out[at..].iter().map(|&flag| flag != 0);
        let mut changed = false;
        let mut discovered = false;
        for &index in found {
            discovered |= memory.discovered.insert(index);
        }
        if sighted {
            for &index in surveyed {
                changed |= memory.surveyed.insert(index);
            }
        }
        for &index in seen {
            if memory.seen.insert(index) {
                memory.seen_order.push(index);
            }
        }
        if sighted {
            let mut present = BTreeSet::new();
            for &(id, at, item) in &near {
                if flags.next().expect("item flag") {
                    present.insert(id);
                    if memory
                        .items
                        .insert(id, RememberedItem { at, item })
                        .is_none()
                    {
                        memory.item_order.push(id);
                    }
                }
            }
            for &(id, _) in &held {
                if flags.next().expect("remembered flag") && !present.contains(&id) {
                    if memory.items.remove(&id).is_some() {
                        memory.item_order.retain(|&item| item != id);
                    }
                }
            }
            for &(gate, _) in &doors {
                if flags.next().expect("door flag")
                    && let Some(record) = state.gates.get(&gate)
                {
                    changed |= memory.observe(
                        gate,
                        DoorMemory {
                            open: record.open,
                            locked: record.locked,
                        },
                    );
                }
            }
        }
        if changed || discovered {
            memory.revision += 1;
        }
    }
}

/// Applies a tick's discovery to the contestants' memory: direct gate observations, then the
/// samples, each in canonical order. Without a sampler only the gate observations are learned.
pub(super) fn remember(
    discovery: &Discovery,
    state: &State,
    sampler: Option<&mut Sampler>,
    ground: impl FnOnce() -> Vec<(ItemId, Point, GroundItem)>,
    memory: &mut BTreeMap<ActorId, Memory>,
) {
    for observation in &discovery.gates {
        let memory = memory.entry(observation.actor).or_default();
        let door = DoorMemory {
            open: observation.open,
            locked: observation.locked,
        };
        if memory.observe(observation.gate, door) {
            memory.revision += 1;
        }
    }
    let Some(sampler) = sampler else {
        return;
    };
    let bot = |actor: ActorId| state.actors.get(&actor).is_some_and(|actor| actor.bot);
    // Only a line-of-sight sample reads the ground, so a tick without one skips the scan.
    let ground = if discovery.samples.iter().any(|sample| bot(sample.actor)) {
        ground()
    } else {
        Vec::new()
    };
    for sample in &discovery.samples {
        let memory = memory.entry(sample.actor).or_default();
        sampler.sample(memory, sample.eye, bot(sample.actor), state, &ground);
    }
}
