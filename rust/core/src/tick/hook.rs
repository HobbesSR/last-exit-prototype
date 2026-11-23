//! Current-state hook flight and bounded tether policy (27.2 R5–R6).

use crate::math::hypot;
use crate::physics::{DT, SUBSTEPS};

use super::sweep::first_actor_contact;
use super::{
    BodyId, Hook, HookPhase, HookRelease, IntakeView, Point, ResolveView, Tether, actor_word,
};

const TICK_SECONDS: f64 = DT * SUBSTEPS as f64;
const CONTACT_CONTEST: u64 = 0x686f_6f6b_0000_0000;

#[derive(Clone, Copy, Debug)]
pub struct HookTuning {
    pub range: f64,
    pub speed: f64,
    pub max_force: f64,
    pub stiffness: f64,
    pub damping: f64,
    pub pull_speed: f64,
    pub duration: u32,
    pub cooldown: u32,
    pub standoff: f64,
    pub target_distance: f64,
    pub break_distance: f64,
}

impl Default for HookTuning {
    fn default() -> Self {
        Self {
            range: 500.0,
            speed: 900.0,
            max_force: 6_000.0,
            stiffness: 120.0,
            damping: 30.0,
            pull_speed: 240.0,
            duration: 60,
            cooldown: 140,
            standoff: 55.0,
            target_distance: 35.0,
            break_distance: 550.0,
        }
    }
}

fn separation(a: Point, b: Point) -> f64 {
    hypot(a[0] - b[0], a[1] - b[1])
}

pub(super) fn prepare(
    tuning: &HookTuning,
    view: &IntakeView<'_>,
    mut hook: Hook,
) -> Result<Option<(Hook, Tether)>, HookRelease> {
    if view.start.tick >= hook.expires_at {
        return Err(HookRelease::Expired);
    }
    let a = BodyId::Actor(hook.owner);
    let from = view.bodies.position(a).ok_or(HookRelease::EndpointGone)?;
    let HookPhase::Pulling { target, length } = hook.phase else {
        return Ok(None);
    };
    let b = BodyId::Actor(target);
    let to = view
        .bodies
        .position(b)
        .filter(|_| view.start.state.active(target))
        .ok_or(HookRelease::EndpointGone)?;
    let distance = separation(from, to);
    if distance <= tuning.standoff {
        return Err(HookRelease::Standoff);
    }
    if distance > tuning.break_distance {
        return Err(HookRelease::Separation);
    }
    if view
        .start
        .solid_contact(from, to, &view.bodies.solid_props)
        .is_finite()
    {
        return Err(HookRelease::Obstructed);
    }
    let length = (length - tuning.pull_speed * TICK_SECONDS).max(tuning.target_distance);
    hook.phase = HookPhase::Pulling { target, length };
    Ok(Some((
        hook,
        Tether {
            a,
            b,
            length,
            stiffness: tuning.stiffness,
            damping: tuning.damping,
            max_force: tuning.max_force,
            break_distance: tuning.break_distance,
        },
    )))
}

pub(super) fn sweep(
    tuning: &HookTuning,
    view: &ResolveView<'_>,
    mut hook: Hook,
) -> Result<Hook, HookRelease> {
    let HookPhase::Flying {
        position,
        direction,
        travelled,
    } = hook.phase
    else {
        unreachable!("sweep requires a flying hook");
    };
    let step = (tuning.speed * TICK_SECONDS).min(tuning.range - travelled);
    if step <= 0.0 {
        return Err(HookRelease::Range);
    }
    let end = [
        position[0] + direction[0] * step,
        position[1] + direction[1] * step,
    ];
    let props = &view.solved.solid_props;
    let wall = view.start.solid_contact(position, end, props);
    let contest = CONTACT_CONTEST ^ actor_word(hook.owner);
    if let Some((target, _)) =
        first_actor_contact(view, Some(hook.owner), position, end, wall, contest)
    {
        if target.kind == hook.owner.kind {
            return Err(HookRelease::FriendlyContact);
        }
        let from = view
            .solved
            .position(BodyId::Actor(hook.owner))
            .ok_or(HookRelease::EndpointGone)?;
        let to = view
            .solved
            .position(BodyId::Actor(target))
            .ok_or(HookRelease::EndpointGone)?;
        let length = separation(from, to);
        if length > tuning.range {
            return Err(HookRelease::Range);
        }
        if view.start.solid_contact(from, to, props).is_finite() {
            return Err(HookRelease::Obstructed);
        }
        hook.phase = HookPhase::Pulling { target, length };
    } else if wall.is_finite() {
        return Err(HookRelease::Obstructed);
    } else if travelled + step >= tuning.range {
        return Err(HookRelease::Range);
    } else if view.start.tick + 1 >= hook.expires_at {
        return Err(HookRelease::Expired);
    } else {
        hook.phase = HookPhase::Flying {
            position: end,
            direction,
            travelled: travelled + step,
        };
    }
    Ok(hook)
}
