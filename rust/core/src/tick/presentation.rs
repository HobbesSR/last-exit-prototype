//! What a completed tick presents beside its records (27.2 "Projection and knowledge"): the
//! effects T's facts make, with where each one is drawn. Derived from the core's own output,
//! never simulation truth, so nothing here reaches a rule, a snapshot or a recording.
//!
//! - **Effects.** A fact that is drawn (a slash, a pulse, a pickup, a rail, a blast, …) makes
//!   one effect of a fixed kind and radius at the committed poses. Node's frame store gives each
//!   its serial and record; the core keeps where it is and until when, which is what deciding
//!   who may receive it needs (#1357).
//! - **Where an actor stands.** Its body's committed pose, or, without a body, where it last
//!   stood.

use std::collections::BTreeMap;

use super::apply::{Event, Fact};
use super::output::Changes;
use super::{ActorId, BodyId, Point, State, Tick};
use crate::math::{cos, sin};

/// How long an effect is drawn, in ticks: its `life` on the tick it is made.
pub const EFFECT_LIFE: Tick = 12;

/// The effects' kinds, in the order their codes follow (`EFFECT_KINDS` in `tick-codec.ts`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectKind {
    Slash,
    Shock,
    Scan,
    Upgrade,
    Loot,
    Rail,
    Charge,
    Grapple,
}

/// The old effect radii (`rust/core/src/action_combat.rs`, `combat.rs`, `hazards.rs`, `phase_six.rs`).
const SLASH: f64 = 55.0;
const SLASH_REACH: f64 = 30.0;
const SHOCK: f64 = 130.0;
const SCAN: f64 = 450.0;
const UPGRADE: f64 = 75.0;
const LOOT: f64 = 30.0;
const RAIL: f64 = 60.0;
const CHARGE: f64 = 70.0;
const GRAPPLE: f64 = 35.0;

/// One effect a tick made: the event it presents (its index in T's events), its kind, where it
/// is drawn and how far it reaches, and the first tick it is no longer drawn.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Effect {
    pub event: u32,
    pub kind: EffectKind,
    pub at: Point,
    pub radius: f64,
    pub expires_at: Tick,
}

#[derive(Default)]
pub struct Presentation {
    /// Where each actor last stood: its body's pose, kept when the body leaves.
    at: BTreeMap<ActorId, Point>,
    /// The effects still drawn, oldest first.
    effects: Vec<Effect>,
}

impl Presentation {
    /// Where each actor stands at the start.
    pub fn new(at: impl IntoIterator<Item = (ActorId, Point)>) -> Self {
        Self {
            at: at.into_iter().collect(),
            effects: Vec::new(),
        }
    }

    /// Where an actor stands, or last stood.
    pub fn at(&self, actor: ActorId) -> Option<Point> {
        self.at.get(&actor).copied()
    }

    /// The effects drawn at the last completed tick, oldest first.
    pub fn effects(&self) -> &[Effect] {
        &self.effects
    }

    /// A completed tick: its committed poses, then the effects its facts make. Returns those.
    pub fn take(&mut self, tick: Tick, changes: &Changes, state: &State, blast: f64) -> &[Effect] {
        for (&body, pose) in &changes.poses {
            if let BodyId::Actor(actor) = body {
                self.at.insert(actor, pose.at);
            }
        }
        self.effects.retain(|e| e.expires_at > tick);
        let made = self.effects.len();
        for (index, event) in changes.events.iter().enumerate() {
            if let Some((kind, at, radius)) = self.effect_of(event, state, blast) {
                self.effects.push(Effect {
                    event: index as u32,
                    kind,
                    at,
                    radius,
                    expires_at: tick + EFFECT_LIFE,
                });
            }
        }
        &self.effects[made..]
    }

    fn effect_of(
        &self,
        event: &Event,
        state: &State,
        blast: f64,
    ) -> Option<(EffectKind, Point, f64)> {
        let actor = |id: ActorId| {
            self.at(id)
                .unwrap_or_else(|| panic!("presentation: {id:?} has never stood anywhere"))
        };
        Some(match event.fact {
            Fact::CellCharged { actor: id, .. } => (EffectKind::Charge, actor(id), CHARGE),
            Fact::MeleeSwung { actor: id } => {
                let [x, y] = actor(id);
                let heading = state.actors[&id].aim;
                (
                    EffectKind::Slash,
                    [
                        x + cos(heading) * SLASH_REACH,
                        y + sin(heading) * SLASH_REACH,
                    ],
                    SLASH,
                )
            }
            Fact::WardenPulsed { actor: id } => (EffectKind::Shock, actor(id), SHOCK),
            Fact::SpecterScanned { actor: id } => (EffectKind::Scan, actor(id), SCAN),
            Fact::Boosted { actor: id } => (EffectKind::Upgrade, actor(id), UPGRADE),
            Fact::UtilityUsed { actor: id, .. } | Fact::Pickup { actor: id, .. } => {
                (EffectKind::Loot, actor(id), LOOT)
            }
            Fact::TransitDeparted { actor: id, .. } | Fact::TransitLanded { actor: id, .. } => {
                (EffectKind::Rail, actor(id), RAIL)
            }
            Fact::MineExploded { trap } => (EffectKind::Shock, state.traps[&trap].position, blast),
            Fact::SpiderGrappled { at, .. } => (EffectKind::Grapple, at.position(), GRAPPLE),
            _ => return None,
        })
    }
}

impl EffectKind {
    pub fn code(self) -> u32 {
        self as u32
    }
}
