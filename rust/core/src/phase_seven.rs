//! Phase 7's rules in the core (#1245, docs/27 "The state flip", step 5e.2): `finishMatch` (`lifecycle.ts`) and
//! `recordRewind` (`rewind.ts`). The body syncs and discovery around them were already the core's.
//!
//! **The rewind frames are the core's own.** `recordRewind` packs each player's position at the end of the tick,
//! and phase 5's casters (`combat.rs`) read the frames here, so no call packs them back. They never reached a
//! snapshot or a recording, so nothing in Node read them.
//!
//! **`finishMatch` reports, Node writes.** The match's phase, the stranded statuses and the `match_finished` event are
//! Node's records until the flip (#1214): the call reports whether the match finished, the event's ID and which
//! players are stranded, in roster order.
use std::collections::VecDeque;

/// `MAX_REWIND_TICKS` (`rewind.ts`): half a second at 20 Hz.
pub const MAX_REWIND_TICKS: usize = 10;
pub const MODE_FINISH: usize = 0;
pub const MODE_REWIND: usize = 1;
/// Input header: mode, tick, serial, player count, then for `MODE_FINISH` the slots and the match's duration.
pub const HEADER: usize = 6;
/// Per player: for `MODE_FINISH` role (0 contestant) and status (0 active); for `MODE_REWIND` x and y.
pub const ROW: usize = 2;
/// Output: length, finished (1 or 0), the `match_finished` event's ID (NaN when not finished), stranded count, then
/// the stranded roster indices.
pub const OUT_HEADER: usize = 4;

/// The last `MAX_REWIND_TICKS` frames, oldest first: each is `x, y` per player, in roster order as it stood.
#[derive(Default)]
pub struct Rewind {
    frames: VecDeque<Vec<f64>>,
}

impl Rewind {
    /// `recordRewind`: one frame, the oldest dropped past the window.
    pub fn record(&mut self, at: &[f64]) {
        let mut frame = if self.frames.len() >= MAX_REWIND_TICKS {
            self.frames.pop_front().unwrap_or_default()
        } else {
            Vec::new()
        };
        frame.clear();
        frame.extend_from_slice(at);
        self.frames.push_back(frame);
    }
    pub fn len(&self) -> usize {
        self.frames.len()
    }
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
    /// The frame `i` from the oldest kept.
    pub fn frame(&self, i: usize) -> &[f64] {
        &self.frames[i]
    }
}

#[derive(Default)]
pub struct PhaseSeven {
    pub input: Vec<f64>,
    pub output: Vec<f64>,
    pub rewind: Rewind,
}

impl PhaseSeven {
    pub fn run(&mut self) {
        let input = std::mem::take(&mut self.input);
        let h = &input[..HEADER];
        let (mode, tick, serial, players) = (h[0] as usize, h[1], h[2], h[3] as usize);
        let rows = &input[HEADER..HEADER + players * ROW];
        let mut out = std::mem::take(&mut self.output);
        out.clear();
        out.extend_from_slice(&[0.0, 0.0, f64::NAN, 0.0]);
        match mode {
            MODE_FINISH => {
                let (slots, duration) = (h[4], h[5]);
                let active_contestant = |i: usize| rows[i * ROW] == 0.0 && rows[i * ROW + 1] == 0.0;
                if slots == 0.0 || !(0..players).any(active_contestant) || tick >= duration {
                    out[1] = 1.0;
                    for i in (0..players).filter(|&i| active_contestant(i)) {
                        out.push(i as f64);
                    }
                    out[3] = (out.len() - OUT_HEADER) as f64;
                    // The `match_finished` event takes the next ID, after the statuses, as `event` took it.
                    out[2] = serial;
                }
            }
            MODE_REWIND => self.rewind.record(rows),
            _ => panic!("unknown phase 7 mode {mode}"),
        }
        out[0] = out.len() as f64;
        self.output = out;
        self.input = input;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finish(slots: f64, tick: f64, rows: &[f64]) -> Vec<f64> {
        let mut input = vec![
            MODE_FINISH as f64,
            tick,
            7.0,
            (rows.len() / ROW) as f64,
            slots,
            100.0,
        ];
        input.extend_from_slice(rows);
        let mut p = PhaseSeven {
            input,
            ..Default::default()
        };
        p.run();
        p.output.clone()
    }

    #[test]
    fn the_match_finishes_on_no_slots_no_active_contestant_or_time() {
        // A gladiator, an active contestant, an escaped one.
        let rows = [1.0, 0.0, 0.0, 0.0, 0.0, 3.0];
        let live = finish(2.0, 50.0, &rows);
        assert_eq!((live.len(), live[1], live[3]), (4, 0.0, 0.0), "still live");
        assert!(live[2].is_nan(), "no event");
        assert_eq!(
            finish(0.0, 50.0, &rows),
            vec![5.0, 1.0, 7.0, 1.0, 1.0],
            "no slots: the active contestant is stranded"
        );
        assert_eq!(
            finish(2.0, 100.0, &rows),
            vec![5.0, 1.0, 7.0, 1.0, 1.0],
            "time"
        );
        assert_eq!(
            finish(2.0, 50.0, &[1.0, 0.0, 0.0, 3.0]),
            vec![4.0, 1.0, 7.0, 0.0],
            "no contestant left active"
        );
    }

    #[test]
    fn rewind_keeps_the_last_frames_only() {
        let mut r = Rewind::default();
        for i in 0..MAX_REWIND_TICKS * 3 {
            r.record(&[i as f64, 0.0]);
        }
        assert_eq!(r.len(), MAX_REWIND_TICKS);
        assert_eq!(r.frame(0), &[(MAX_REWIND_TICKS * 2) as f64, 0.0]);
        assert_eq!(
            r.frame(MAX_REWIND_TICKS - 1),
            &[(MAX_REWIND_TICKS * 3 - 1) as f64, 0.0]
        );
    }
}
