//! Exact-tick history for lag-compensated eligibility queries.

use std::collections::BTreeMap;

use crate::phase_seven::MAX_REWIND_TICKS;

use super::{ActorId, BodyId, GateId, ItemId, Point, Solved, Tick, View};

/// A post-apply record of the data used for eligibility at one tick (27.2 R3, R12).
///
/// Actor poses are whole: every active actor's committed pose. Items and gates record only
/// what changed in the tick, with the value before it, so capture follows the active set and
/// not the map (#635). A lookup reconstructs any retained tick from the changes around it.
#[derive(Default)]
pub struct RewindFrame {
    pub poses: BTreeMap<ActorId, Point>,
    /// Ground items whose pose changed or that entered the ground, at the end of the tick.
    pub items: BTreeMap<ItemId, Point>,
    /// Gates whose state changed, as at the end of the tick. Gate ID to open state.
    pub gates: BTreeMap<GateId, bool>,
    /// The pose each changed item held before the tick. An item that entered has none.
    pub items_before: BTreeMap<ItemId, Point>,
    /// The state each changed gate held before the tick.
    pub gates_before: BTreeMap<GateId, bool>,
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

    pub fn frame(&self, tick: Tick) -> Option<&RewindFrame> {
        self.frames.get(&tick)
    }

    /// The value a changing record held at the end of `target`: the latest change at or
    /// before it, or else the value before the first later change. `None` means no retained
    /// frame knows, and the caller uses the current value.
    fn value_at<K: Ord + Copy, V: Copy>(
        &self,
        target: Tick,
        key: K,
        after: impl Fn(&RewindFrame) -> &BTreeMap<K, V>,
        before: impl Fn(&RewindFrame) -> &BTreeMap<K, V>,
    ) -> Option<V> {
        self.frames
            .range(..=target)
            .rev()
            .find_map(|(_, frame)| after(frame).get(&key).copied())
            .or_else(|| {
                self.frames
                    .range(target + 1..)
                    .find(|(_, frame)| after(frame).contains_key(&key))
                    .and_then(|(_, frame)| before(frame).get(&key).copied())
            })
    }
}

/// Eligibility view at the clamped requested tick. Current activity is checked by the caller.
pub struct Rewound<'a> {
    view: View<'a>,
    solved: &'a Solved,
    history: &'a RewindHistory,
    /// The requested tick, when history holds its frame. Otherwise every query is current.
    target: Option<(Tick, &'a RewindFrame)>,
}

impl<'a> Rewound<'a> {
    pub(super) fn new(
        view: View<'a>,
        solved: &'a Solved,
        history: &'a RewindHistory,
        view_lag: Tick,
    ) -> Self {
        let lag = view_lag.min(MAX_REWIND_TICKS as Tick);
        let target = if lag == 0 {
            None
        } else {
            view.tick
                .checked_sub(lag)
                .and_then(|tick| history.frames.get(&tick).map(|frame| (tick, frame)))
        };
        Self {
            view,
            solved,
            history,
            target,
        }
    }

    /// Test sight using static edges and the gate state at the requested tick.
    pub fn line_clear(&self, from: Point, to: Point) -> bool {
        self.line_clear_ignoring(from, to, None)
    }

    pub(super) fn line_clear_ignoring(
        &self,
        from: Point,
        to: Point,
        ignore: Option<GateId>,
    ) -> bool {
        crate::collision::line_clear_with_gates(
            self.view.sight,
            self.view.sight_gates,
            (from[0], from[1]),
            (to[0], to[1]),
            |index| ignore == Some(GateId(index as u32)) || self.gate_open(index),
        )
        .0
    }

    pub fn reach_clear(&self, from: Point, to: Point) -> bool {
        crate::collision::reach_clear_with_gates(
            self.view.sight,
            self.view.sight_gates,
            (from[0], from[1]),
            (to[0], to[1]),
            |index| self.gate_open(index),
        )
        .0
    }

    pub(super) fn gate_open(&self, index: usize) -> bool {
        let id = GateId(index as u32);
        self.target
            .and_then(|(tick, _)| {
                self.history
                    .value_at(tick, id, |f| &f.gates, |f| &f.gates_before)
            })
            .unwrap_or_else(|| self.view.state.gates.get(&id).is_some_and(|gate| gate.open))
    }

    pub fn item_position(&self, target: ItemId) -> Option<Point> {
        let item = self.view.state.items.get(&target)?;
        let body_position = self.solved.position(BodyId::Item(target));
        // A bodiless drop can reuse an ID with history from an earlier time on the ground.
        self.target
            .filter(|_| body_position.is_some())
            .and_then(|(tick, _)| {
                self.history
                    .value_at(tick, target, |f| &f.items, |f| &f.items_before)
            })
            .or_else(|| item.position(body_position))
    }
    /// The target's historical pose, or its current post-solve pose if absent.
    pub fn position(&self, target: ActorId) -> Option<Point> {
        self.target
            .and_then(|(_, frame)| frame.poses.get(&target).copied())
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

    #[test]
    fn change_only_frames_reconstruct_items_and_gates_at_any_retained_tick() {
        let (item, entered, gate) = (ItemId(1), ItemId(2), GateId(0));
        let mut history = RewindHistory::default();
        for tick in 1..=6 {
            let mut frame = RewindFrame::default();
            match tick {
                // The item rests at [1, 0], moves in tick 3 and again in tick 5.
                3 => {
                    frame.items.insert(item, [2.0, 0.0]);
                    frame.items_before.insert(item, [1.0, 0.0]);
                    frame.items.insert(entered, [9.0, 0.0]);
                    frame.gates.insert(gate, true);
                    frame.gates_before.insert(gate, false);
                }
                5 => {
                    frame.items.insert(item, [3.0, 0.0]);
                    frame.items_before.insert(item, [2.0, 0.0]);
                }
                _ => {}
            }
            history.insert(tick, frame);
        }
        let item_at = |tick| history.value_at(tick, item, |f| &f.items, |f| &f.items_before);
        let gate_at = |tick| history.value_at(tick, gate, |f| &f.gates, |f| &f.gates_before);
        let entered_at = |tick| history.value_at(tick, entered, |f| &f.items, |f| &f.items_before);
        assert_eq!(
            [1, 2, 3, 4, 5, 6].map(item_at),
            [
                [1.0, 0.0],
                [1.0, 0.0],
                [2.0, 0.0],
                [2.0, 0.0],
                [3.0, 0.0],
                [3.0, 0.0]
            ]
            .map(Some)
        );
        assert_eq!(
            [2, 3, 6].map(gate_at),
            [Some(false), Some(true), Some(true)]
        );
        // Before it entered, nothing is known and the caller falls back to the current pose.
        assert_eq!([2, 3].map(entered_at), [None, Some([9.0, 0.0])]);
        // A record no frame mentions never changed in the window.
        assert_eq!(
            history.value_at(2, GateId(7), |f| &f.gates, |f| &f.gates_before),
            None
        );
    }
}
