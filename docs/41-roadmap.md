# 41. Roadmap

The next useful boundaries, in the order they should be taken. Accepted features
and their status are in [13](13-accepted-features.md); the policy answers that
shape the later items are in [17](17-open-questions.md).

## Standing priorities

Module extraction alone does not establish ownership. The completed server match
lifecycle work removed transport mutations of players, scheduling dependencies on
gzip flags, replay writers' room mutations, and finalization outliving shutdown.
These were the concrete sources of cross-system changes behind this sequence.

| Priority | Work | Benefit and acceptance condition |
| --- | --- | --- |
| Done | Match access boundary | Server application uses named join/resume/leave/input/step/end/query operations; transport never edits game state. Snapshot/command fixtures were preserved. |
| Done | Replay writer and archive adapter | Private gzip/hash/filesystem state; room orchestration depends on append/backpressure/finalize/list/open operations. Replay JSON and integrity hash were preserved. |
| Done | Room/session application separate from HTTP/WebSocket and timers | Joins, reconnects, delay, catch-up, abandonment and shutdown run with fake sessions/time/storage. Integration/browser suites cover the boundary. |
| Done | Owned asynchronous shutdown | Every started finalization is awaited; repeated close/finalize is idempotent. Slow/failing storage is tested directly. This reliability change was recorded separately from extraction. |
| Done | Explicit outbound field contracts | Allowlists with frozen projection comparisons and nested item/trap contracts prevent new server-only fields from automatically appearing in player views. |
| Done | Versioned immutable match content | Weapons, kits and the tick-denominated rules are pinned and frozen at match creation and read from the match rather than from module constants; the recording header names the set. Trap reach, damage and cadence followed. Map generation needs no equivalent and deliberately does not get one: see below. |
| Later | Typed gameplay facts | Separate replayable facts from presentation strings/effects; events carry stable IDs and schemas. Establish actual consumers before broad instrumentation or progression integration. |
| Later | Deployment/session compatibility | Distinct account/session/player/match identities, admission/draining, reconnect routing and compatibility negotiation. Requires product/hosting decisions. |
| Profile first | Geometry and renderer component extraction | Preserve shared cache ownership, query semantics and render order. Split when a concrete change/measurement justifies it. |

Map generation tuning was the one part of that item left unpinned, and on inspection it
should stay that way. Generation runs *before* a match exists, and what it produces is
already captured twice over: the game holds the generated map for its lifetime, and the
recording header embeds it whole. That is a stronger guarantee than pinning the tuning
would give, because it captures the artifact rather than the recipe — a later generator
change cannot alter what an existing recording means, and no reconstruction step can
disagree with what was played. Extracting the generator's constants would also be
extracting the wrong thing: most are algorithm shape (`i % 6 === 0`, a distance
threshold that separates spawns from loot) rather than a balance table anyone would
tune, and moving them would put the seeded RNG and ID order at risk for no consumer.

Use ordinary functions and explicit dependencies in one process. A future worker
boundary should follow the match API; this boundary does not require workers, service
discovery, a new database, TypeScript migration or an internal gameplay event bus.
Transport envelope parsing and simulation input validation are different layers:
slot and input validation depends on player state and remains authoritative.

The priorities marked Done are implemented, as are inventory drag/drop
(F-13) and the recording failure policy. The completed
checkpoints and what they measured are in [42](42-performance-history.md).
F-11 is now implemented as `content-2`; F-12 and the remaining accepted additions
still need separate gameplay and version review.

## Next tasks

**Current focus, updated by the user on 2026-09-23: F-01 micro generation.**
The SDK now includes immutable child contexts, bounded polyomino analysis,
candidate-to-generator allocation, residual ownership, structural interfaces and
independent plan validation. The allocation visualizer and focused analysis/
allocation tests exercise that layer. It is deliberately not a physical geometry
or route generator: grid depth/width are not clearance, seams are only portal
opportunities, and bounded beam search reports diagnostics rather than optimality.
The combined generation demo now realizes example assignments, constructs paired
two-cell portals, checks cross-child swept routes, and supports walking through
the resulting structures. Allocation controls auto-apply and explain unchanged
winners; contrasting presets expose policy effects. Next generalize dispatch and
portal negotiation beyond this explicit demo policy. The decomposition lab now
also compares bounded recursive allocation trees under alternate objectives, with
branch inspection and explicit terminal residuals. This does not yet execute those
trees as physical micro generation. SDK access/boundary utilities now validate
post-generation crossing and connectivity obligations, inherit complete external
runs and pair inter-child requirements; nested composition tests exercise this
contract. Use those checks when adding recursive execution. Then address the sibling
adapter and recursive execution. Future macro integration still needs a
unit/ownership adapter, explicit port translation and whole-map physical route
validation; the sibling remains independent. See [19](19-decomposition-design.md),
[20](20-micro-generation.md) and the recorded choices in [17](17-open-questions.md).

The sequencing below remains the other gameplay backlog, not an instruction to
leave the current micro-generation effort for reward tiers.

These supersede the older assumption that all prototype policies should remain
defaults. They are accepted direction, not evidence that the corresponding behavior
is implemented. Preserve the completed extraction's frozen fixtures while making
intentional changes in separate checkpoints.

1. **Completed: match capacities and content checkpoint (F-11).** `content-2`
   appends a third hunter using Striker; eight contestants and three extraction
   slots remain. Spawning, admission, matchmaking fractions and lobby capacities
   read the pinned roster. Rules stay `last-exit-0.7`, recording schema stays 3/0:
   only content data changed. The unchanged `netcode-1` fixture runs explicitly
   with retained `content-1`, while new tests cover the three-hunter default and
   full-room admission. See [14](14-match-rules.md), [26](26-recording-contract.md)
   and [31](31-verification.md).
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

The more difficult production work remains content rollout policy, session routing and
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
