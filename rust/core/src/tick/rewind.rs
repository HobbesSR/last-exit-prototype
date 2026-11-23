//! Exact-tick history for lag-compensated eligibility queries.

use std::collections::BTreeMap;

use crate::phase_seven::MAX_REWIND_TICKS;

use super::{ActorId, BodyId, GateId, Point, Solved, Tick, View};

/// A post-apply snapshot of the data used for eligibility.
#[derive(Default)]
pub struct RewindFrame {
    pub poses: BTreeMap<ActorId, Point>,
    /// Gate ID to open state.
    pub gates: BTreeMap<GateId, bool>,
}

/// Bounded history keyed by the exact tick at which each frame was captured.
#[derive(Default)]
pub struct RewindHistory {
    frames: BTreeMap<Tick, RewindFrame>,
}

impl RewindHistory {
    /// Insert or replace a frame. Only the most recent retained ticks remain.
    pub fn insert(&mut self, tick: Tick, frame: RewindFrame) {
        self.frames.insert(tick, frame);
        while self.frames.len() > MAX_REWIND_TICKS {
            self.frames.pop_first();
        }
    }
}

/// Eligibility view at the clamped requested tick. Current activity is checked by the caller.
pub struct Rewound<'a> {
    view: View<'a>,
    solved: &'a Solved,
    frame: Option<&'a RewindFrame>,
}

impl<'a> Rewound<'a> {
    pub(super) fn new(
        view: View<'a>,
        solved: &'a Solved,
        history: &'a RewindHistory,
        view_lag: Tick,
    ) -> Self {
        let lag = view_lag.min(MAX_REWIND_TICKS as Tick);
        let frame = if lag == 0 {
            None
        } else {
            view.tick
                .checked_sub(lag)
                .and_then(|tick| history.frames.get(&tick))
        };
        Self {
            view,
            solved,
            frame,
        }
    }

    /// Test sight using static edges and the gate state at the requested tick.
    pub fn line_clear(&self, from: Point, to: Point) -> bool {
        crate::collision::line_clear_with_gates(
            self.view.sight,
            self.view.sight_gates,
            (from[0], from[1]),
            (to[0], to[1]),
            |index| {
                let id = GateId(index as u32);
                self.frame
                    .and_then(|frame| frame.gates.get(&id).copied())
                    .unwrap_or_else(|| self.view.state.gates.get(&id).is_some_and(|gate| gate.open))
            },
        )
        .0
    }
    /// The target's historical pose, or its current post-solve pose if absent.
    pub fn position(&self, target: ActorId) -> Option<Point> {
        self.frame
            .and_then(|frame| frame.poses.get(&target).copied())
            .or_else(|| self.solved.position(BodyId::Actor(target)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_keeps_latest_exact_ticks_and_replaces_frames() {
        let mut history = RewindHistory::default();
        for tick in 1..=MAX_REWIND_TICKS as Tick + 1 {
            history.insert(tick * 2, RewindFrame::default());
        }
        assert_eq!(history.frames.len(), MAX_REWIND_TICKS);
        assert!(!history.frames.contains_key(&2));
        assert!(!history.frames.contains_key(&5));
        assert!(history.frames.contains_key(&4));
        let mut frame = RewindFrame::default();
        frame.gates.insert(GateId(3), true);
        history.insert(4, frame);
        assert_eq!(history.frames.len(), MAX_REWIND_TICKS);
        assert_eq!(history.frames[&4].gates.get(&GateId(3)), Some(&true));
        history.insert(1, RewindFrame::default());
        assert!(!history.frames.contains_key(&1));
    }
}
