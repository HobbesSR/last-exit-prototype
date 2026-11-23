use std::collections::BTreeMap;

use crate::physics::{
    self, BodyParams, DYNAMIC_STRIDE, HEADER, KIND_STATIC, PUSH_STRIDE, SUBSTEPS,
};

use super::state::{BodyId, Point};

pub struct BodySpec {
    pub params: BodyParams,
    pub shape: u32,
    pub dimensions: [f64; 2],
    pub vertices: Vec<f64>,
    pub speed_limit: f64,
    pub tip_radius: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Motor {
    pub velocity: Point,
    pub acceleration: f64,
}

pub type Path = [Point; SUBSTEPS + 1];

#[derive(Default)]
pub struct Solved {
    paths: BTreeMap<BodyId, Path>,
}

impl Solved {
    pub fn path(&self, id: BodyId) -> Option<&Path> {
        self.paths.get(&id)
    }

    pub fn position(&self, id: BodyId) -> Option<Point> {
        self.path(id).map(|path| path[SUBSTEPS])
    }
}

#[derive(Default)]
pub(super) struct Bodies {
    engine: physics::World,
    slots: BTreeMap<BodyId, u32>,
    dynamic: BTreeMap<BodyId, [f64; 2]>,
}

impl Bodies {
    pub(super) fn insert(&mut self, id: BodyId, spec: BodySpec) {
        assert!(!self.slots.contains_key(&id), "body ID already in use");
        let [a, b] = spec.dimensions;
        let slot = self
            .engine
            .add_body(&spec.params, spec.shape, a, b, &spec.vertices)
            .expect("validated body shape");
        self.slots.insert(id, slot);
        if spec.params.kind != KIND_STATIC {
            self.dynamic.insert(id, [spec.speed_limit, spec.tip_radius]);
        }
    }

    pub(super) fn remove(&mut self, id: BodyId) {
        if let Some(slot) = self.slots.remove(&id) {
            self.dynamic.remove(&id);
            self.engine.remove_body(slot);
        }
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

    pub(super) fn step(
        &mut self,
        motors: &BTreeMap<BodyId, Motor>,
        impulses: &BTreeMap<BodyId, Point>,
    ) -> Solved {
        let mut input = std::mem::take(self.engine.input_vec());
        input.clear();
        input.reserve(self.dynamic.len() * DYNAMIC_STRIDE + impulses.len() * PUSH_STRIDE);
        for (&id, &[limit, tip]) in &self.dynamic {
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
                limit,
                tip,
            ]);
        }
        let mut impulse_count = 0;
        for (&id, &[x, y]) in impulses {
            if self.dynamic.contains_key(&id) {
                input.extend_from_slice(&[f64::from(self.slots[&id]), x, y]);
                impulse_count += 1;
            }
        }
        *self.engine.input_vec() = input;

        let count = self.dynamic.len();
        let out = self.engine.step(count, 0, impulse_count, 0);
        assert_eq!(out[0], 0.0, "Rapier rejected the tick's inputs");
        let paths = self
            .dynamic
            .keys()
            .enumerate()
            .map(|(index, &id)| {
                let path = std::array::from_fn(|substep| {
                    let at = HEADER + (substep * count + index) * 2;
                    [out[at], out[at + 1]]
                });
                (id, path)
            })
            .collect();
        Solved { paths }
    }
}
