//! Resumable A* over known triangles and the public open-cell hypothesis.

use super::{
    Grid,
    geometry::{self, Point, Portal},
    side_edges,
};
use crate::{
    runtime_map::{Layer, Tile, Values},
    runtime_navigation::RuntimeNavigation,
    tick::{DoorMemory, Gate, GateId, Memory},
};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, BinaryHeap},
    rc::Rc,
};

pub const ROUTE_BUDGET: usize = 200_000;
const USED: usize = 16;

// The JS state order is cell, triangle (unknown first), then keys spent. The goal sorts first.
type SearchKey = Option<(Place, usize)>;
const GOAL: SearchKey = None;

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct Place {
    cell: usize,
    triangle: Option<usize>,
}

/// The cells and door states one search may read, frozen at its start.
#[derive(Clone)]
pub struct Knowledge {
    known: Vec<bool>,
    doors: Vec<Option<DoorMemory>>,
    keys: usize,
    revision: u64,
}

impl Knowledge {
    pub(crate) fn known(&self, cell: usize) -> bool {
        self.known.get(cell).copied().unwrap_or(false)
    }

    pub(crate) fn keys(&self) -> usize {
        self.keys
    }
    pub fn contestant(map: &RuntimeNavigation, memory: &Memory, keys: usize) -> Self {
        let mut known = vec![false; map.cell_count()];
        for &cell in memory.discovered.union(&memory.surveyed) {
            if let Some(cell) = known.get_mut(cell as usize) {
                *cell = true;
            }
        }
        let mut doors = vec![None; map.gate_count()];
        for (&GateId(slot), &door) in &memory.gates {
            if let Some(entry) = doors.get_mut(slot as usize) {
                *entry = Some(door);
            }
        }
        Self {
            known,
            doors,
            keys,
            revision: memory.revision,
        }
    }

    /// Full-information planning uses the current gate bits.
    pub fn complete(
        map: &RuntimeNavigation,
        gates: &BTreeMap<GateId, Gate>,
        keys: usize,
        revision: u64,
    ) -> Self {
        let mut doors = vec![None; map.gate_count()];
        for (&GateId(slot), gate) in gates {
            if let Some(entry) = doors.get_mut(slot as usize) {
                *entry = Some(DoorMemory {
                    open: gate.open,
                    locked: gate.locked,
                });
            }
        }
        Self {
            known: vec![true; map.cell_count()],
            doors,
            keys,
            revision,
        }
    }

    pub(super) fn from_flags(
        map: &RuntimeNavigation,
        flags: &[u8],
        keys: usize,
        revision: u64,
    ) -> Option<Self> {
        if flags.len() != map.cell_count() + map.gate_count() {
            return None;
        }
        let (cells, gates) = flags.split_at(map.cell_count());
        if cells.iter().any(|&value| value > 1) || gates.iter().any(|&value| value > 3) {
            return None;
        }
        Some(Self {
            known: cells.iter().map(|&flag| flag != 0).collect(),
            doors: gates
                .iter()
                .map(|&flag| {
                    (flag != 0).then_some(DoorMemory {
                        open: flag == 3,
                        locked: flag == 2,
                    })
                })
                .collect(),
            keys,
            revision,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteStatus {
    Complete,
    Speculative,
    NoKnownRoute,
    InvalidEndpoint,
    BudgetExhausted,
}

#[derive(Clone)]
pub struct Route {
    pub status: RouteStatus,
    pub points: Vec<Point>,
    pub length: f64,
    pub prefix: Vec<Point>,
    pub doors: Vec<GateId>,
    pub expansions: usize,
    pub tiles: usize,
    pub revision: u64,
    pub keys: usize,
}

#[derive(Clone, Copy)]
struct Endpoint {
    place: Place,
    point: Point,
    moved: bool,
}

#[derive(Clone)]
struct State {
    cost: f64,
    at: Point,
    parent: SearchKey,
    portal: Option<Portal>,
    confirmed: bool,
    spent: Vec<GateId>,
}

/// Shared A* order: lowest f, highest g, then lowest node number.
#[derive(Clone, Copy)]
pub(super) struct QueueEntry<N> {
    pub f: f64,
    pub g: f64,
    pub node: N,
}

impl<N: Ord> Ord for QueueEntry<N> {
    fn cmp(&self, other: &Self) -> Ordering {
        let compare = |a: f64, b: f64| a.partial_cmp(&b).unwrap_or_else(|| a.total_cmp(&b));
        compare(other.f, self.f)
            .then_with(|| compare(self.g, other.g))
            .then_with(|| other.node.cmp(&self.node))
    }
}

impl<N: Ord> PartialOrd for QueueEntry<N> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl<N: Ord> PartialEq for QueueEntry<N> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl<N: Ord> Eq for QueueEntry<N> {}

pub(super) use crate::math::distance;

fn gates<'a>(tile: &Tile<'a>, triangle: usize) -> Option<Values<'a>> {
    let set = tile.triangle_gate_sets.i32(triangle);
    (set >= 0).then(|| tile.gate_set(set as usize).unwrap())
}

struct Access {
    used: usize,
    confirmed: bool,
    spent: Vec<GateId>,
}

impl Access {
    fn unknown(used: usize) -> Self {
        Self {
            used,
            confirmed: false,
            spent: Vec::new(),
        }
    }
}

struct Expansion<'a> {
    key: SearchKey,
    state: State,
    used: usize,
    through: Option<Values<'a>>,
}

pub struct RouteSearch {
    map: Rc<RuntimeNavigation>,
    clearance: f64,
    knowledge: Knowledge,
    from: Point,
    to: Point,
    endpoints: Option<(Endpoint, Endpoint)>,
    budget: usize,
    expansions: usize,
    tiles: BTreeMap<usize, bool>,
    tiles_read: usize,
    sides: BTreeMap<usize, Rc<[Vec<usize>; 4]>>,
    states: BTreeMap<SearchKey, State>,
    closed: BTreeSet<SearchKey>,
    heap: BinaryHeap<QueueEntry<SearchKey>>,
    nearest: Option<(f64, SearchKey)>,
    done: Option<Route>,
}

impl RouteSearch {
    pub fn new(
        map: Rc<RuntimeNavigation>,
        clearance: f64,
        knowledge: Knowledge,
        from: Point,
        to: Point,
        budget: usize,
    ) -> Option<Self> {
        let layer = map.layer(clearance)?;
        let mut search = Self {
            map: Rc::clone(&map),
            clearance,
            knowledge,
            from,
            to,
            endpoints: None,
            budget,
            expansions: 0,
            tiles: BTreeMap::new(),
            tiles_read: 0,
            sides: BTreeMap::new(),
            states: BTreeMap::new(),
            closed: BTreeSet::new(),
            heap: BinaryHeap::new(),
            nearest: None,
            done: None,
        };
        let start = search.place_of(layer, from);
        let goal = search.place_of(layer, to);
        if let (Some(start), Some(goal)) = (start, goal) {
            search.endpoints = Some((start, goal));
            let access = start
                .place
                .triangle
                .and_then(|triangle| {
                    search.access(
                        gates(&layer.tile(start.place.cell).unwrap(), triangle),
                        0,
                        None,
                    )
                })
                .unwrap_or_else(|| Access::unknown(0));
            search.relax(
                Some((start.place, access.used)),
                State {
                    cost: 0.0,
                    at: start.point,
                    parent: GOAL,
                    portal: None,
                    confirmed: access.confirmed,
                    spent: access.spent,
                },
            );
        } else {
            search.done = Some(search.empty(RouteStatus::InvalidEndpoint));
        }
        Some(search)
    }

    pub fn expansions(&self) -> usize {
        self.expansions
    }

    fn grid(&self) -> Grid {
        self.map.grid()
    }

    fn tile<'a>(&mut self, layer: Layer<'a>, cell: usize) -> Option<Tile<'a>> {
        let grid = self.grid();
        let known = *self.tiles.entry(cell).or_insert_with(|| {
            let known = grid
                .support(cell, self.clearance)
                .all(|index| self.knowledge.known[index]);
            self.tiles_read += usize::from(known);
            known
        });
        known.then(|| layer.tile(cell).unwrap())
    }

    fn place_of(&mut self, layer: Layer<'_>, point: Point) -> Option<Endpoint> {
        let cell = self.grid().cell_at(point)?;
        if self.tile(layer, cell).is_none() {
            return Some(Endpoint {
                place: Place {
                    cell,
                    triangle: None,
                },
                point,
                moved: false,
            });
        }
        let mut best = None;
        let mut nearest = f64::INFINITY;
        for cell in self.grid().support(cell, self.clearance) {
            let Some(tile) = self.tile(layer, cell) else {
                continue;
            };
            if let Some((triangle, at, moved)) = geometry::entry(&tile, point, self.clearance + 1.0)
            {
                let d = distance(at, point);
                if d < nearest {
                    nearest = d;
                    best = Some(Endpoint {
                        place: Place {
                            cell,
                            triangle: Some(triangle),
                        },
                        point: at,
                        moved,
                    });
                }
            }
        }
        best
    }

    fn access(
        &self,
        target: Option<Values<'_>>,
        used: usize,
        through: Option<Values<'_>>,
    ) -> Option<Access> {
        let mut access = Access {
            used,
            confirmed: true,
            spent: Vec::new(),
        };
        if let Some(target) = target {
            for i in 0..target.len() {
                let gate = target.u32(i);
                let Some(seen) = self.knowledge.doors[gate as usize] else {
                    access.confirmed = false;
                    continue;
                };
                if seen.open
                    || !seen.locked
                    || through.is_some_and(|set| (0..set.len()).any(|i| set.u32(i) == gate))
                {
                    continue;
                }
                if access.used >= self.knowledge.keys.min(USED - 1) {
                    return None;
                }
                access.used += 1;
                access.spent.push(GateId(gate));
            }
        }
        Some(access)
    }

    fn relax(&mut self, key: SearchKey, state: State) {
        if self
            .states
            .get(&key)
            .is_some_and(|old| old.cost <= state.cost)
            || self.closed.contains(&key)
        {
            return;
        }
        let goal = self.endpoints.unwrap().1.point;
        self.heap.push(QueueEntry {
            f: state.cost + distance(goal, state.at),
            g: state.cost,
            node: key,
        });
        self.states.insert(key, state);
    }

    fn enter(&mut self, from: &Expansion<'_>, place: Place, edge: Portal, tile: Option<&Tile<'_>>) {
        let (access, centre) = if let Some(tile) = tile {
            let triangle = place.triangle.unwrap();
            let Some(access) = self.access(gates(tile, triangle), from.used, from.through) else {
                return;
            };
            (access, geometry::centre(tile, triangle))
        } else {
            let [x, y, w, h] = self.grid().bounds(place.cell);
            (Access::unknown(from.used), [x + w / 2.0, y + h / 2.0])
        };
        let [p, q] = edge;
        let crossing = geometry::closest(from.state.at, p, q);
        let oriented = if geometry::cross(p, q, centre) > 0.0 {
            edge
        } else {
            [q, p]
        };
        self.relax(
            Some((place, access.used)),
            State {
                cost: from.state.cost + distance(crossing, from.state.at),
                at: crossing,
                parent: from.key,
                portal: Some(oriented),
                confirmed: from.state.confirmed && access.confirmed,
                spent: access.spent,
            },
        );
    }

    /// Cross a public cell side, matching known mesh seams by overlap in edge-slot order.
    fn cross_side(
        &mut self,
        layer: Layer<'_>,
        from: &Expansion<'_>,
        cell: usize,
        side: usize,
        edge: Portal,
        known: bool,
    ) {
        let Some(next) = self.grid().neighbour(cell, side) else {
            return;
        };
        let Some(tile) = self.tile(layer, next) else {
            self.enter(
                from,
                Place {
                    cell: next,
                    triangle: None,
                },
                edge,
                None,
            );
            return;
        };
        let bounds = self.grid().bounds(next);
        let sides = self
            .sides
            .entry(next)
            .or_insert_with(|| Rc::new(side_edges(&tile, bounds)))
            .clone();
        for &slot in &sides[(side + 2) % 4] {
            let other = geometry::edge(&tile, slot);
            let crossing = if known {
                geometry::overlap(edge, other, side)
            } else {
                Some(other)
            };
            if let Some(crossing) = crossing {
                self.enter(
                    from,
                    Place {
                        cell: next,
                        triangle: Some(slot / 3),
                    },
                    crossing,
                    Some(&tile),
                );
            }
        }
    }

    fn expand(&mut self, layer: Layer<'_>, key: SearchKey) {
        let (place, used) = key.unwrap();
        let state = self.states[&key].clone();
        let goal = self.endpoints.unwrap().1;
        let h = distance(goal.point, state.at);
        if h < self.nearest.map_or(f64::INFINITY, |(nearest, _)| nearest) {
            self.nearest = Some((h, key));
        }
        if place.cell == goal.place.cell && place.triangle == goal.place.triangle {
            self.relax(
                GOAL,
                State {
                    cost: state.cost + h,
                    at: goal.point,
                    parent: key,
                    portal: None,
                    confirmed: state.confirmed,
                    spent: Vec::new(),
                },
            );
        }
        let bounds = self.grid().bounds(place.cell);
        if let Some(triangle) = place.triangle {
            // A state can reference a triangle only after the tile passed support gating.
            let tile = layer.tile(place.cell).unwrap();
            let from = Expansion {
                key,
                state,
                used,
                through: gates(&tile, triangle),
            };
            for slot in triangle * 3..triangle * 3 + 3 {
                let edge = geometry::edge(&tile, slot);
                let twin = tile.twins.i32(slot);
                if twin >= 0 {
                    self.enter(
                        &from,
                        Place {
                            cell: place.cell,
                            triangle: Some(twin as usize / 3),
                        },
                        edge,
                        Some(&tile),
                    );
                } else if let Some(side) = geometry::side_of(bounds, edge) {
                    self.cross_side(layer, &from, place.cell, side, edge, true);
                }
            }
        } else {
            let from = Expansion {
                key,
                state,
                used,
                through: None,
            };
            for side in 0..4 {
                self.cross_side(
                    layer,
                    &from,
                    place.cell,
                    side,
                    geometry::side_segment(bounds, side),
                    false,
                );
            }
        }
    }

    /// Resume for at most limit more places. A slice does not spend budget on stale heap entries.
    pub fn advance(&mut self, limit: usize) -> Option<&Route> {
        if self.done.is_none() {
            let map = Rc::clone(&self.map);
            let layer = map.layer(self.clearance).unwrap();
            let before = self.expansions;
            while self.expansions - before < limit {
                let Some(QueueEntry { node, g, .. }) = self.heap.pop() else {
                    break;
                };
                if self.closed.contains(&node) || g > self.states[&node].cost {
                    continue;
                }
                if node == GOAL {
                    self.done = Some(self.finish(GOAL, RouteStatus::Complete));
                    break;
                }
                if self.expansions >= self.budget {
                    let status = RouteStatus::BudgetExhausted;
                    self.done = Some(match self.nearest {
                        Some((_, key)) => self.finish(key, status),
                        None => self.empty(status),
                    });
                    break;
                }
                self.closed.insert(node);
                self.expansions += 1;
                self.expand(layer, node);
            }
            if self.done.is_none() && self.heap.is_empty() {
                self.done = Some(self.empty(RouteStatus::NoKnownRoute));
            }
        }
        self.done.as_ref()
    }

    fn empty(&self, status: RouteStatus) -> Route {
        Route {
            status,
            points: Vec::new(),
            length: f64::INFINITY,
            prefix: Vec::new(),
            doors: Vec::new(),
            expansions: self.expansions,
            tiles: self.tiles_read,
            revision: self.knowledge.revision,
            keys: self.knowledge.keys,
        }
    }

    fn finish(&self, end: SearchKey, status: RouteStatus) -> Route {
        let mut route = self.empty(status);
        let mut chain = Vec::new();
        let mut key = end;
        loop {
            let state = &self.states[&key];
            chain.push(state);
            if state.parent == GOAL {
                break;
            }
            key = state.parent;
        }
        chain.reverse();
        let (start, goal) = self.endpoints.unwrap();
        let target = self.states[&end].at;
        let portals: Vec<_> = chain
            .iter()
            .skip(1)
            .filter_map(|state| state.portal)
            .collect();
        let taut = geometry::pull_taut(start.point, target, &portals);
        let unconfirmed = chain.iter().position(|state| !state.confirmed);
        route.prefix = match unconfirmed {
            None => taut.clone(),
            Some(0) => vec![taut[0]],
            Some(index) => geometry::cut_at(&taut, &portals[..index]),
        };
        route.points = taut;
        if start.moved {
            route.points.insert(0, self.from);
            route.prefix.insert(0, self.from);
        }
        if end == GOAL && goal.moved {
            route.points.push(self.to);
            if unconfirmed.is_none() {
                route.prefix.push(self.to);
            }
        }
        if end == GOAL && unconfirmed.is_some() {
            route.status = RouteStatus::Speculative;
        }
        route.length = route
            .points
            .windows(2)
            .fold(0.0, |length, pair| length + distance(pair[1], pair[0]));
        route.doors = chain
            .iter()
            .flat_map(|state| state.spent.iter().copied())
            .collect();
        route
    }
}
