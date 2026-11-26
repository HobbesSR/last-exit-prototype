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
//! - **Who may receive what, and what each contestant has learned** (`admission.rs`, #1357): the
//!   spatial index of the map-sized records, kept from each completed tick's output, and the
//!   order each contestant's discovered cells were learned in.

use std::collections::BTreeMap;

use super::admission::{Learned, Radii, Spatial};
use super::apply::{Event, Fact};
use super::output::{Changes, Discontinuity, Pose};
use super::{ActorId, BodyId, Memory, Point, State, Tick};
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

/// Effect radii (`action_combat.rs` and the retired phase engines).
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
    /// The last completed tick.
    pub(super) tick: Tick,
    /// Where each actor last stood: its body's pose, kept when the body leaves.
    at: BTreeMap<ActorId, Point>,
    /// The effects still drawn, oldest first.
    effects: Vec<Effect>,
    /// Where the drawn bodies, ground items and traps are, indexed by cell.
    pub(super) space: Spatial,
    /// Each remembering contestant's discovered cells, in the order they were learned.
    learned: BTreeMap<ActorId, Learned>,
}

impl Presentation {
    /// The match at its start: the state and every dynamic body's pose, and the radii the bodies
    /// are drawn with. Where an actor stands is its body's pose; one without a body is told by
    /// [`Presentation::stand`].
    pub fn start(state: &State, poses: &BTreeMap<BodyId, Pose>, radii: Radii) -> Self {
        let at = poses.iter().filter_map(|(&body, pose)| match body {
            BodyId::Actor(actor) => Some((actor, pose.at)),
            _ => None,
        });
        Self {
            tick: 0,
            at: at.collect(),
            effects: Vec::new(),
            space: Spatial::start(state, poses, radii),
            learned: BTreeMap::new(),
        }
    }

    /// An effect a scenario arranged before the start, drawn until `expires_at` as a made one is.
    /// The frame store hands each one over in its order, so the effects' indices stay aligned
    /// with the frame's (review 1132).
    pub fn arrange(&mut self, kind: EffectKind, at: Point, radius: f64, expires_at: Tick) {
        self.effects.push(Effect {
            event: u32::MAX,
            kind,
            at,
            radius,
            expires_at,
        });
    }

    /// Where an actor stands when it has no body at the start, if nothing is known yet.
    pub fn stand(&mut self, actor: ActorId, at: Point) {
        self.at.entry(actor).or_insert(at);
    }

    /// An actor's discovered cells as of the last refresh, in the order they were learned, or
    /// none when it keeps no memory.
    pub fn learned(&self, actor: ActorId) -> Option<&[u32]> {
        self.learned.get(&actor).map(Learned::cells)
    }

    /// Refresh an actor's learned cells from its memory: the cells not yet known, ascending.
    pub fn learn(&mut self, actor: ActorId, memory: Option<&Memory>) {
        if let Some(memory) = memory {
            self.learned
                .entry(actor)
                .or_default()
                .learn(&memory.discovered);
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
    pub fn take(
        &mut self,
        tick: Tick,
        changes: &Changes,
        discontinuities: &[Discontinuity],
        state: &State,
        blast: f64,
    ) -> &[Effect] {
        self.tick = tick;
        self.space.take(changes, discontinuities);
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

    pub fn from_code(code: u32) -> Option<Self> {
        [
            Self::Slash,
            Self::Shock,
            Self::Scan,
            Self::Upgrade,
            Self::Loot,
            Self::Rail,
            Self::Charge,
            Self::Grapple,
        ]
        .get(code as usize)
        .copied()
    }
}
