use std::collections::{BTreeMap, BTreeSet};

use crate::floor_drag::Floor;
use crate::hooks::prop_shape;
use crate::physics::{
    self, BodyParams, CONSTRAINT_STRIDE, DYNAMIC_STRIDE, EVENT_STRIDE, HEADER, KIND_PROP,
    KIND_STATIC, LOOT_GROUP, PUSH_STRIDE, SUBSTEPS,
};
use crate::swept::Shape;
use crate::world::PropShape;

use super::state::{ActorId, BodyId, GateId, HookId, Point};

#[derive(Clone)]
pub struct BodySpec {
    pub params: BodyParams,
    pub shape: u32,
    pub dimensions: [f64; 2],
    pub vertices: Vec<f64>,
    pub speed_limit: f64,
    pub tip_radius: f64,
}

impl BodySpec {
    pub(super) fn radius(&self) -> f64 {
        let [a, b] = self.dimensions;
        if self.shape == physics::SHAPE_CIRCLE {
            a
        } else {
            crate::math::hypot(a, b)
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Motor {
    pub velocity: Point,
    pub acceleration: f64,
}

pub type Path = [Point; SUBSTEPS + 1];

#[derive(Clone, Copy, Debug)]
pub struct Tether {
    pub a: BodyId,
    pub b: BodyId,
    pub length: f64,
    pub stiffness: f64,
    pub damping: f64,
    pub max_force: f64,
    pub break_distance: f64,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ContactKind {
    Started,
    Stopped,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Contact {
    pub substep: u8,
    pub a: BodyId,
    pub b: BodyId,
    pub kind: ContactKind,
}

#[derive(Default)]
pub struct BeforeSolve {
    positions: BTreeMap<BodyId, Point>,
    pub solid_props: Vec<Shape>,
}

impl BeforeSolve {
    pub fn position(&self, id: BodyId) -> Option<Point> {
        self.positions.get(&id).copied()
    }
}

#[derive(Default)]
pub struct Solved {
    bodies: BTreeMap<BodyId, SolvedBody>,
    broken: BTreeSet<HookId>,
    pub contacts: Vec<Contact>,
    pub solid_props: Vec<Shape>,
}

struct SolvedBody {
    path: Path,
    radius: f64,
}

impl Solved {
    pub(super) fn bodies(&self) -> impl Iterator<Item = BodyId> + '_ {
        self.bodies.keys().copied()
    }

    pub(super) fn radius(&self, id: BodyId) -> Option<f64> {
        self.bodies.get(&id).map(|body| body.radius)
    }

    pub fn path(&self, id: BodyId) -> Option<&Path> {
        self.bodies.get(&id).map(|body| &body.path)
    }

    pub fn position(&self, id: BodyId) -> Option<Point> {
        self.path(id).map(|path| path[SUBSTEPS])
    }

    pub(super) fn distance_travelled(&self, id: BodyId) -> Option<f64> {
        self.path(id).map(|path| {
            path.windows(2)
                .map(|pair| crate::math::hypot(pair[1][0] - pair[0][0], pair[1][1] - pair[0][1]))
                .sum()
        })
    }

    pub fn tether_broke(&self, id: HookId) -> bool {
        self.broken.contains(&id)
    }
}

#[derive(Default)]
pub(super) struct Bodies {
    engine: physics::World,
    slots: BTreeMap<BodyId, u32>,
    names: BTreeMap<u32, BodyId>,
    dynamic: BTreeMap<BodyId, DynamicBody>,
    solid_props: BTreeMap<BodyId, PropShape>,
    gate_specs: BTreeMap<GateId, BodySpec>,
    actor_specs: BTreeMap<ActorId, BodySpec>,
}

struct DynamicBody {
    speed_limit: f64,
    tip_radius: f64,
    radius: f64,
}

impl Bodies {
    pub(super) fn seed_actor(&mut self, id: ActorId, spec: BodySpec, active: bool) {
        if active {
            self.insert(BodyId::Actor(id), spec.clone());
        }
        self.actor_specs.insert(id, spec);
    }

    pub(super) fn actor_spec(&self, id: ActorId) -> Option<&BodySpec> {
        self.actor_specs.get(&id)
    }

    pub(super) fn gate(&mut self, id: GateId, spec: BodySpec, open: bool) {
        self.gate_specs.insert(id, spec);
        self.sync_gate(id, open);
    }

    pub(super) fn sync_gate(&mut self, id: GateId, open: bool) {
        let body = BodyId::Gate(id);
        if open {
            self.remove(body);
        } else if !self.slots.contains_key(&body)
            && let Some(spec) = self.gate_specs.get(&id)
        {
            self.insert(body, spec.clone());
        }
    }

    pub(super) fn gate_box(&self, id: GateId) -> Option<[f64; 4]> {
        let spec = self.gate_specs.get(&id)?;
        let [x, y, ..] = spec.params.pose;
        let [hx, hy] = spec.dimensions;
        (spec.shape == physics::SHAPE_BOX).then_some([x - hx, y - hy, hx * 2.0, hy * 2.0])
    }

    pub(super) fn props_overlap_box(&self, [x, y, w, h]: [f64; 4]) -> bool {
        self.solid_props.keys().any(|id| {
            self.engine.intersects(
                self.slots[id],
                physics::SHAPE_BOX,
                w / 2.0,
                h / 2.0,
                x + w / 2.0,
                y + h / 2.0,
            )
        })
    }

    pub(super) fn insert(&mut self, id: BodyId, spec: BodySpec) {
        assert!(!self.slots.contains_key(&id), "body ID already in use");
        let [a, b] = spec.dimensions;
        let slot = self
            .engine
            .add_body(&spec.params, spec.shape, a, b, &spec.vertices)
            .expect("validated body shape");
        self.slots.insert(id, slot);
        self.names.insert(slot, id);
        if spec.params.kind != KIND_STATIC {
            self.dynamic.insert(
                id,
                DynamicBody {
                    speed_limit: spec.speed_limit,
                    tip_radius: spec.tip_radius,
                    radius: spec.radius(),
                },
            );
        }
        if spec.params.kind == KIND_PROP && spec.params.groups >> 16 != LOOT_GROUP {
            self.solid_props.insert(
                id,
                PropShape {
                    shape: spec.shape,
                    a,
                    b,
                    vertices: spec.vertices,
                },
            );
        }
    }

    /// Whether the body was in the world.
    pub(super) fn remove(&mut self, id: BodyId) -> bool {
        let Some(slot) = self.slots.remove(&id) else {
            return false;
        };
        self.dynamic.remove(&id);
        self.names.remove(&slot);
        self.solid_props.remove(&id);
        self.engine.remove_body(slot);
        true
    }

    /// Every dynamic body's position, in body order: a snapshot's poses.
    pub(super) fn dynamic_positions(&mut self) -> BTreeMap<BodyId, Point> {
        let ids: Vec<_> = self.dynamic.keys().copied().collect();
        ids.into_iter()
            .filter_map(|id| Some((id, self.position(id)?)))
            .collect()
    }

    pub(super) fn is_dynamic(&self, id: BodyId) -> bool {
        self.dynamic.contains_key(&id)
    }

    pub(super) fn angle(&mut self, id: BodyId) -> Option<f64> {
        let &slot = self.slots.get(&id)?;
        Some(self.engine.pose(slot)[2])
    }

    pub(super) fn warp(&mut self, id: BodyId, to: Point, angle: f64) {
        if let Some(&slot) = self.slots.get(&id) {
            self.engine.set_pose(slot, to[0], to[1], angle);
        }
    }

    pub(super) fn position(&mut self, id: BodyId) -> Option<Point> {
        let &slot = self.slots.get(&id)?;
        let pose = self.engine.pose(slot);
        Some([pose[0], pose[1]])
    }

    pub(super) fn before_solve(&mut self) -> BeforeSolve {
        let positions = self
            .dynamic
            .keys()
            .map(|&id| {
                let pose = self.engine.pose(self.slots[&id]);
                (id, [pose[0], pose[1]])
            })
            .collect();
        BeforeSolve {
            positions,
            solid_props: self.props(),
        }
    }

    fn props(&mut self) -> Vec<Shape> {
        self.solid_props
            .iter()
            .map(|(&id, shape)| {
                let pose = self.engine.pose(self.slots[&id]);
                prop_shape(shape, pose[0], pose[1], pose[2])
            })
            .collect()
    }

    pub(super) fn use_floor(&mut self, floor: Floor) {
        self.engine.use_floor(floor);
    }

    pub(super) fn step(
        &mut self,
        motors: &BTreeMap<BodyId, Motor>,
        impulses: &BTreeMap<BodyId, Point>,
        tethers: &BTreeMap<HookId, Tether>,
    ) -> Solved {
        self.engine.apply_floor_drag();
        let mut input = std::mem::take(self.engine.input_vec());
        input.clear();
        input.reserve(self.dynamic.len() * DYNAMIC_STRIDE + impulses.len() * PUSH_STRIDE);
        for (&id, body) in &self.dynamic {
            let (enabled, x, y, acceleration) =
                motors.get(&id).map_or((0.0, 0.0, 0.0, 0.0), |motor| {
                    (
                        1.0,
                        motor.velocity[0],
                        motor.velocity[1],
                        motor.acceleration,
                    )
                });
            input.extend_from_slice(&[
                f64::from(self.slots[&id]),
                enabled,
                x,
                y,
                acceleration,
                body.speed_limit,
                body.tip_radius,
            ]);
        }
        let mut impulse_count = 0;
        for (&id, &[x, y]) in impulses {
            if self.dynamic.contains_key(&id) {
                input.extend_from_slice(&[f64::from(self.slots[&id]), x, y]);
                impulse_count += 1;
            }
        }
        let mut constraints = Vec::new();
        for (&id, tether) in tethers {
            let (Some(&a), Some(&b)) = (self.slots.get(&tether.a), self.slots.get(&tether.b))
            else {
                continue;
            };
            let row: [f64; CONSTRAINT_STRIDE] = [
                f64::from(a),
                f64::from(b),
                1.0,
                tether.length,
                0.0,
                tether.stiffness,
                tether.damping,
                tether.max_force,
                tether.break_distance,
                0.0,
                0.0,
                0.0,
                0.0,
            ];
            input.extend_from_slice(&row);
            constraints.push(id);
        }
        *self.engine.input_vec() = input;

        let count = self.dynamic.len();
        let out = self.engine.step(count, 0, impulse_count, constraints.len());
        assert_eq!(out[0], 0.0, "Rapier rejected the tick's inputs");
        let bodies = self
            .dynamic
            .iter()
            .enumerate()
            .map(|(index, (&id, body))| {
                let path = std::array::from_fn(|substep| {
                    let at = HEADER + (substep * count + index) * 2;
                    [out[at], out[at + 1]]
                });
                (
                    id,
                    SolvedBody {
                        path,
                        radius: body.radius,
                    },
                )
            })
            .collect();
        let event_start = HEADER + (SUBSTEPS + 1) * count * 2;
        let event_end = event_start + out[2] as usize * EVENT_STRIDE;
        let mut contacts: Vec<_> = out[event_start..event_end]
            .as_chunks::<EVENT_STRIDE>()
            .0
            .iter()
            .filter_map(|&[substep, a, b, started]| {
                let a = *self.names.get(&(a as u32))?;
                let b = *self.names.get(&(b as u32))?;
                Some(Contact {
                    substep: substep as u8,
                    a: a.min(b),
                    b: a.max(b),
                    kind: if started == 0.0 {
                        ContactKind::Stopped
                    } else {
                        ContactKind::Started
                    },
                })
            })
            .collect();
        contacts.sort_unstable();
        let broken = out[event_end..]
            .iter()
            .map(|&i| constraints[i as usize])
            .collect();
        Solved {
            bodies,
            broken,
            contacts,
            solid_props: self.props(),
        }
    }
}
