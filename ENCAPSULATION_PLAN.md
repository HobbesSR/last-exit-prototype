# Encapsulation toward a live-service foundation

Starting checkpoint: `fa1e1b9`. Preserve gameplay, simulation version, recorded
frames/commands, HTTP/WebSocket messages and existing prototype policies.

## Reassessment

Module extraction alone does not establish ownership. The next useful boundary is
the server's match lifecycle: transport currently mutates players, tick scheduling
reads gzip stream flags, replay writers mutate rooms, and asynchronous finalization
can outlive server shutdown. These are concrete sources of cross-system changes.

| Priority | Work | Benefit and acceptance condition |
| --- | --- | --- |
| Now | Match access boundary | Server application uses named join/resume/leave/input/step/end/query operations; transport never edits game state. Preserve snapshot/command fixtures. |
| Now | Replay writer and archive adapter | Private gzip/hash/filesystem state; room orchestration depends on append/backpressure/finalize/list/open operations. Preserve replay JSON and integrity hash. |
| Now | Room/session application separate from HTTP/WebSocket and timers | Run joins, reconnects, delay, catch-up, abandonment and shutdown with fake sessions/time/storage. Existing integration/browser suites still pass. |
| Now | Owned asynchronous shutdown | Every started finalization is awaited; repeated close/finalize is idempotent. Test slow/failing storage directly. Record this reliability change separately from extraction. |
| Next | Explicit outbound field contracts | New server-only fields must not automatically appear in player views. Introduce allowlists with frozen projection comparisons and nested item/trap contracts. |
| Next | Versioned immutable match content | Pin weapons/kits/traps/map tuning at match creation; identify content in recordings. Requires replay/content compatibility policy before changing existing formats. |
| Later | Typed gameplay facts | Separate replayable facts from presentation strings/effects; events carry stable IDs and schemas. Establish actual consumers before broad instrumentation or progression integration. |
| Later | Deployment/session compatibility | Distinct account/session/player/match identities, admission/draining, reconnect routing and compatibility negotiation. Requires product/hosting decisions. |
| Profile first | Geometry and renderer component extraction | Preserve shared cache ownership, query semantics and render order. Split when a concrete change/measurement justifies it. |

Use ordinary functions and explicit dependencies in one process. A future worker
boundary should follow the match API; this pass does not require workers, service
discovery, a new database, TypeScript migration or an internal gameplay event bus.
Transport envelope parsing and simulation input validation are different layers:
slot/input latching depends on player state and remains authoritative.

## Implementation sequence

1. Establish current baseline with full checks/browser tests and benchmarks.
2. Extract replay storage/recording with focused format/backpressure/failure tests.
3. Extract match API, room/session lifecycle, timer loop and transport adapters.
   Preserve the original policy order and add fake-clock/fake-session tests.
4. Fix the established shutdown/finalization ownership gap in a separate checkpoint.
5. Run frozen characterization, complete checks/browser tests and comparable timing.
   Investigate suspected regressions with three repeats. Document ownership and
   refresh the existing untracked handoff without discarding earlier notes.

The `createArenaServer().rooms` diagnostic surface is used by browser tests to
arrange scenarios. Retain its `room.game` inspection escape hatch for compatibility,
but prohibit application/transport code from using it. Removing this mutable test
surface is a later hardening step; do not claim complete process isolation yet.

## Batch questions for later

No answer is required for the initial implementation. Existing prototype behavior
remains the default until these policies are decided.

1. First release: private invited playtests, public anonymous play, or accounts?
   What concurrent players/matches and geographic footprint should we plan for?
2. Deployment behavior: finish matches on the old server version, reconnect to a
   replacement, or tolerate interrupted matches? Is crash recovery required?
3. Replay policy: who may download full-state recordings, how long are they kept,
   and how long must old recordings remain playable?
4. Content rollout: should a match always retain its starting balance/content,
   and are simultaneous balance variants/experiments needed?
5. Persistent progression/rewards: which outcomes survive a match, and what must
   happen when storage fails or the same result is delivered twice?
6. Observer fairness: public spectators/presenters, delay policy, and whether the
   same person may participate and observe through separate sessions?
7. Failure policy: if recording cannot keep up or fails, pause the match, continue
   without a replay, or end it? Current disk backpressure pauses advancement.

Keep the existing map hierarchy, multi-floor, balance and presentation questions
in REQUIREMENTS.md; this batch supplements them.
