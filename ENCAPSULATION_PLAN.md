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

## Completed September 11

- Replay encoding and filesystem archive ownership: `93bc904`.
- Match operations, room/session application, transport and timer adapters: `236f8a6`.
- Awaited, idempotent archive shutdown, including retired rooms: `1b9af8d`.
- Explicit live-frame field contracts, including nested equipment and world entities.
- Controlled crowd diagnostics separating actor placement from AI activity.

The priorities marked Now and the outbound-field Next item above are implemented.
See ENCAPSULATION_VERIFICATION.md for baseline comparisons, the measured filtering
cost and the remaining performance uncertainty. Product additions F-11 through
F-18 remain the next gameplay milestone, with a separate simulation/version review.

## Next implementation boundaries

### September 11 task selection after the user's policy answers

The inline answers below supersede the older assumption that all prototype
policies should remain defaults. They are accepted direction, not evidence that
the corresponding behavior is implemented. Preserve the completed extraction's
frozen fixtures while making intentional changes in separate checkpoints.

1. **Inventory drag/drop (F-13), completed this checkpoint.** Reuse validated `moveSlot` and
   `slot` + `drop` commands for mouse/touch gestures. Keep keyboard and button
   alternatives, cancel gestures over unrelated UI, and test source-slot selection,
   pointer cancellation and one-shot consumption. This needs no simulation or
   recording version change; tiers are a separate equipment change.
2. **Recording must not stop gameplay, next reliability task.** The current room
   loop explicitly pauses on `writer.blocked`, contrary to the new answer. First
   define a bounded recording queue and failure state: no unbounded buffering,
   no propagation of start/append/stream errors into match advancement, no false
   saved notification, and idempotent shutdown even after failure. A slow sink,
   permanently stalled sink, synchronous throw and asynchronous failure must all
   be tested with a fake clock and multiple rooms. Do not merely remove the
   backpressure check. Recoverable gaps require explicit tick/gap metadata and
   playback seeking by recorded time; today's playback indexes frames at 20 Hz.
   The lead owns that format/client contract before delegating implementation.
3. **Match capacities and content checkpoint (F-11).** Centralize the eight
   contestant/three gladiator capacities across spawning, lobby and matchmaking.
   Decide an explicit new gameplay/content version and how legacy characterization
   remains exercised before changing defaults; never regenerate the old fixture.
4. **Shared spatial reward/danger policy (F-12/F-15).** The user selected five
   virtual columns and rows, five mixed tier distributions, a horizontal base
   from 1 to 5, and vertical offsets 0/1/2 capped at tier 5. These zones do not
   alter map geometry. Track vertical novelty separately from quality. Tier
   statistics, distribution weights and special-item definitions still need
   concrete recorded tuning assumptions; preserve spawn/charger reservations.
5. **Physics evaluation (F-14).** Compare sliding/slowing surfaces, explosion
   impulses, pushing dynamic bodies and hook/drag corner cases at fixed ticks.
   Elevation/ballistics need a collision-plane contract before implementation.
   Profile geometry in controlled crowd workloads; current evidence has not
   established the cause of the reported severe slowdown.

Replay ownership/lifetime and BSON encoding, configurable spectator access/delay,
and lobby/game-server deployment remain separate follow-ups. The desired owner
exit lifetime still needs a precise relationship to refresh/reconnect grace;
current archives remain process-wide and persistent. Spectators are still owner
gated and delayed by default. Do not present either behavior as satisfying the
new policy answers. Public deployment is not part of this checkpoint.

The new requirements make three boundaries especially useful:

1. **Content and equipment.** One match-owned content bundle should define role
   capacities, weapon tier statistics and ammunition rules. Both spawn creation and
   matchmaking must read the same capacities when moving to three hunters. Keep
   item identity/remaining ammo separate from tier definitions. Drag/drop should
   produce existing validated inventory intents where possible; input/UI controllers own the
   gesture, and the server owns the resulting swap/drop. Resolve reload versus R
   rearrangement before changing controls. Pin content in recordings only after
   deciding compatibility; do not silently extend today's replay version.
2. **Generation difficulty and trap lifecycle.** Define one pure spatial difficulty
   calculation for vertical excursion and rightward progress. Pass its result to
   reward and danger placement separately, so safety reservations and spawn routes
   stay authoritative. Separate trap activation/cooldown/rearming state from its
   visible tell; concealment must apply to world rendering and minimap. Do not infer
   that deactivation means rearming or that reward and danger share identical curves.
3. **Physics and geometry.** Keep forces, impulses, velocity integration and friction
   inside authoritative ticks, with shared prediction and bounded substeps. Establish
   collision/query ownership before selecting an engine. Evaluate custom and middleware
   implementations against the same corner, tunneling, resting-contact, crowd and
   replay workloads, including allocations and worst-frame cost. Avoid parallel
   geometry caches with different door/obstacle invalidation rules. Current diagnostics
   make bot sight/query work a useful profiling target, not proof that middleware or a
   geometry rewrite is needed.

The more difficult production work remains versioned content, session routing and
draining, archive retention/access, and idempotent persistent match results. These
need the batch policies below. Do not build a service registry or split processes
before those ownership and failure contracts have concrete consumers.

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
   Let's say worldwide for now. Imagine we deploy this on a VPS and other turn key services for deploying something like this as a live service.
2. Deployment behavior: finish matches on the old server version, reconnect to a
   replacement, or tolerate interrupted matches? Is crash recovery required?
   So I guess you know there is the lobby server and then there are the spawned game server. So I guess when you come back to join a new game yoru client will have to update.
3. Replay policy: who may download full-state recordings, how long are they kept,
   and how long must old recordings remain playable?
      - Replays can only be downloaded by the room owner. They last as long as the owner has not exited the game. Ideally replays will be stored in BSON and recorded in JSON only for debugging.
4. Content rollout: should a match always retain its starting balance/content,
   and are simultaneous balance variants/experiments needed?
5. Persistent progression/rewards: which outcomes survive a match, and what must
   happen when storage fails or the same result is delivered twice?
6. Observer fairness: public spectators/presenters, delay policy, and whether the
   same person may participate and observe through separate sessions?
      - We should plan to be able to restrict who is allowed to spectate, but not implement it. We should plan to be able to delay spectation,
      but not automatically do it. During the initial bring up of the game, we will not worry about whether there are bad actors, we simply tolerate
      them during rapid development. But we try not to box ourselves in.
7. Failure policy: if recording cannot keep up or fails, pause the match, continue
   without a replay, or end it? Current disk backpressure pauses advancement.
      - Recording replay should not impact gameplay. If replay fails for some reason it should
      fail gracefully for all clients and systems. If replay can be recovered, playback should
      handle missing data gracefully.

Keep the existing map hierarchy, multi-floor, balance and presentation questions
in REQUIREMENTS.md; this batch supplements them.
