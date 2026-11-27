//! Bot-private route lifecycle, including sliced searches and local repair (22.6).

use crate::{
    math::distance,
    navigation::{Knowledge, RouteSearch, RouteStatus, closest, portal::Corridor},
    runtime_navigation::RuntimeNavigation,
    tick::{DoorMemory, GateId, Tick},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

type Point = [f64; 2];
const TILE: f64 = 40.0;
const REPATH: Tick = 20;
const REPLAN_AFTER: Tick = 100;
const SLICE: usize = 2_000;
const BUDGET: usize = 100_000;
const REPAIR_BUDGET: usize = 500;

struct Plan {
    goal: Point,
    from: Point,
    at: Tick,
    status: RouteStatus,
    keys: usize,
    doors: BTreeMap<GateId, DoorMemory>,
    watch: Vec<usize>,
    stale: bool,
    generation: u64,
}
struct Search {
    search: RouteSearch,
    knowledge: Knowledge,
    goal: Point,
    trail: Vec<Point>,
    doors: BTreeMap<GateId, DoorMemory>,
}

/// State belongs to a single bot and is discarded when its navigation map changes.
#[derive(Default)]
pub(crate) struct RouteState {
    pub route: Vec<Point>,
    /// Changes whenever a route is replaced or explicitly cleared, including local repair.
    pub generation: u64,
    plan: Option<Plan>,
    search: Option<Search>,
    corridor: Option<Corridor>,
}

fn unknown_along(
    map: &RuntimeNavigation,
    clearance: f64,
    knowledge: &Knowledge,
    points: &[Point],
) -> Vec<usize> {
    let grid = map.grid();
    let mut cells = BTreeSet::new();
    // Preserve first encounter order, like JavaScript's Set.
    let mut ordered = Vec::new();
    for pair in points.windows(2) {
        let steps = (distance(pair[0], pair[1]) / (grid.size / 4.0)).ceil() as usize;
        for k in 0..=steps {
            // JS's 0/0 yields NaN, which fails the bounds test.
            if steps == 0 {
                continue;
            }
            let t = k as f64 / steps as f64;
            let x = pair[0][0] + (pair[1][0] - pair[0][0]) * t;
            let y = pair[0][1] + (pair[1][1] - pair[0][1]) * t;
            if x >= 0.0 && y >= 0.0 && x < grid.width && y < grid.height {
                let cell =
                    (y / grid.size).floor() as usize * grid.cols + (x / grid.size).floor() as usize;
                if cells.insert(cell) && !grid.support(cell, clearance).all(|c| knowledge.known(c))
                {
                    ordered.push(cell);
                }
            }
        }
    }
    ordered
}

fn join_route(point: Point, points: &[Point], trail: &[Point], margin: f64) -> Vec<Point> {
    let walked: f64 = trail.windows(2).map(|p| distance(p[0], p[1])).sum();
    let (mut best, mut nearest, mut along) = (0, f64::INFINITY, 0.0);
    for (i, pair) in points.windows(2).enumerate() {
        if along > walked + TILE {
            break;
        }
        let d = distance(point, closest(point, pair[0], pair[1]));
        if d < nearest {
            nearest = d;
            best = i;
        }
        along += distance(pair[0], pair[1]);
    }
    if best + 1 < points.len() && nearest <= margin {
        return points[best + 1..].to_vec();
    }
    trail
        .iter()
        .skip(1)
        .rev()
        .copied()
        .chain(points.iter().copied())
        .collect()
}

impl RouteState {
    pub fn has_plan(&self) -> bool {
        self.plan.is_some()
    }

    #[cfg(test)]
    pub(super) fn pending_expansions(&self) -> Option<usize> {
        self.search
            .as_ref()
            .map(|running| running.search.expansions())
    }

    #[cfg(test)]
    pub(super) fn is_stale(&self) -> bool {
        self.plan.as_ref().is_some_and(|plan| plan.stale)
    }

    pub fn clear_route(&mut self) {
        self.route.clear();
        self.generation = self.generation.wrapping_add(1);
    }
    pub fn leg_goal(&mut self, map: &RuntimeNavigation, point: Point, target: Point) -> Point {
        Corridor::leg_goal(&mut self.corridor, map.graph(), point, target)
    }
    pub fn abandon_leg(&mut self) {
        Corridor::abandon(&mut self.corridor);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn repath(
        &mut self,
        map: Rc<RuntimeNavigation>,
        clearance: f64,
        body_radius: f64,
        knowledge: Knowledge,
        doors: &BTreeMap<GateId, DoorMemory>,
        gate_positions: &BTreeMap<GateId, Point>,
        contestant: bool,
        point: Point,
        target: Point,
        tick: Tick,
        player_index: usize,
        allowance: &mut usize,
    ) -> Option<RouteStatus> {
        let scheduled = (tick as usize + player_index).is_multiple_of(REPATH as usize);
        let mut due = self
            .plan
            .as_ref()
            .map_or(scheduled, |p| self.generation != p.generation);
        if !due
            && contestant
            && !self.route.is_empty()
            && self
                .plan
                .as_ref()
                .is_some_and(|p| distance(p.goal, target) < TILE && p.keys == knowledge.keys())
        {
            due = self.repair(
                &map,
                clearance,
                &knowledge,
                doors,
                gate_positions,
                point,
                allowance,
            ) == Some(false);
        }
        if !due && let Some(plan) = &self.plan {
            let grid = map.grid();
            let learnt = contestant
                && (plan.stale
                    || plan.doors != *doors
                    || plan
                        .watch
                        .iter()
                        .any(|&cell| grid.support(cell, clearance).all(|c| knowledge.known(c))));
            let changed =
                learnt || distance(plan.goal, target) >= TILE || plan.keys != knowledge.keys();
            let short = matches!(
                plan.status,
                RouteStatus::Speculative | RouteStatus::BudgetExhausted
            );
            due = if !self.route.is_empty() {
                scheduled && (changed || tick.saturating_sub(plan.at) >= REPLAN_AFTER)
            } else {
                changed
                    || short && distance(plan.from, point) >= 11.0
                    || scheduled && tick.saturating_sub(plan.at) >= REPATH
            };
        }
        if due
            && self.search.as_ref().is_none_or(|s| {
                distance(s.goal, target) >= TILE || s.knowledge.keys() != knowledge.keys()
            })
        {
            let search = RouteSearch::new(
                Rc::clone(&map),
                clearance,
                knowledge.clone(),
                point,
                target,
                BUDGET,
            )?;
            self.search = Some(Search {
                search,
                knowledge,
                goal: target,
                trail: Vec::new(),
                doors: if contestant {
                    doors.clone()
                } else {
                    BTreeMap::new()
                },
            });
        }
        let running = self.search.as_mut()?;
        if running
            .trail
            .last()
            .is_none_or(|&last| distance(last, point) >= 2.0)
        {
            running.trail.push(point);
        }
        if *allowance == 0 {
            return None;
        }
        let before = running.search.expansions();
        let result = running.search.advance(SLICE.min(*allowance)).cloned();
        *allowance -= running.search.expansions() - before;
        let result = result?;
        let running = self.search.take().unwrap();
        let points = join_route(
            point,
            &result.points,
            &running.trail,
            clearance - body_radius,
        );
        self.generation = self.generation.wrapping_add(1);
        self.route = points;
        self.plan = Some(Plan {
            goal: running.goal,
            from: point,
            at: tick,
            status: result.status,
            keys: running.knowledge.keys(),
            doors: running.doors,
            watch: if contestant {
                unknown_along(&map, clearance, &running.knowledge, &result.points)
            } else {
                Vec::new()
            },
            stale: false,
            generation: self.generation,
        });
        let status = result.status;
        Some(status)
    }

    #[allow(clippy::too_many_arguments)]
    fn repair(
        &mut self,
        map: &Rc<RuntimeNavigation>,
        clearance: f64,
        knowledge: &Knowledge,
        doors: &BTreeMap<GateId, DoorMemory>,
        gate_positions: &BTreeMap<GateId, Point>,
        point: Point,
        allowance: &mut usize,
    ) -> Option<bool> {
        let plan = self.plan.as_ref().unwrap();
        let mut changes = Vec::new();
        let mut opened = false;
        for (id, door) in doors {
            let old = plan.doors.get(id);
            if old == Some(door) {
                continue;
            }
            if let Some(&position) = gate_positions.get(id) {
                changes.push(position);
                opened |= old.is_some_and(|d| !d.open && d.locked);
            }
        }
        let grid = map.grid();
        for &cell in &plan.watch {
            if grid.support(cell, clearance).all(|c| knowledge.known(c)) {
                changes.push([
                    (cell % grid.cols) as f64 * grid.size + grid.size / 2.0,
                    (cell / grid.cols) as f64 * grid.size + grid.size / 2.0,
                ]);
            }
        }
        let points: Vec<_> = std::iter::once(point)
            .chain(self.route.iter().copied())
            .collect();
        let (mut reach, mut far) = (-1.0_f64, opened);
        for change in changes {
            let (mut nearest, mut at, mut along, mut ahead) =
                (f64::INFINITY, 0.0, 0.0, f64::INFINITY);
            for pair in points.windows(2) {
                let q = closest(change, pair[0], pair[1]);
                let d = distance(change, q);
                if d < nearest {
                    nearest = d;
                    at = along + distance(pair[0], q);
                }
                let length = distance(pair[0], pair[1]);
                if along < 384.0 {
                    let t = ((384.0 - along) / length.max(1e-9)).min(1.0);
                    let end = [
                        pair[0][0] + (pair[1][0] - pair[0][0]) * t,
                        pair[0][1] + (pair[1][1] - pair[0][1]) * t,
                    ];
                    ahead = ahead.min(distance(change, closest(change, pair[0], end)));
                }
                along += length;
            }
            if ahead.min(distance(point, change)) <= 192.0 {
                reach = reach.max(at);
            } else {
                far = true;
            }
        }
        if reach < 0.0 || *allowance < REPAIR_BUDGET {
            return None;
        }
        let mut rejoin = self.route.len() - 1;
        let mut along = 0.0;
        for (i, pair) in points.windows(2).enumerate() {
            along += distance(pair[0], pair[1]);
            if along >= reach + 576.0 {
                rejoin = i;
                break;
            }
        }
        let mut search = RouteSearch::new(
            Rc::clone(map),
            clearance,
            knowledge.clone(),
            point,
            self.route[rejoin],
            REPAIR_BUDGET,
        )?;
        let result = search.advance(REPAIR_BUDGET).cloned();
        // A budget boundary may require another advance to report exhaustion.
        let result = result.or_else(|| search.advance(1).cloned())?;
        *allowance -= result.expansions;
        let repaired = matches!(
            result.status,
            RouteStatus::Complete | RouteStatus::Speculative
        );
        if repaired {
            let mut route: Vec<_> = result
                .points
                .iter()
                .enumerate()
                .filter(|(i, p)| *i > 0 || distance(point, **p) >= 11.0)
                .map(|(_, &p)| p)
                .collect();
            route.extend_from_slice(&self.route[rejoin + 1..]);
            self.route = route;
            self.generation = self.generation.wrapping_add(1);
        }
        let running = self.search.take().is_some();
        let plan = self.plan.as_mut().unwrap();
        if repaired
            && result.status == RouteStatus::Speculative
            && plan.status == RouteStatus::Complete
        {
            plan.status = RouteStatus::Speculative;
        }
        plan.doors = doors.clone();
        plan.watch = unknown_along(
            map,
            clearance,
            knowledge,
            &std::iter::once(point)
                .chain(self.route.iter().copied())
                .collect::<Vec<_>>(),
        );
        plan.stale |= far || running || !repaired;
        plan.generation = self.generation;
        Some(repaired)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tick::Memory;

    // The planner keeps a route's legs a body's clearance from walls, 2 beyond a contestant's body (#473 review).
    const MARGIN: f64 = 2.0;
    const CONTESTANT_CLEARANCE: f64 = 14.0;
    const CONTESTANT_BODY_RADIUS: f64 = 12.0;
    const TICK_ALLOWANCE: usize = 3000;

    fn known_knowledge(map: &RuntimeNavigation, doors: &BTreeMap<GateId, DoorMemory>) -> Knowledge {
        let memory = Memory {
            discovered: (0..map.cell_count() as u32).collect(),
            gates: doors.clone(),
            ..Default::default()
        };
        Knowledge::contestant(map, &memory, 0)
    }

    fn plan_route(
        map: &Rc<RuntimeNavigation>,
        doors: &BTreeMap<GateId, DoorMemory>,
        gate_positions: &BTreeMap<GateId, Point>,
        point: Point,
        target: Point,
    ) -> RouteState {
        let mut state = RouteState::default();
        let mut allowance = TICK_ALLOWANCE;
        let status = state.repath(
            Rc::clone(map),
            CONTESTANT_CLEARANCE,
            CONTESTANT_BODY_RADIUS,
            known_knowledge(map, doors),
            doors,
            gate_positions,
            true,
            point,
            target,
            0,
            0,
            &mut allowance,
        );
        assert_eq!(status, Some(RouteStatus::Complete));
        assert!(!state.route.is_empty());
        state
    }

    #[test]
    fn a_late_route_is_joined_only_within_its_margin_else_by_the_trail_back() {
        // The bot walked round a wall while its search ran: the nearest segment lies beyond it.
        let round = [[100.0, 100.0], [180.0, 620.0], [400.0, 900.0]];
        let back = join_route(
            [400.0, 100.0],
            &round,
            &[[100.0, 100.0], [250.0, 100.0], [400.0, 100.0]],
            MARGIN,
        );
        assert_eq!(
            back[..3],
            [[400.0, 100.0], [250.0, 100.0], [100.0, 100.0]],
            "it walks back the way it came"
        );
        assert_eq!(back[3..], round[1..]);

        // Beside a segment along the wall, 10 units off it: only the trail is known clear.
        let along = [[186.0, 100.0], [186.0, 900.0]];
        let stepped = join_route(
            [196.0, 100.0],
            &along,
            &[[186.0, 100.0], [196.0, 100.0]],
            MARGIN,
        );
        assert_eq!(stepped, [[196.0, 100.0], [186.0, 100.0], [186.0, 900.0]]);

        // Within the margin it joins where it is.
        assert_eq!(
            join_route(
                [187.5, 100.0],
                &along,
                &[[186.0, 100.0], [187.5, 100.0]],
                MARGIN
            ),
            [[186.0, 900.0]]
        );
        assert_eq!(
            join_route(
                [140.0, 360.0],
                &round,
                &[[100.0, 100.0], [140.0, 360.0]],
                MARGIN
            ),
            round[1..],
            "on the route"
        );
    }

    #[test]
    fn repair_gates_on_remaining_allowance_and_succeeds_within_budget() {
        let map =
            RuntimeNavigation::for_cells(5, 2, 1, |col, row| (col == 1 && row == 0).then_some(0));
        let gate_positions = BTreeMap::from([(GateId(0), [288.0, 96.0])]);
        let open_doors = BTreeMap::from([(
            GateId(0),
            DoorMemory {
                open: true,
                locked: false,
            },
        )]);
        let closed_doors = BTreeMap::from([(
            GateId(0),
            DoorMemory {
                open: false,
                locked: true,
            },
        )]);
        let point = [96.0, 96.0];
        let target = [864.0, 96.0];
        let mut state = plan_route(&map, &open_doors, &gate_positions, point, target);
        let original_route = state.route.clone();
        let original_gen = state.generation;
        let knowledge = known_knowledge(&map, &closed_doors);

        // 1. Allowance below REPAIR_BUDGET (499) skips repair and leaves route/generation untouched.
        let mut allowance = REPAIR_BUDGET - 1;
        assert_eq!(
            state.repair(
                &map,
                CONTESTANT_CLEARANCE,
                &knowledge,
                &closed_doors,
                &gate_positions,
                point,
                &mut allowance,
            ),
            None
        );
        assert_eq!(allowance, REPAIR_BUDGET - 1);
        assert_eq!(state.route, original_route);
        assert_eq!(state.generation, original_gen);

        // Unscheduled repath also skips repair while allowance < REPAIR_BUDGET.
        assert_eq!(
            state.repath(
                Rc::clone(&map),
                CONTESTANT_CLEARANCE,
                CONTESTANT_BODY_RADIUS,
                knowledge.clone(),
                &closed_doors,
                &gate_positions,
                true,
                point,
                target,
                1,
                0,
                &mut allowance,
            ),
            None
        );
        assert_eq!(allowance, REPAIR_BUDGET - 1);
        assert_eq!(state.route, original_route);
        assert_eq!(state.generation, original_gen);

        // 2. With full tick allowance (3000), a nearby change repairs around the closed door.
        let mut allowance = TICK_ALLOWANCE;
        assert_eq!(
            state.repair(
                &map,
                CONTESTANT_CLEARANCE,
                &knowledge,
                &closed_doors,
                &gate_positions,
                point,
                &mut allowance,
            ),
            Some(true)
        );
        let spent = TICK_ALLOWANCE - allowance;
        assert!(spent > 0 && spent <= REPAIR_BUDGET);
        assert_ne!(state.route, original_route);
        assert_eq!(state.generation, original_gen + 1);
    }

    #[test]
    fn repair_stops_at_budget_exhaustion_and_marks_plan_stale() {
        let map = RuntimeNavigation::for_cells(24, 20, 1, |col, _| (col == 20).then_some(0));
        let gate_positions =
            BTreeMap::from([(GateId(0), [20.0 * 192.0 + 96.0, 10.0 * 192.0 + 96.0])]);
        let open_doors = BTreeMap::from([(
            GateId(0),
            DoorMemory {
                open: true,
                locked: false,
            },
        )]);
        let closed_doors = BTreeMap::from([(
            GateId(0),
            DoorMemory {
                open: false,
                locked: true,
            },
        )]);
        let point = [19.0 * 192.0 + 96.0, 10.0 * 192.0 + 96.0];
        let target = [23.0 * 192.0 + 96.0, 10.0 * 192.0 + 96.0];
        let mut state = plan_route(&map, &open_doors, &gate_positions, point, target);
        let original_route = state.route.clone();
        let original_gen = state.generation;
        let knowledge = known_knowledge(&map, &closed_doors);

        let mut allowance = TICK_ALLOWANCE;
        assert_eq!(
            state.repair(
                &map,
                CONTESTANT_CLEARANCE,
                &knowledge,
                &closed_doors,
                &gate_positions,
                point,
                &mut allowance,
            ),
            Some(false)
        );
        assert_eq!(allowance, TICK_ALLOWANCE - REPAIR_BUDGET);
        assert_eq!(state.route, original_route);
        assert_eq!(state.generation, original_gen);
        assert!(state.plan.as_ref().unwrap().stale);

        // On the next scheduled tick, stale marks the plan due and forces a full replan.
        let status = state.repath(
            Rc::clone(&map),
            CONTESTANT_CLEARANCE,
            CONTESTANT_BODY_RADIUS,
            knowledge,
            &closed_doors,
            &gate_positions,
            true,
            point,
            target,
            REPATH,
            0,
            &mut allowance,
        );
        assert_eq!(status, Some(RouteStatus::NoKnownRoute));
        assert_eq!(state.generation, original_gen + 1);
    }
}
