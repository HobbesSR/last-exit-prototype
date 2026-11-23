//! Resolve projectile travel against shot-blocking geometry and frozen actor paths (27.2 R6).

use super::combat::hit;
use super::sweep::first_actor_contact;
use super::{
    ActorId, Effects, Entity, GateId, Lifecycle, Projectile, ProjectileId, ResolveView, SpawnKey,
    actor_word, contest_score,
};

const CONTACT_CONTEST: u64 = 0x7072_6f6a_6563_7469;
const PROJECTILE_RADIUS: f64 = 2.0;

// Command shots use their actor and spread ordinal before stable ID allocation.
fn provisional_contest(actor: ActorId, ordinal: u32) -> u64 {
    contest_score(0, ordinal, CONTACT_CONTEST ^ 1, actor_word(actor))
}

fn persistent_contest(id: ProjectileId) -> u64 {
    contest_score(0, 0, CONTACT_CONTEST, u64::from(id.0))
}

// None means the projectile was consumed or has completed its final sweep.
fn sweep<C, P>(
    view: &ResolveView<'_>,
    effects: &mut Effects<C, P>,
    mut projectile: Projectile,
    contest: u64,
) -> Option<Projectile> {
    let tick = view.start.tick;
    if tick >= projectile.expires_at {
        return None;
    }
    if tick < projectile.active_from {
        return Some(projectile);
    }
    let from = projectile.position;
    let to = [
        from[0] + projectile.velocity[0],
        from[1] + projectile.velocity[1],
    ];
    let wall =
        view.start
            .geometry
            .contact_with_gates(true, from, to, PROJECTILE_RADIUS, &[], |index| {
                view.start
                    .state
                    .gates
                    .get(&GateId(index as u32))
                    .is_some_and(|gate| gate.open)
            });
    let owner = match projectile.source {
        Entity::Actor(actor) => Some(actor),
        _ => None,
    };
    if let Some((target, _)) = first_actor_contact(view, owner, from, to, wall, contest) {
        hit(effects, projectile.source, target, projectile.damage);
        return None;
    }
    if wall.is_finite() || tick.saturating_add(1) >= projectile.expires_at {
        return None;
    }
    projectile.position = to;
    Some(projectile)
}

pub(super) fn resolve_into<C, P>(view: &ResolveView<'_>, effects: &mut Effects<C, P>) {
    for (&id, &projectile) in &view.start.state.projectiles {
        match sweep(view, effects, projectile, persistent_contest(id)) {
            Some(projectile) => effects
                .lifecycle
                .push(Lifecycle::UpdateProjectile { id, projectile }),
            None => effects.lifecycle.push(Lifecycle::RemoveProjectile(id)),
        }
    }
    for (&(actor, ordinal), &projectile) in view.launched_projectiles {
        if let Some(projectile) = sweep(
            view,
            effects,
            projectile,
            provisional_contest(actor, ordinal),
        ) {
            effects.new_projectiles.insert(
                SpawnKey {
                    source: Entity::Actor(actor),
                    ordinal,
                },
                projectile,
            );
        }
    }
}
