//! Swept contact against the frozen actors' solved paths (27.2 A6, R6).
use crate::physics::SUBSTEPS;
use crate::swept::{hit_radius, impact};

use super::{ActorId, ActorKind, BodyId, Path, Point, ResolveView, actor_word, contest_score};

fn path_contact(from: Point, to: Point, path: &Path, radius: f64) -> Option<f64> {
    let sample = |fraction: f64| {
        [
            from[0] + (to[0] - from[0]) * fraction,
            from[1] + (to[1] - from[1]) * fraction,
        ]
    };
    for k in 0..SUBSTEPS {
        let a = sample(k as f64 / SUBSTEPS as f64);
        let b = sample((k + 1) as f64 / SUBSTEPS as f64);
        if let Some(t) = impact(a, b, path[k], path[k + 1], radius) {
            return Some((k as f64 + t) / SUBSTEPS as f64);
        }
    }
    None
}

/// Return the first actor hit before geometry; policy such as friendly fire belongs to the caller.
pub(super) fn first_actor_contact(
    view: &ResolveView<'_>,
    owner: Option<ActorId>,
    from: Point,
    to: Point,
    geometry_toi: f64,
    contest_key: u64,
) -> Option<(ActorId, f64)> {
    let mut first: Option<(ActorId, f64, u64)> = None;
    for &id in view.start.state.actors.keys() {
        if Some(id) == owner || !view.start.state.active(id) {
            continue;
        }
        let Some(path) = view.solved.path(BodyId::Actor(id)) else {
            continue;
        };
        let Some(toi) = path_contact(from, to, path, hit_radius(id.kind == ActorKind::Gladiator))
        else {
            continue;
        };
        if toi >= geometry_toi {
            continue;
        }
        let score = contest_score(
            view.start.seed,
            view.start.tick,
            contest_key,
            actor_word(id),
        );
        if first.is_none_or(|(best_id, best_toi, best_score)| {
            toi < best_toi || (toi == best_toi && (score, id) < (best_score, best_id))
        }) {
            first = Some((id, toi, score));
        }
    }
    first.map(|(id, toi, _)| (id, toi))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contact_time_spans_substeps() {
        let path = [[50.0, 0.0]; SUBSTEPS + 1];
        let toi = path_contact([0.0, 0.0], [100.0, 0.0], &path, 15.0).unwrap();
        assert!((toi - 0.35).abs() < 1e-12);
        assert!(path_contact([0.0, 20.0], [100.0, 20.0], &path, 15.0).is_none());
    }

    #[test]
    fn an_actor_moving_into_the_shot_is_met_earlier_than_a_still_one() {
        // The shot flies 45 along y 0; a contestant (radius 15) starting at 70 walks back 7 per substep.
        let still = [[70.0, 0.0]; SUBSTEPS + 1];
        let mut walking = [[0.0; 2]; SUBSTEPS + 1];
        for (k, at) in walking.iter_mut().enumerate() {
            *at = [70.0 - 7.0 * k as f64, 0.0];
        }
        let reach = |path| path_contact([20.0, 0.0], [65.0, 0.0], &path, 15.0).unwrap();
        // Still: contact at x 55, 35 of 45 along. Walking: the gap closes by the actor's own motion too.
        assert!((reach(still) - 35.0 / 45.0).abs() < 1e-12);
        assert!(reach(walking) < reach(still) - 0.05);
    }

    #[test]
    fn a_shot_hurts_inside_the_old_hit_envelope_and_not_outside_it() {
        // Wider than the movement bodies (about 11 and 16): the contestant's 15 and the gladiator's 26.
        let path = [[50.0, 0.0]; SUBSTEPS + 1];
        for (gladiator, inside, outside) in [(false, 14.0, 16.0), (true, 25.0, 27.0)] {
            let reach = |offset: f64| {
                path_contact(
                    [0.0, offset],
                    [100.0, offset],
                    &path,
                    crate::swept::hit_radius(gladiator),
                )
            };
            assert!(reach(inside).is_some(), "gladiator {gladiator}: {inside}");
            assert!(reach(outside).is_none(), "gladiator {gladiator}: {outside}");
        }
    }
}
