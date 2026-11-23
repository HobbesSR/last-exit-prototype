//! Heard gunfire (27.2 R11; 27.1 D27; `shared/simulation/hearing.ts`, #684).
//!
//! A shot reveals an area, not an actor. Each listener learns the centre of the discovery cell the
//! shooter fired from, through walls and roofs, until the cue fades. Resolve emits one
//! [`Fact::Heard`] per listener from S0: the shooter's pre-solve origin and the listeners active in
//! S0 at their pre-solve poses, as intake fired it. The fact is published with T's events, and the
//! listener's cue store takes it at the close of T, so a bot's intent first reads it at T+1. The
//! cue names its listener, so a projection shows each cue only to that listener.

use super::*;

/// The discovery grid's cell side (`DISCOVERY_CELL_SIZE` in `shared/discovery.ts`).
const CELL: f64 = 192.0;

/// A content's hearing: each weapon's range and how long a cue lasts.
#[derive(Clone, Debug)]
pub struct Hearing {
    /// Indexed in `WeaponKind` order.
    pub ranges: [f64; 3],
    pub ticks: Tick,
    /// The map's extent, which bounds the discovery grid.
    pub width: f64,
    pub height: f64,
}

impl Hearing {
    /// `cellCenter(cellIndexAt(...))`, or none off the map.
    fn cell_centre(&self, [x, y]: Point) -> Option<Point> {
        if x < 0.0 || y < 0.0 || x >= self.width || y >= self.height {
            return None;
        }
        let centre = |v: f64| (v / CELL).floor() * CELL + CELL / 2.0;
        Some([centre(x), centre(y)])
    }

    pub(super) fn resolve_into<C, P>(
        &self,
        view: &ResolveView<'_>,
        effects: &mut Effects<C, P>,
        shooter: ActorId,
        weapon: WeaponKind,
    ) {
        let start = |id: ActorId| Some(view.solved.path(BodyId::Actor(id))?[0]);
        let Some(origin) = start(shooter) else {
            return;
        };
        let Some(at) = self.cell_centre(origin) else {
            return;
        };
        let range = self.ranges[weapon as usize];
        let until = view.start.tick.saturating_add(self.ticks);
        for (&listener, actor) in &view.start.state.actors {
            if listener == shooter || actor.presence != Presence::Active {
                continue;
            }
            let Some([x, y]) = start(listener) else {
                continue;
            };
            let (dx, dy) = (x - origin[0], y - origin[1]);
            if dx * dx + dy * dy < range * range {
                effects.facts.push(Fact::Heard {
                    listener,
                    at: at.into(),
                    until,
                });
            }
        }
    }
}

/// A cue as its listener holds it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cue {
    pub at: Point,
    pub tick: Tick,
    pub until: Tick,
}

/// Each listener's cues, newest last, taken from published events.
#[derive(Default)]
pub(super) struct Cues(BTreeMap<ActorId, Vec<Cue>>);

impl Cues {
    /// One cue per cell: a repeat refreshes it and moves it last.
    pub(super) fn publish(&mut self, events: &[Event]) {
        for event in events {
            let Fact::Heard {
                listener,
                at,
                until,
            } = event.fact
            else {
                continue;
            };
            let at = at.position();
            let cues = self.0.entry(listener).or_default();
            cues.retain(|cue| cue.until > event.tick && cue.at != at);
            cues.push(Cue {
                at,
                tick: event.tick,
                until,
            });
        }
    }

    /// What `listener` still hears at `tick`, oldest first.
    pub(super) fn heard(&self, listener: ActorId, tick: Tick) -> Vec<Cue> {
        self.0.get(&listener).map_or_else(Vec::new, |cues| {
            cues.iter()
                .filter(|cue| cue.until > tick)
                .copied()
                .collect()
        })
    }
}
