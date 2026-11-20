//! Rapier compiled into the core (docs/27 "Physics", #1192).
//!
//! This first step only proves the crate can be used: `probe` builds a small world with every
//! feature `shared/physics/world.ts` uses through rapier.js (balls, cuboids, convex hulls, a rope
//! joint, CCD, collision groups and events, shape intersection) and steps it, so their code is in
//! the built module for `tests/core-wasm-audit.test.js` to inspect. The adapter behind world.ts's
//! queue-and-commit interface replaces it.

use rapier2d::parry::query;
use rapier2d::prelude::*;

/// Collision events, collected in the order Rapier reports them.
#[derive(Default)]
struct Events(std::sync::Mutex<Vec<(ColliderHandle, ColliderHandle, bool)>>);

impl EventHandler for Events {
    fn handle_collision_event(
        &self,
        _bodies: &RigidBodySet,
        _colliders: &ColliderSet,
        event: CollisionEvent,
        _pair: Option<&ContactPair>,
    ) {
        self.0.lock().expect("one thread").push((
            event.collider1(),
            event.collider2(),
            event.started(),
        ));
    }

    fn handle_contact_force_event(
        &self,
        _dt: Real,
        _bodies: &RigidBodySet,
        _colliders: &ColliderSet,
        _pair: &ContactPair,
        _total_force_magnitude: Real,
    ) {
    }

    fn handle_soft_body_tear_event(&self, _soft_bodies: &SoftBodySet, _event: &SoftBodyTearEvent) {}
}

/// Steps a small world `steps` times and folds every body's pose, the collision events and an
/// intersection test into one number, so results can be compared across hosts.
pub fn probe(steps: u32) -> f64 {
    let mut parameters = IntegrationParameters {
        dt: 1.0 / 120.0,
        normalized_allowed_linear_error: 0.0001,
        normalized_prediction_distance: 0.6,
        max_ccd_substeps: 4,
        ..IntegrationParameters::default()
    };
    parameters.num_solver_iterations = 8;
    parameters.num_internal_pgs_iterations = 2;

    let mut bodies = RigidBodySet::new();
    let mut colliders = ColliderSet::new();
    let mut joints = ImpulseJointSet::new();
    let groups = |membership: u32, filter: u32| {
        InteractionGroups::new(
            Group::from_bits_truncate(membership),
            Group::from_bits_truncate(filter),
            InteractionTestMode::And,
        )
    };

    let ground = bodies.insert(RigidBodyBuilder::fixed());
    for (x, y, angle) in [(0.0, -2.0, 0.0), (4.0, 0.0, 0.3)] {
        let wall = ColliderBuilder::cuboid(5.0, 0.5)
            .translation(Vector::new(x, y))
            .rotation(angle)
            .collision_groups(groups(1, 0b1111))
            .active_events(ActiveEvents::COLLISION_EVENTS);
        colliders.insert_with_parent(wall, ground, &mut bodies);
    }

    let hull = [
        Vector::new(-0.3, -0.2),
        Vector::new(0.3, -0.2),
        Vector::new(0.0, 0.35),
    ];
    let mut handles = Vec::new();
    for i in 0..4u8 {
        let body = RigidBodyBuilder::dynamic()
            .translation(Vector::new(f32::from(i) - 1.5, 1.0))
            .rotation(0.1 * f32::from(i))
            .linvel(Vector::new(1.0, -3.0))
            .angvel(0.5)
            .linear_damping(0.2)
            .ccd_enabled(true);
        let body = if i == 0 { body.lock_rotations() } else { body };
        let body = bodies.insert(body);
        let shape = match i {
            0 => ColliderBuilder::ball(0.3),
            1 => ColliderBuilder::cuboid(0.25, 0.4),
            _ => ColliderBuilder::convex_hull(&hull).expect("a strictly convex hull"),
        };
        let shape = shape
            .mass(1.0 + f32::from(i))
            .friction(0.5)
            .restitution(0.1)
            .collision_groups(groups(2, 0b0111))
            .active_events(ActiveEvents::COLLISION_EVENTS);
        colliders.insert_with_parent(shape, body, &mut bodies);
        handles.push(body);
    }
    joints.insert(handles[2], handles[3], RopeJointBuilder::new(1.2), true);

    let mut pipeline = PhysicsPipeline::new();
    let mut islands = IslandManager::new();
    let mut broad_phase = DefaultBroadPhase::default();
    let mut narrow_phase = NarrowPhase::new();
    let mut multibody = MultibodyJointSet::new();
    let mut soft = SoftBodySet::new();
    let mut ccd = CCDSolver::new();
    let events = Events::default();

    let mut fold = 0.0f64;
    for _ in 0..steps {
        for handle in &handles {
            let body = &mut bodies[*handle];
            body.reset_forces(false);
            body.add_force(Vector::new(0.0, -9.81 * body.mass()), true);
        }
        pipeline.step(
            Vector::ZERO,
            &parameters,
            &mut islands,
            &mut broad_phase,
            &mut narrow_phase,
            &mut bodies,
            &mut colliders,
            &mut joints,
            &mut multibody,
            &mut soft,
            &mut ccd,
            &(),
            &events,
        );
        for (index, handle) in handles.iter().enumerate() {
            let body = &bodies[*handle];
            let p = body.translation();
            let weight = (index + 1) as f64;
            fold = fold * 0.5
                + weight
                    * (f64::from(p.x)
                        + 3.0 * f64::from(p.y)
                        + 7.0 * f64::from(body.rotation().angle()));
        }
    }
    fold += events.0.lock().expect("one thread").len() as f64;

    let ball = Ball::new(0.5);
    let probe_at = Pose::from_translation(Vector::new(0.0, -1.0));
    let touching = colliders.iter().filter(|(_, collider)| {
        query::intersection_test(&probe_at, &ball, collider.position(), collider.shape())
            .is_ok_and(|hit| hit.intersecting)
    });
    fold + touching.count() as f64
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_probe_settles_to_a_finite_result() {
        let result = super::probe(240);
        assert!(result.is_finite(), "{result}");
        assert_eq!(result.to_bits(), super::probe(240).to_bits());
    }
}
