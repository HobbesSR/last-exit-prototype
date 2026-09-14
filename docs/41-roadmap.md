# 41. Roadmap

The next useful boundaries, in the order they should be taken. Accepted features
and their status are in [13](13-accepted-features.md); the policy answers that
shape the later items are in [17](17-open-questions.md).

## Standing priorities

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
| Done | Versioned immutable match content | Weapons, kits and the tick-denominated rules are pinned and frozen at match creation and read from the match rather than from module constants; the recording header names the set. Trap tunables and map generation tuning are still module-level literals and are the remaining surface — the mechanism to absorb them now exists. |
| Later | Typed gameplay facts | Separate replayable facts from presentation strings/effects; events carry stable IDs and schemas. Establish actual consumers before broad instrumentation or progression integration. |
| Later | Deployment/session compatibility | Distinct account/session/player/match identities, admission/draining, reconnect routing and compatibility negotiation. Requires product/hosting decisions. |
| Profile first | Geometry and renderer component extraction | Preserve shared cache ownership, query semantics and render order. Split when a concrete change/measurement justifies it. |

Use ordinary functions and explicit dependencies in one process. A future worker
boundary should follow the match API; this boundary does not require workers, service
discovery, a new database, TypeScript migration or an internal gameplay event bus.
Transport envelope parsing and simulation input validation are different layers:
slot and input validation depends on player state and remains authoritative.

The priorities marked Now and Done are implemented, as are inventory drag/drop
(F-13) and the recording failure policy. The completed
checkpoints and what they measured are in [42](42-performance-history.md).
F-11 through F-18 are the next gameplay milestone, with a separate simulation and
version review.

## Next tasks

These supersede the older assumption that all prototype policies should remain
defaults. They are accepted direction, not evidence that the corresponding behavior
is implemented. Preserve the completed extraction's frozen fixtures while making
intentional changes in separate checkpoints.

1. **Match capacities and content checkpoint (F-11).** Centralize the eight
   contestant/three gladiator capacities across spawning, lobby and matchmaking.
   Decide an explicit new gameplay/content version and how legacy characterization
   remains exercised before changing defaults; never regenerate the old fixture.
2. **Shared spatial reward/danger policy (F-12/F-15).** The user selected five
   virtual columns and rows, five mixed tier distributions, a horizontal base
   from 1 to 5, and vertical offsets 0/1/2 capped at tier 5. These zones do not
   alter map geometry. Track vertical novelty separately from quality. Tier
   statistics, distribution weights and special-item definitions still need
   concrete recorded tuning assumptions; preserve spawn/charger reservations.
3. **Physics evaluation (F-14).** Compare sliding/slowing surfaces, explosion
   impulses, pushing dynamic bodies and hook/drag corner cases at fixed ticks.
   Elevation/ballistics need a collision-plane contract before implementation.
   Profile geometry in controlled crowd workloads; current evidence has not
   established the cause of the reported severe slowdown.

## Boundaries these tasks need

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
need the batch policies in [17](17-open-questions.md). Do not build a service registry or split processes
before those ownership and failure contracts have concrete consumers.

## Separate follow-ups

Replay ownership/lifetime and BSON encoding, configurable spectator access/delay,
and lobby/game-server deployment remain separate follow-ups. The desired owner
exit lifetime still needs a precise relationship to refresh/reconnect grace;
current archives remain process-wide and persistent. Spectators are still owner
gated and delayed by default. Do not present either behavior as satisfying the
new policy answers. Public deployment is not authorized here.

`createArenaServer().rooms` retains `room.game` for scenario setup and benchmarks.
Removing that mutable test surface is a later hardening step; until then, do not
claim complete process isolation. Public deployment limits are in
[28](28-operational-limits.md).
