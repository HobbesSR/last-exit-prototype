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

### Hierarchical navigation design (#353)

Issue [#353](http://192.168.1.170:3000/corey/astra_test/issues/353) tracked the
navigation hierarchy and optimistic planning through unknown space. Corey set the
direction on 2026-10-21: region portals as the top level, a free-space navmesh
beneath, discovery cells as each contestant's filter, all derived at load. Built
in stages (#420, #422, #423, #424, then #470's sliced replanning and local repair);
the middle level (#425) and #470's coarse far-away plans were not needed. Closed
2026-10-25; playtesting findings get new issues. Design and stages are in
[22.6](22.6-hierarchical-navigation.md).

### Generation pipeline

Map generation became one pipeline under the user's 2026-09-28 and 29 direction:
the generation chain ([51](51-generation-chain.md)), with each region type's
strategy built on the micro SDK ([50](50-map-generation.md)). What has shipped:

- **The chain and the switch-over** (tracks A to C, 51 step 10, #144 to #146;
  tracker #82, closed). The Map Lab, CLI and MCP run on the chain from
  `map/tools/`, and mapgen's old paths are deleted. Live rooms run the chain
  through `map/live.ts`, with explicit mask bounds and authored transit (14, 22,
  26, 52; [51.14.5](51.14.5-switch-over.md)).
- **Zone plans and larger zones** (tracker #165, closed). The diamond is a
  parameterized zone plan (55), and 24 × 12 and 36 × 18 libraries are authored
  (#171, 52). The default size, and every matchmade room, is 12 × 6; a private
  room may select any authored size ([14](14-match-rules.md)). Per-tick cost at
  each size is measured in [42](42-performance-history.md) ("Live matches at each
  authored size"): a 36 × 18 room alone exceeds the 50 ms tick budget at p95 on
  that machine, and a 24 × 12 room costs about twice a 12 × 6 one.
- **The building library's first milestone** (L1 to L5; tracker #187, closed;
  [56](56-buildings.md)).
- **Passable margins** (#313, [20.6](20.6-passable-margins.md)), and **builder
  delegation** under #289: preparation, bounded execution and snapshot recovery,
  the hut-to-cover pilot, the measured candidate review (#328 to #331), and the
  compound exterior-yard adoption (#338). Hut and compound are the production
  adopters ([20.7](20.7-builder-delegation.md)). The large-compound siting
  investigation (#340) is closed.

#### Region population epic #529

Checkpoint as of 2026-10-28; defer to newer direction and status on Forgejo
epic #529 and its children.

Corey's 2026-10-28 direction is to advance the overall population goal in tiers
of function and detail, without exhausting incidental minutiae. Apply the
selection and stopping policy in [32](32-delegation.md). The epic and child
comments hold live checkpoints; older issue backgrounds are historical claims,
not an accurate inventory of everything still missing.

Corey's 2026-10-30 direction ([17.2.11](17.2.11-navigation-structure-direction.md))
recalibrates this epic. Region content is a stand-in, and the goal is less empty
space and paths that must detour, with emergent dead ends, not density
([54](54-region-types.md#navigation-structure)). Measure first (#688), then judge
each workstream below by whether it moves detour, dead-end area or empty space.
Tuning stand-in output for density or appearance alone is out of scope; builder
changes that give other systems mechanics to exercise, such as barriers that
deflect paths, remain in scope. Proposed levers are connected barriers within
regions, macro boundary and portal structure, and inward perimeter growth with
movable cords as candidate SDK support (#649). #688 now supplies the reusable
measurement tool and [three-size baseline](42.23-navigation-structure.md).
No main lever is selected by that baseline; use matched before/after reports
to assess a subsequent named mechanics experiment.

One bounded production static-barrier adoption now gives eligible parks a
connected hedge pocket (#698, types-56). Matched local targets detour and gain
accessible pocket area; real-map no-fit cases, filtered old loot, actual final
loot access and added generation cost are explicit in
[42.25](42.25-park-pocket.md). Long crossings remain nearly straight and empty
shares remain high. Stop at this one-family capability: general #649 growth,
macro boundary/portal control and other builder adoptions remain separate
candidates, with no main lever or automatic successor selected.

| Workstream | Functional checkpoint and next meaningful outcome |
| --- | --- |
| Inward grounds (#529, workstream 1; no dedicated child yet) | Route through epic #529 to review remaining authored families against current library contents; remove interior margin fragmentation where it materially enables population. Do not assume every historical family is still unchanged. |
| Residual infill (#531) | Working installments cover huts, depots, checkpoints, plants, halls and ruins. Compound exterior crossing limitations remain; #630/#632 diagnose and experiment without production adoption. Treat offset-search adoption as deferred refinement for next-task selection unless evidence makes it a blocker for the chosen functional outcome. |
| Hut and compound structures (#532) | Multi-house huts, courtyard keeps/cover and one optional exterior HOUSE outbuilding have representative production admission and access evidence (20.3.4, 42.3), delivering the three original composition capabilities. Their effect on the newer detour/dead-end/empty-space goals remains unmeasured (#688; direction recorded in 17.2.11 via PR #690). Reassess retain/adapt/defer against those measures before more stand-in grammar or larger-hut margin authoring. Multiple rings and maximum residual use are not automatic successors. |
| Depot and hall composition (#533) | Production depot warehouse composition now targets half-density fill with protected doorsteps and two-cell local bypasses; authored comparison and limits are in 42.3. Structural hall wings now add side-connected bays with 2.5-cell perimeter walks and optional roofs; a local L-shaped variant makes the capability available in ordinary library selection (20.3.3, 52, 42.3). Thin annexes and optimal partitioning remain deferred. |
| Market (#534) | Dedicated production counter-stall rows and individual awnings replace the hall stand-in (`types-47`, 20.3.5). Two-cell aisles, seeded wider cross-lanes and bypass rings protect circulation across the whole mask. Elaborate mixed halls/canopies and thinner irregular-wing coverage are deferred beyond this first capability; evidence and limits are in 42.3. |
| District decomposition (#535) | Production block fallback, budget and circulation work exists; broad SDK/default multi-lot adoption and Building SDK authorship are not established by those deliveries. Reopen deeper planning only to enable a selected representative functional outcome. |

The opt-in shared capability now includes prospective parcels and movable cords
(#645), following independent optional thorough validation (#644). Depot, hall, market,
plant, ruins and cover currently freeze routes before content placement; residual
infill cannot negotiate meaningful primary parcels across those routes. Existing
canvas, placeables, infill and recovery infrastructure remains useful. This is
a composition opportunity, not evidence that prior deliveries are defective.
#647's hut milestone is approved in #654. Compound now adopts #646's handoff
transaction as a separate measured milestone, preserving its ring/court/gates
while admitting peripheral and interior yard rectangles with movable routes.
Review both builders' visual, geometry, recovery and cost evidence in 42.3.
The tool-only depot comparison (#663) supplies the contrasting fixed-route case:
matched fixed/movable primary composition with explicit warehouse doorsteps,
local aisle/side-pocket bypasses, independent geometry, determinism/recovery and
source-bound cost evidence. Its stronger bypass policy and omitted secondary
crate pass are experimental controls, not new requirements for every builder.
That comparison left production unchanged. The separate #533 warehouse delivery
now increases its budget without promoting the costly adapter; the subsequent
structural-wing delivery uses the existing fixed-route policy and an authored
L-shaped library variant. Findings and limitations of the experiment are in
[42.3](42.3-generation-and-delegation-evidence.md#depot-movable-cord-comparison-663)
and [the retained report](reports/issue-663/README.md).

Disposition after the representative cord comparisons:
- **Retain:** inward grounds, placeables, addressed canvas, deterministic infill,
  ownership/interface validation and recovery, together with existing themed
  production deliveries. The comparisons do not invalidate them.
- **Adapt selectively:** upfront fixed-route admission when it blocks a selected
  useful primary composition. Preserve each builder's explicit entrances, aisles,
  skipped slots and intentional open space; portal connectivity is insufficient.
  A measured experimental gain does not itself authorize production promotion.
- **Defer:** automatic all-builder migration, generic preparation/cache work,
  guard/budget changes and further compound-offset research absent a demonstrated
  blocker. Do not expand #663 into quota tuning or exhaustive pocket refinement.

For the next functional selection, compare #532's secondary exterior structures
and demonstrated larger-hut authoring prerequisite with the still-missing broader
#535 capabilities. #533 now has a first useful warehouse and hall-wing composition
outcome; further hall shapes and exhaustive residual coverage are refinements. Multi-house huts and
courtyard composition now have representative production witnesses. The remaining primary gaps
have greater functional value than polishing this comparison. Reassess actual
reach/readiness at pickup; this is not a mandated successor or a closure of any
broad workstream.
See the 2026-10-28 sequencing checkpoint on #529 and [20.10](20.10-portal-cords.md).

The epic reaches its first functional tier when each workstream has a useful
production capability on representative intended workloads, or an explicit
recorded deferral with its impact and rationale. Experiments alone do not count
as production delivery. Later tiers broaden coverage and refine quality. Closing
the epic requires an explicit scope review of the delivered capabilities and
remaining deferrals; neither perfect density on every seed nor an unsupported
percentage is its completion criterion. No child is closed by this checkpoint.

What remains elsewhere, as the owning documents state it:

- **Recursive execution of explored decomposition trees**, and moving
  decomposition's walled ports to portals
  ([20.5](20.5-tools-and-next-boundaries.md#next-boundaries)).
- **Further delegation adopters,** one measured builder at a time; each needs
  its own measured evidence and issue (20.7, 42). Depot remains unselected.
- **The building library's second milestone** ([56](56-buildings.md), "Build
  order"), with its open choices M26 to M33 ([17.2.8](17.2.8-building-questions.md)).
- **Larger-size play:** live passage balance and human multiplayer tuning at
  the larger sizes, and their per-tick cost, are not done.
- **World design and visual art direction (#581):**
  Corey's *World Design & Visual Art Direction Primer* is recorded in
  [11.1](11.1-world-and-art-direction.md), with rendering boundaries in
  [29.4](29.4-drawing.md), separable procedural dimensions in
  [52](52-map-primitives-and-library.md), [54](54-region-types.md) and
  [56](56-buildings.md), and open questions in [17.3](17.3-product-gameplay.md) (#25).
  Delivery order and promotion gates are in [41.2](41.2-art-direction-plan.md):
  bring readability witnesses forward, prove one composed street slice, then expand.
  Scoped stages: palette registries and implemented comparison switcher
  (#582), low-cost theatrical
  lighting washes (#583),
  separable procedural identity metadata (#584),
  flat 2D material simplification and destruction shape vocabulary
  (#585), urban fringe landmarks
  and region/building differentiation (#586),
  and contestant/hunter/hazard/objective readability validation (#587).

Work in progress and its order live on the Forgejo tracker and in each step's
issue ([34](34-forgejo-workflow.md)). mapgen's former `NEXT_TASKS.md` backlog is
retired; its unfinished direction is in 51 and 16.

**Earlier focus, updated by the user on 2026-09-23: F-01 micro generation.**
The SDK now includes immutable child contexts, bounded polyomino analysis,
candidate-to-generator allocation, residual ownership, structural interfaces and
independent plan validation. The allocation visualizer and focused analysis/
allocation tests exercise that layer. It is deliberately not a physical geometry
or route generator: grid depth/width are not clearance, seams are only portal
opportunities, and bounded beam search reports diagnostics rather than optimality.
The combined generation demo now realizes example assignments, constructs paired
two-cell portals, checks cross-child swept routes, and supports walking through
the resulting structures. Allocation controls auto-apply and explain unchanged
winners; contrasting presets expose policy effects. Flat plans now execute through
caller-supplied dispatch and portal-negotiation policies, which also carry explicit
external ports; the demo is one such policy. The decomposition lab now
also compares bounded recursive allocation trees under alternate objectives, with
branch inspection and explicit terminal residuals. This does not yet execute those
trees as physical micro generation. SDK access/boundary utilities now validate
post-generation crossing and connectivity obligations, inherit complete external
runs and pair inter-child requirements; nested composition tests exercise this
contract. Reachability remains the chain of per-layer promises in 51, rather than a new
whole-map enforcement stage. See [19](19-decomposition-design.md),
[20](20-micro-generation.md) and the recorded choices in [17](17-open-questions.md).

### Gameplay backlog

The physics and equipment program now has a scoped delivery plan in
[41.1](41.1-physics-plan.md), including engine evaluation before selection,
character contact, physical loot and hook abilities (epic #436). Tier and
reload work (#443, #444) is tracked outside that epic. Its proposed contracts are [29.1](29.1-physics-design.md) and
[29.2](29.2-physics-state-networking.md); none is implemented by that design.

The sequencing below is the other gameplay backlog, not an instruction to
leave the current micro-generation effort for reward tiers.

These supersede the older assumption that all prototype policies should remain
defaults. They are accepted direction, not evidence that the corresponding behavior
is implemented. Preserve the completed extraction's frozen fixtures while making
intentional changes in separate checkpoints. F-11's match capacities and content
checkpoint, formerly the first item, is complete: `content-2` (13, 14, 26).

1. **Shared spatial reward/danger policy (F-12/F-15).** The user selected five
   virtual columns and rows, five mixed tier distributions, a horizontal base
   from 1 to 5, and vertical offsets 0/1/2 capped at tier 5. These zones do not
   alter map geometry. Track vertical novelty separately from quality. Tier
   statistics, distribution weights and special-item definitions still need
   concrete recorded tuning assumptions; preserve spawn/charger reservations.
2. **Physics evaluation (F-14).** Now planned in [41.1](41.1-physics-plan.md);
   the engine comparison and its witnesses are P0 (#437). Current evidence has
   not established the cause of the reported severe slowdown, and installing a
   solver does not establish it either.

## Boundaries these tasks need

The remaining requirements make three boundaries especially useful:

1. **Content and equipment.** The match-owned content bundle already pins role
   capacities, which spawn creation and matchmaking both read, and recordings name
   it by `contentId` (Done above; [26](26-recording-contract.md)). Weapon tier
   statistics and ammunition rules belong in the same bundle. Keep item
   identity/remaining ammo separate from tier definitions. Drag/drop is
   implemented on existing validated inventory intents (F-13). Resolve reload
   versus R rearrangement before changing controls. Do not silently extend
   today's replay version for a content change.
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
and lobby/game-server deployment remain separate follow-ups. The lobby, matchmaking
and room design, with its in-process stages, is [22.5](22.5-lobbies-and-matchmaking.md). The desired owner
exit lifetime still needs a precise relationship to refresh/reconnect grace;
current archives remain process-wide and persistent. Spectators are still owner
gated and delayed by default. Do not present either behavior as satisfying the
new policy answers. Public deployment is not authorized here.

`createArenaServer().rooms` retains `room.game` for scenario setup and benchmarks.
Removing that mutable test surface is a later hardening step; until then, do not
claim complete process isolation. Public deployment limits are in
[28](28-operational-limits.md).

## Portal cords and peripheral handoffs (#643)

Design reviewed in #648: [20.10](20.10-portal-cords.md).
Source direction is in [17.2.10](17.2.10-portal-cord-direction.md). Optional
validation, retained-content coordination and handoff coordination are implemented;
growth helpers and builder adoption remain pending.
This is also a shared prerequisite for #529's composition sequence above.

| Order | Issue | Functional outcome |
| --- | --- | --- |
| Done | [#644](/corey/astra_test/issues/644) | Optional mesh fallback; independent final-geometry swept validation; grid default unchanged |
| Done | [#645](/corey/astra_test/issues/645) | Opt-in atomic retained-content parcels anywhere in the fill, with deformable connectivity witness; no production adoption |
| 3a | [#649](/corey/astra_test/issues/649) | Optional interior/perimeter growth helpers after #645, independent of delegation; a candidate lever for detour and dead ends (17.2.11), judged by #688 |
| Done | [#646](/corey/astra_test/issues/646) | Carve-first whole-cell peripheral handoffs, paired margins and whole-portal transfer coordinated with routing; synthetic fixtures and recovery, no production adoption |
| Hut and compound adoption | [#647](/corey/astra_test/issues/647) | Hut approved in #654; compound follows as a separate measured milestone. Each builder may choose interior or boundary handoffs (17.2.10) |

Growth (#649) remains independent of the implemented handoffs (#646).
Both no-transfer handoffs and whole-child portal transfer have synthetic coverage.
Hut adoption in #647 may start on the no-transfer capability if its selected
peripheral patches retain original portals; it must not claim transfer coverage.
Hut uses explicit retained-portal handoffs. Its boundary rectangles, interior-first
reroute witness and thorough final geometry are measured in 42.3; no production
whole-portal transfer is claimed.
The first SDK milestone accepts
a useful parcel that fixed protections reject while preserving the portal promise.
The composition milestone must demonstrate boundary-flush child ownership, not
just more interior residue. Adoption includes compatibility and recovery review
under [53](53-map-artifacts-and-tools.md) and [20.7](20.7-builder-delegation.md).
Broader migrations, envelope relaxation, exact shortest paths and optimal growth
are not prerequisites.
