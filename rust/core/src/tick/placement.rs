use std::collections::BTreeMap;

use crate::math::{cos, hypot, sin};
use crate::physics::{BodyParams, KIND_PROP, LOOT_GROUP, SHAPE_CIRCLE};
use crate::world::MAX_DYNAMIC;

use super::apply::{Spawn, SpawnKey};
use super::solve::BodySpec;
use super::state::{ActorId, BodyId, GateId, ItemId, Point, State};
use super::{ClaimView, scatter_score};

const LOOT_RADIUS: f64 = 6.0;
const MAP_RADIUS: f64 = 16.0;

/// Limits for logical ground items, optional loot bodies and all dynamic bodies.
pub struct DropTuning {
    pub ground_capacity: usize,
    pub optional_body_capacity: usize,
    pub body_capacity: usize,
}

impl Default for DropTuning {
    fn default() -> Self {
        Self {
            ground_capacity: 65_536,
            optional_body_capacity: MAX_DYNAMIC,
            body_capacity: MAX_DYNAMIC,
        }
    }
}

pub(super) struct DropPlan<'a> {
    pub state: &'a State,
    pub view: ClaimView<'a>,
    pub reserved: &'a BTreeMap<SpawnKey, Spawn>,
    pub replacing: Option<ItemId>,
    pub owner: ActorId,
    pub ordinal: u32,
    pub copies: usize,
    pub mandatory: bool,
}

pub(super) struct DropSpot {
    pub position: Point,
    pub body: Option<BodySpec>,
}

impl DropTuning {
    pub(super) fn plan(&self, plan: DropPlan<'_>) -> Option<Vec<DropSpot>> {
        let DropPlan {
            state,
            view,
            reserved,
            replacing,
            owner,
            ordinal,
            copies,
            mandatory,
        } = plan;
        let origin = view.solved.position(BodyId::Actor(owner))?;
        let reserved_items: Vec<_> = reserved
            .values()
            .filter_map(|spawn| match spawn {
                Spawn::Item { body, .. } => Some(body),
                _ => None,
            })
            .collect();
        let logical = state.items.len().saturating_sub(usize::from(
            replacing.is_some_and(|id| state.items.contains_key(&id)),
        )) + reserved_items.len();
        let physical_items = state
            .items
            .keys()
            .filter(|&&id| {
                Some(id) != replacing && view.solved.position(BodyId::Item(id)).is_some()
            })
            .count()
            + reserved_items.iter().filter(|body| body.is_some()).count();
        let bodies = view
            .solved
            .bodies()
            .filter(|id| match id {
                BodyId::Actor(actor) => state.active(*actor),
                BodyId::Item(item) => Some(*item) != replacing && state.items.contains_key(item),
                _ => true,
            })
            .count()
            + reserved_items.iter().filter(|body| body.is_some()).count();
        if !mandatory
            && (logical.saturating_add(copies) > self.ground_capacity
                || physical_items.saturating_add(copies) > self.optional_body_capacity
                || bodies.saturating_add(copies) > self.body_capacity)
        {
            return None;
        }
        let mut occupied: Vec<Point> = state
            .items
            .keys()
            .filter(|&&id| Some(id) != replacing)
            .filter_map(|&id| view.solved.position(BodyId::Item(id)))
            .collect();
        occupied.extend(
            reserved_items
                .iter()
                .filter_map(|body| body.as_ref().map(|b| [b.params.pose[0], b.params.pose[1]])),
        );
        let actors: Vec<_> = state
            .actors
            .keys()
            .filter(|&&id| state.active(id))
            .filter_map(|&id| {
                let body = BodyId::Actor(id);
                Some((view.solved.position(body)?, view.solved.radius(body)?))
            })
            .collect();
        let clear = |point: Point, occupied: &[Point]| {
            if let Some([min_x, min_y, max_x, max_y]) = view.bounds
                && (point[0] - MAP_RADIUS < min_x
                    || point[1] - MAP_RADIUS < min_y
                    || point[0] + MAP_RADIUS > max_x
                    || point[1] + MAP_RADIUS > max_y)
            {
                return false;
            }
            if view
                .geometry
                .contact_with_gates(
                    false,
                    point,
                    point,
                    MAP_RADIUS,
                    &view.solved.solid_props,
                    |index| {
                        state
                            .gates
                            .get(&GateId(index as u32))
                            .is_some_and(|gate| gate.open)
                    },
                )
                .is_finite()
            {
                return false;
            }
            if view
                .geometry
                .contact_with_gates(false, origin, point, 0.0, &[], |index| {
                    state
                        .gates
                        .get(&GateId(index as u32))
                        .is_some_and(|gate| gate.open)
                })
                .is_finite()
            {
                return false;
            }
            actors.iter().all(|(at, radius)| {
                hypot(point[0] - at[0], point[1] - at[1]) > radius + LOOT_RADIUS
            }) && occupied
                .iter()
                .all(|at| hypot(point[0] - at[0], point[1] - at[1]) > 32.0)
        };
        let mut spots = Vec::with_capacity(copies);
        for copy in 0..copies {
            let phase =
                (scatter_score(view.seed, view.tick, owner, u64::from(ordinal), copy as u32) >> 11)
                    as f64
                    * (std::f64::consts::TAU / ((1_u64 << 53) as f64));
            let position = (0..180).find_map(|j| {
                let angle = phase + f64::from(j) * 2.39996;
                let radius = 36.0 + f64::from(j / 12) * 24.0;
                let p = [
                    origin[0] + cos(angle) * radius,
                    origin[1] + sin(angle) * radius,
                ];
                clear(p, &occupied).then_some(p)
            });
            let position = match position {
                Some(p) => p,
                None if mandatory => origin,
                None => return None,
            };
            let admit = bodies.saturating_add(
                spots
                    .iter()
                    .filter(|spot: &&DropSpot| spot.body.is_some())
                    .count(),
            ) < self.body_capacity;
            let dx = position[0] - origin[0];
            let dy = position[1] - origin[1];
            let length = hypot(dx, dy);
            let velocity = if length > 0.0 {
                [dx / length * 60.0, dy / length * 60.0]
            } else {
                [0.0; 2]
            };
            let body = admit.then(|| BodySpec {
                params: BodyParams {
                    kind: KIND_PROP,
                    map_geometry: false,
                    pose: [position[0], position[1], 0.0, velocity[0], velocity[1], 0.0],
                    material: [0.2, 0.0, 0.0],
                    damping: [5.0, 5.0],
                    groups: (LOOT_GROUP << 16) | 1,
                },
                shape: SHAPE_CIRCLE,
                dimensions: [LOOT_RADIUS, 0.0],
                vertices: Vec::new(),
                speed_limit: 384.0,
                tip_radius: 0.0,
            });
            if body.is_some() {
                occupied.push(position);
            }
            spots.push(DropSpot { position, body });
        }
        Some(spots)
    }
}
