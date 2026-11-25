# 26. Recording contract

P5 (#445) raises the writer schema to **12** for optional authored map
`physicsProps`, floor `drag`, and private body `collisionProfile`, `linearDamping`
and `angularDamping`. Its explicit content/rules identities are in
[14](14-match-rules.md). Required renderable shapes/poses retain the schema-10
physics contract, so minimum readers stay unchanged. These optional fields do
not require solver initialization during old or new playback. Live/spectator map
payloads omit private prop authoring; the recorded source map retains it.

L0 (#442) raises the writer schema to **11** for optional item `instanceId`,
`lineageId`, `quality` and private authoritative `itemSerial` allocation state.
These fields do not change drawing requirements, so `minSchema` remains 10 for physics matches.
Explicit `content-equipment-1` selected intentional identity/atomic-transfer/player-order rules
`last-exit-0.8-equipment-1`; defaults before #523 retained `last-exit-0.7`. Playback consumes
stored item/inventory states, never allocates IDs or resimulates transfers. Persisting the
allocation counter retains the history of IDs no longer present in the current frame. See [14](14-match-rules.md).
Explicit `content-loot-1` and `content-ammo-1` descend from the shipped set and
record under the one physics rules version (#920); archives made before that name
`last-exit-0.8-loot-1` and `last-exit-0.8-ammo-1` and stay readable, since playback
never resimulates. L2 (#444) raises the writer schema to **13**: frames of
`content-ammo-1` carry player `reserves` and `reload`, `ammo` ground items and
`reload`/`dropAmmo` commands; older readers ignore the fields and draw an ammo
pickup as an unknown item, so `minSchema` stays at 10.

Recording failure must never reach gameplay. Inline and threaded matches run the authoritative
core tick and use the same archive contract below. Default content is `content-12` (#1303) under
`last-exit-0.8-physics` ([below](#physics-rules-version-921)); the legacy mover's rules were `last-exit-0.7`.
#920 retired that engine and contents 1 to 5, and #953 raised `MIN_SCHEMA` to **10** so
archives recorded before schema 10 (pre-chain-map diamond arenas, `last-exit-0.7`, and
experimental P1/P2 schemas 8–9 without required physics presentation) are refused with the
existing `"no longer reads"` message while remaining downloadable. The room writes schema **24**
and `minSchema` 20 (`minimumReaderForMatch`, `RELATIONAL_SCHEMA`). Since #901, archives are stored as lines
with delta frames ([Schema 17](#schema-17-lines-and-delta-frames-901)), which no older reader can
read, and schema 18 (#948, #949) drops dead recorded fields (`Player.path`,
`GameMap.{modules,nodes,routes,streets}`, `physics.{profile,settings,world.pending}`) while remaining
compatible with schema 17 readers; schema 19 adds tick stamps to recorded input
([Schema 19](#schema-19-tick-stamped-input-1096)); schema 20 records the relational presentation
([Schema 20](#schema-20-relational-presentation-1153)); schema 21 records measured lag as observation commands
([Schema 21](#schema-21-observations-as-commands-1283)). This build still reads every schema from 10. Optional appearance
descriptors on map buildings and obstacles (#584) are presentation-only and require no recording schema bump.
Storage-only changes must preserve frozen gameplay fixtures.

## Schema 24: authored loot for replay setup (#1284)

The optional `setup` header object holds inputs used to reconstruct the match. Its `items` field
records a detached copy of the authored map items before `createGame` initializes them. It
preserves their original IDs and authored ammo and quality values
for match construction. Playback reads the initialized numeric records from `map.items` and uses
reader floor 20. Older schema 23 archives are playable and lack the original loot records. The
runtime portal graph for graph-backed maps still needs to be captured for resimulation (#1284).

## Schema 23: bot command checkability (#1321)

The optional header `botPlannerVersion` identifies the first-class bot planner. Each committed tick may
carry `botCommandDigest`, the lowercase SHA-256 of the committed bot command rows encoded using
`encodeInbound`, with each numeric wire word serialized as an IEEE-754 binary64 little-endian value in
row order. This includes gesture flags and the empty row sequence. The initial pre-tick frame has no digest.
A finish or abandonment can add a frame at the last tick without advancing the simulation, so that frame also
has no digest. Human and external bot commands remain in `commands`. The digest is metadata and playback remains based on
stored frames. Schema 23 is additive and retains `minSchema` 20. Older archives lack these fields.

Remaining bot routes are private snapshot diagnostics (#1338). New frames omit them. Playback of
archives that include the optional `Player.route` field still uses their stored frames.

There is currently no recording resimulation path that reconstructs bot commands. A future resimulator can
encode its committed bot rows and compare their digest on each available frame, using the matching planner
version and complete history. Missing frames prevent continuous reconstruction.

## Schema 22: the inbound queue as commands (#1283)

A frame's `commands` contain the room-owned commands for that frame (start, the roster's joins and choices,
abandonment), followed by T's last spent inbound queue in its queue order, less first-class bots' derived commands
(`shared/simulation/tick-record.ts`). Human and external bot commands are recorded. The inbound queue is attached to the
matching committed frame, not recorded when merely queued. An input that never reached a tick, was superseded or was
refused at the boundary is not recorded. Each of 27.2's three kinds of inbound item is one recorded type:
- `{ type: 'command', id, source, tick, seq, input }`: input through the receive boundary, a person's or that of a
  bot controlling a player. The core's `Input` leaves out fields at their empty value, and names a transit station
  and a nominated target by authored ID. A nomination the boundary could not map is `target: { kind: 'unresolved' }`.
- `{ type: 'observation', kind, … }`: `viewLag` and `inputLead` (`id`, `ticks`), `join` (`id`, optional `kit`),
  `leave` (`id`), and a dev `teleport` (`body`, `x`, `y`) as requested. The core's tick discontinuities give the
  live reply. The archive stores the resulting body pose and generation with the frame.
- `{ type: 'carried', kind, … }`: an `impulse` (`body`, `x`, `y`), a `killReward` (`id`) and a `gateObserved` (`id`,
  `gate`, `open`, `locked`).

An actor is its player ID, a gate or station its authored ID, an item its item ID. A body is a label: `actor:<player>`,
`item:<id>` or `prop:<authored label>`.

Live `join`, `resume` and `leave` commands record the room's roster changes, including the name and role for joins
and resumes. The paired `join` or `leave` observation records the core's seat handoff when the tick spends it. If a
room finishes before that tick, the final frame still carries the room's roster command.

First-class bots' commands are not recorded (Corey, 2026-11-23). They are the match's own computation from history;
reconstructing them requires the matching bot version and complete history. Partial archives still support stored-frame
playback, but cannot claim exact bot-command reconstruction across missing history. A seat's `leave` and `join`
observations mark where a bot derives that seat's commands. On arena 9's eleven-bot match, storing these commands would
add 41% to a gzipped recording (1.39 to 1.96 MB over 1800 ticks). The new path's frames also leave out `rng` and
`scatterSerial`, which that tick does not keep.

Since 3d.4d the room writes header schema 22. Playback reads stored frames with the same `minSchema` 20, including
archives written under schema 21.

## Schema 21: observations as commands (#1283)

The authoritative core takes everything that enters a tick from one recorded inbound queue: commands, events carried from
the previous tick, and observations ([27.2](27.2-tick-architecture.md#boundary)). Joins, leaves and dev teleports
were already recorded commands. Schema 21 adds the last observations, the server-measured view lag and input lead.
When a measurement changes either value, the room records `{ type: 'viewLag', id, ticks }` and
`{ type: 'inputLead', id, ticks }` (`server/match.js` `setViewLag`), with `ticks` 0 for none. An unchanged
measurement records nothing, and nothing is recorded before the start. A join or leave implies a view lag of 0.

The change is additive and `minSchema` stays at 20: playback draws stored frames and reads no command.
Schema 21 archives also carry `viewLagTicks` and `inputLeadTicks` in player state. Rules stay
`last-exit-0.8-physics`.

The schema 22 recording frame is S1, T's inbound queue and apply's discontinuity markers
(`rust/core/src/tick/output.rs`). S1 is the previous frame with the tick's change list applied, which is the delta
form [Schema 17](#schema-17-lines-and-delta-frames-901) already stores, and a keyframe is the core's `Snapshot`.
A marker names a body placed, warped or removed in that tick. The cutover maps these onto the frame's fields and
records the inbound queue as the frame's `commands`. A frame on that path (`shared/simulation/tick-frame.ts`, 27.2
"Frames (3d.3)") keeps the physics presentation, `bodies`, `tethers` and `hookFlights`, and drops the private
`physics` block, the old world's state, which playback never read. A placed body is marked `placed` and takes a new body ID.
A generation counts within one body ID, renewed by a warp, where the old world's counted across the match.

## Schema 20: relational presentation (#1153)

`RELATIONAL_SCHEMA = 20` raises both writer schema and minimum reader to 20.
Pre-20 readers must refuse these recordings as too-new; the reader floor stays
`MIN_SCHEMA = 10`. New frames retain complete private gameplay state and captured
player metadata, with numeric presentation bodies/owners and item identities,
body-only physical poses, dynamic gate state and event-time participant payloads.
The header map retains ordered gate geometry. Playback merges dynamics into that
geometry and normalizes legacy schema-10..19 bodies, items and gates without a
solver. The shared event formatter accepts legacy `{ text }` records. Arbitrary
backward seeks hydrate detached display values without editing archive frames,
their order, checkpoint bytes or digest verification.

Recordings keep internal IDs. Live views since #1164 send IDs from match-wide counters (bodies,
tethers, items and `s.serial` for events, effects and projectiles) through a per-match keyed
one-to-one mapping, so a live ID is a keyed view of the recorded one. The key is never recorded;
a recording is published only after its match, and its playback never meets a keyed ID. Neither the
schema nor the frame encoding changed for it ([24.4](24.4-relational-data-model.md#keyed-outward-ids-1164)).

Rules remain `last-exit-0.8-physics`: #1153 deliberately changes projections, not
simulation. The frozen fixture's arenas are retained; its reviewed projection
update carries independent unchanged-gameplay/private-PhysicsWorld evidence.

## Physics rules version (#921)

Every match built by `createGame` records the one physics rules version,
`last-exit-0.8-physics`, and requires `actorPhysics`, `itemInstances`, `worldPhysics`,
`hook`, `kits.hook` and `dynamicNavigation: true` (#976); legacy-mover matches recorded
`last-exit-0.7`. Earlier schema 10+ recordings retain whichever physics features their content
selected, identified in the header's content ID. Recordings written before
#921 carry one of the stage strings `last-exit-0.8-physics-1`, `-2`, `-5`, `-6` or `-8`
(every shipped physics match from #523 to #921 carries `-8`). A reader treats each as
physics rules and needs nothing more: playback draws stored frames without a solver,
nothing dispatches on the rules string, and the change moves no schema or reader floor,
so old recordings play unchanged without migration. Their stage content IDs
(`content-physics-2` to `-8`) no longer resolve through `contentById`; display metadata
then comes from the header's embedded descriptor or the fallback in
[22.7](22.7-content-and-presentation.md#recording-compatibility), and the stage sets
are described in [42.12](42.12-physics-p2.md) to [42.19](42.19-physics-p8.md). The stage
identities in the history below are as recorded at the time.

Before #921, without a P2 character profile the explicit experimental factory pinned
`last-exit-0.8-physics-1`; normal matches
retain `last-exit-0.7`. Schema 8 adds optional `physics` on authoritative frames:
dynamic body IDs/generations, transforms, motor state, ropes and bounded pending
spawns/impulses/attachments. Static colliders come from the recorded map and are
not repeated each tick. This private gameplay state is stripped from every live
projection. It is not an exact backend checkpoint; production exact restore is
explicitly unsupported. Playback continues drawing stored states without a solver.
See [29.2](29.2-physics-state-networking.md); P3 owns physical rendering/projection
and any later format changes. P1 introduced no content ID change: shipped tuning stayed
`content-4` (which only changed bot planning, #473; `content-5` since, likewise), with P1 motor acceleration an experimental rules constant.

Schema 9 adds `actorGeometry` to the header display descriptor (optional on schema 10+
archives for backward compatibility, always emitted on new descriptors since #976),
optional map `motorSurfaces`, body speed limits and private per-frame physics discontinuity
markers. The markers identify placed or removed body generations; they are not exact
continuation checkpoints or a client prediction implementation. Old frame playback still needs no solver.
Minimum readers are unchanged because these are optional experimental diagnostics;
normal actor art/hit rules remain unchanged. P3 owns required physics presentation
and its eventual reader floor. See [14](14-match-rules.md) and [29.1](29.1-physics-design.md).

P3 (#440) records optional top-level `physicsProfile`, `bodies` and `tethers`.
Bodies carry closed shape descriptors, world-unit poses/velocities, radians,
sleep state, generation and optional placement boundaries. Actor art remains
independent of physical angle. Actor/item associations link existing art to the
body pose; an `item:<item id>` body associates only with an existing ground item.
Complete lists express removal, including constraint removal. Tethers contain
only their ID and two body IDs; geometry is read from those stored endpoints.
Playback uses these values without importing or initializing a solver, including
backward seeks, partial tails and held omitted ticks. It never reconstructs spring
motion. The private `physics` field remains diagnostic gameplay state, unused by
the renderer, and no exact engine checkpoint is required or sent live.

At schema 10, `minimumReaderForMatch` returned 10 (`MIN_SCHEMA`), independently of the rules-version string
(before #920/#954, a match boundary `hasPhysics` capability distinguished physics matches from legacy
matches). An older reader would omit props/tethers and misrepresent physical poses. Since #953 raised
`MIN_SCHEMA` to 10, archives below schema 10 are refused with `"no longer reads"` while
remaining downloadable.

How a reader labels a recording's weapons, kits and timers
follows [22.7](22.7-content-and-presentation.md#recording-compatibility)
([Presentation descriptor](#presentation-descriptor-schema-6) below).

## Versioning and compatibility

`shared/recording.ts` owns whether a build can play a recording, and both the writer and the reader
ask it. Before it, the only guard was the client probing `data.map.obstacles` — a data shape standing
in for a version, which happened to work and said nothing about anything else that might change.

A header carries two numbers beside `version`:

| Field | Means |
| --- | --- |
| `schema` | the format this recording was written in |
| `minSchema` | the oldest reader that can still make sense of it |

The pair is deliberate. An additive format change — a new optional field — raises `schema`
and leaves `minSchema` where it is, so clients written before the change keep playing recordings
written after it. Only a change that genuinely breaks older readers raises `minSchema`. A single
number cannot express that: every bump would lock out every older client whether it needed to or
not, and widening compatibility again would mean migrating the format a second time.

The reader's policy is deliberately the simplest one that works — a floor, `MIN_SCHEMA`, currently
**10** (#953), matching the schema-10 floor stamped by physics matches (`minimumReaderForMatch`).
Schema 10 (`P3`, #440) is the first format supporting required engine-free physics presentation
(`bodies`, `tethers`, `physicsProfile`, alongside cell-masked chain maps introduced at schema 4);
while both engines coexisted, non-physics matches could still write schema 10+ with an earlier
`minSchema`, so 10 is the chosen supported floor rather than a guarantee about every historical schema-10 header.
Archives recorded under schemas 0–9 (including schema-less recordings, pre-chain-map diamond arenas, and
`last-exit-0.7` legacy-mover matches) are refused as `'too-old'` while staying downloadable via `/api/replays/:id`. Policy
belongs to the reader; a recording only states facts about itself.

The schema history, with the sections that explain each step:

| Schema | Added | `minSchema` written |
| --- | --- | --- |
| 21 | `viewLag` and `inputLead` observation commands (#1283) | unchanged |
| 20 | Relational IDs and body owners, one physical pose, dynamic-only gates and structured localized events (#1153, 24.4) | 20 |
| 19 | Optional input `tick` stamp on recorded commands and buffered input, and player `inputMargin`, `inputMarginNext` and `inputLeadTicks` (#1096) | unchanged |
| 18 | Retired `Player.path`, `GameMap.{modules,nodes,routes,streets}`, and private `physics.{profile,settings,world.pending}` (#948, #949) | unchanged |
| 17 | Lines (NDJSON) with keyframes and delta frames, interval checkpoints and a stored-line digest (#901) | 17 |
| 16 | Optional contestant roster place `seat` in recorded player state (#792) | unchanged |
| 15 | Optional `transit` command, player `transit` state and `status: 'transit'` (#692) | unchanged |
| 14 | Optional private hook state and hook-flight presentation (#446) | unchanged |
| 13 | Optional L2 player reserves and reload, `ammo` ground items and `reload`/`dropAmmo` commands (#444) | unchanged |
| 12 | Optional P5 map `physicsProps`, floor `drag` and private body collision/damping state (#445) | unchanged |
| 11 | Optional L0 item identity/lineage/quality and private allocation counter (#442) | unchanged |
| 10 | Renderable physics bodies, lifecycle/placement and tether endpoints (#440) | 10 for experimental physics matches; ordinary floors unchanged |
| 9 | Optional experimental character geometry, floor motor regions and physics discontinuities (#439) | unchanged |
| none, then 1 | older recordings carry no `schema`; 1 introduced the pair | 0 |
| 2 | a sequence number on each recorded command, and the per-player input queue (below) | 0 |
| 3 | `contentId` in the header (below) | 0 |
| 4 | cell-masked maps ([Cell-masked maps](#cell-masked-maps-schema-4)) | 4 for a masked map, else 0 |
| 5 | the diagnostics trailer ([Diagnostic markers](#diagnostic-markers-schema-5)) | unchanged |
| 6 | an optional `presentation` display descriptor in the header ([Presentation descriptor](#presentation-descriptor-schema-6)) | unchanged |
| 7 | an optional `route` of world points in recorded player state, for bots planning over tiles (below) | unchanged |
| 8 | optional private physics gameplay state in experimental authoritative frames; no solver blob | unchanged |

The paragraphs below describe each change as it was made, so a number in one
is the schema current at the time, not today's.

Schema 2 is the first use of that reasoning. Queuing input per player put a sequence number on every
recorded command and the queue itself into recorded player state — additive, so `schema` rose and
`minSchema` stayed at zero, and a reader written against schema 1 still plays recordings written
after it. The same change raised `version` to `last-exit-0.7`, because what a recording *means* moved
too: a tick now spends one input rather than whatever had accumulated.

Schema 3 added `contentId` to the header, again additively. It is a third axis and the three do not
substitute for one another: the schema pair says whether a file can be *read*, `version` says which
rules produced it, and `contentId` says which numbers those rules ran over. Two matches can share a
version and disagree about what a pistol does, and a reader looking at an old archive needs to tell
which. The content itself is not in the header — it is fixed for the whole match, so naming it once
costs a string where carrying it would repeat the same tables in every frame.

F-11 changes the default from two-hunter `content-1` to three-hunter `content-2`.
It retains `last-exit-0.7`: the roster data changes, not the rules interpreting it.
Schema remained 3/minimum 0 at that change because player arrays already support arbitrary lengths;
an extra roster entry is data, not a new field or format. Playback uses recorded
maps and frames, not a resimulation with today's default content, so both old and
new rosters remain playable without a content lookup. `content-1` stayed explicitly
selectable for simulation characterization until #920 retired it; this did not restore a 0.6 engine.

`content-3` (#424, Corey 2026-10-23) changes the default again: bots plan over free-space
tiles, contestants over what they know ([22.6](22.6-hierarchical-navigation.md)). Its numbers
and roster are `content-2`'s, and it retains `last-exit-0.7`: how bots choose their inputs is
not a rule a player's inputs are judged by, and the content id names the change. A bot planning
over tiles keeps its route as world points in `route`, where the grid planner keeps tile steps
in `path`. The field is new recorded player state, so schema rose to 7 and `minSchema` stayed:
playback reads recorded frames and never the route, so any reader plays these recordings.
`content-2` stayed selectable with its bot grid planner until #920 retired both;
the diagnostic Lab grid baseline remains ([53.1](53.1-map-lab-and-tools.md)).

`content-4` (#470, Corey 2026-10-23) spreads each bot's repath over several ticks. It changes
when a bot's route changes, not what is recorded: still world points in `route`, so the schema
stays 7 and rules stay `last-exit-0.7`. A search in progress is derived state, like the plan
it replaces: it is not recorded or snapshotted, and a resumed match plans afresh.

`content-5` (#470 part 2) adds local repair of a contestant's route round nearby changes. Like
`content-4` it changes when a route changes, not what is recorded, so the schema and rules stay.

`version` is a separate axis and keeps its meaning: which simulation rules produced the recording.
The schema pair decides whether a file can be *read*; `version` says what its contents *mean*.
Recordings also embed their own map, so changing map generation never invalidates one. That is
also why map generation is not pinned the way weapons, kits and traps are: the embedded map is the
generator's output rather than its settings, and output is the stronger thing to keep. Reconstructing
an arena from pinned tuning could disagree with what was played; an embedded map cannot.

## Format and integrity

Each room records a map header and offers every authoritative tick to a bounded gzip writer. Retained frames contain a complete simulation snapshot plus accepted commands and membership changes. Frames include AI path state. A recording is advertised only after successful publication. Disk backpressure never pauses tick advancement: incoming frames exceeding the pending-data budget are omitted whole, and subsequent frames can be accepted after the writer drains.

A frame's meaning is always `JSON.stringify({ state, commands })`: the writer may build it from parts it
has kept (the ground items, 22.1 "Frames"), and a reader rebuilds exactly those bytes. Since schema 17
([below](#schema-17-lines-and-delta-frames-901)) the archive stores most frames as deltas, so the
publication metadata's `sha256` covers each *stored* frame line plus a newline, and the trailer's
checkpoints prove the rebuilt frames. Archives before schema 17 hashed each frame's full JSON the same way.

Only recordings with omissions carry `recording: { complete: false, droppedFrames, endTick }` in the
trailer and matching archive metadata. Missing ranges are derived from retained `state.tick` values,
avoiding an unbounded separate gap list. No surviving frames means publication fails. An omitted final
state must never be invented; `endTick` records the actual match endpoint, even if the last surviving
frame is earlier.

<a id="proposed-viewer-publication"></a>

### Proposed direction: viewer publication and archive split (#1098, #1074, #1123)

Status: proposed direction ([17.4](17.4-live-service.md) #16); nothing below is implemented yet, and `#1098` remains an open decision for Corey.

- **Separate sinks from a shared immutable frame source.** An authoritative tick (or sealed tick if `#1096` adopts delayed input sealing) feeds independent **recording** and **public viewer-publication** (`#1123`) sinks. Neither sink may depend on successful delivery or storage by the other: recording omissions or storage failures remain isolated from gameplay and viewer publication.
- **Open archive-split and access decisions (`#1098`, `#1074`).** `#1098` asks whether to split recordings into two artifacts: a **private evidence archive** (full authoritative state, commands, and diagnostic marks under owner/operator access and lifetime rules, `#1074`, `17.4` #3) and a **shareable viewer replay** projecting viewer-safe fields via `playerView(..., null)` (`shared/simulation/visibility.ts`), the closed allowlists in `shared/simulation/projection-contract.ts`, and `publicMap` (`server/map-payload.js`). Even for viewer-safe streams or artifacts, disclosure rules do not settle public accessibility: audience access remains explicit (`17.4` #6, [24](24-networking-privacy.md#two-tier-spectators)).
- **Format boundary.** `delta-1` (`shared/recording-format.ts`) is retained provisionally alongside shared projection rules and keyed-list delta primitives (`shared/keyed-list.ts`), keeping live-wire encoding (`#1093`/`#1094`) and recording contracts separate unless benchmarks justify merging. Forward-only progressive spectation over a bounded window stays independent of `#1102`'s arbitrary-seek on-demand archive rebuilding.
- **Room-thread cost.** Today `remember()` retains up to 62 snapshot references in `room.history` while `writer.append()` (`frameParts` in `server/replay-writer.js`) serializes top-level fields synchronously on the room thread, reusing cached `items`/`gates` JSON, before `replay-worker.js` compares fields, encodes deltas, hashes, and gzips; room-thread egress cost must be measured rather than assumed free.

## Schema 17: lines and delta frames (#901)

Whole-state frames made long default-size recordings unloadable: the browser reads an archive as one
string, and a 3,493-frame match was 565 MB, over V8's 536,870,888-character limit; a whole 36x18 match
was 11 GB ([42.22](42.22-tick-cost-attribution.md#recording-delta-evaluation-901)). Corey adopted the
design on #901 (D1–D5, 2026-11-14). `shared/recording-format.ts` owns the form, its encoder and every reader.

The archive is gzip text in lines (NDJSON). The first line is the header, which adds
`frameEncoding: 'delta-1'` and `keyframeEvery` (100). Each retained frame is one line: a **keyframe**
`{"state":…,"commands":…}`, byte for byte the frame's full JSON, or a **delta** `{"delta":…,"commands":…}`
against the previous *stored* frame. The last line is the trailer, `{"end":{"checkpoints":[…],
"recording"?:…,"diagnostics"?:…}}`. Older archives remain one JSON document with a `frames` array, and the
reader reads both.

A delta is a patch over the previous stored frame's state: `{"v":value}` replaces a value whole;
`{"o":{key:patch},"k"?:[keys]}` changes these keys of an object, with `k` the full key order whenever the
key set or order changed; `{"a":{"s"?,"d"?,"r"?}}` changes a list whose entries have unique keys, setting entries whole, dropping keys, and giving the full key order only
when it is not the keyed-list default (`shared/keyed-list.ts`, the same rebuild the live wire's layers use,
24); `{}` is unchanged. The key rule is fixed by the recording's header schema, never inferred from the entries: up to
schema 19 an entry's key is `id`, or `spec.id` for physics world bodies; from schema 20 (`RELATIONAL_SCHEMA`) it is
`playerIdx`, else `gateIdx`, else the older rule. The encoder is given the schema it writes and the reader takes it
from the header (`recordKeyFor`), so an old file decodes under its own rule even if an entry carries a field a newer
rule would prefer. A header with no schema reads as the oldest rule; a schema that is not a whole number is refused.
Changing the rule again needs a new schema, or a new frame encoding. Entities are replaced whole, never field by field, and commands are never deltas.

- **Base.** A delta's base is the previous stored frame, so a frame omitted under backpressure is never
  referenced, and no keyframe is forced after an omission. Every prefix of the archive is self-consistent.
- **Keyframes.** The first frame, every `keyframeEvery` stored frames, and early once the deltas since the
  last keyframe exceed `keyframeEvery × EARLY_KEYFRAME_SHARE` (1/8) of its size, which happens only when
  state churns: then a keyframe costs little more than the deltas and keeps seeks short. The rule as first
  approved, one keyframe's size, cut a keyframe every 13 frames on 12x6 maps and more than doubled the
  archive (6.8 MB against 2.98 MB for a whole match), so Corey chose the eighth (#901, 2026-11-14). A state
  that is not a plain object is stored whole and the next frame is a keyframe.
- **Integrity.** The metadata `sha256` covers the stored lines (above). Each checkpoint `{ frame, sha256 }`
  is the SHA-256 of a frame's full JSON, taken by the writer for the last frame before each keyframe and
  for the final frame. A delta that rebuilt wrongly leaves the frame wrong until the entity is written
  again, so a checkpoint catches it and names the interval. Tools and tests check checkpoints
  (`checkpointFailures`); the viewer does not. Hashing every rebuilt frame was rejected: it would bring
  back most of the full-state byte work for errors that heal within one interval (#901 D3).
- **Readers.** Old readers cannot read lines at all, so recordings declare `minSchema` 17. Readers apply
  their own policy to the header before any frame (`onHeader`; the viewer uses `recordingFit`). Damaged
  input fails as damage: an unknown encoding, a delta with no base, a missing key or id. A file missing
  its trailer reads as `truncated`.

## Presentation descriptor (schema 6)

Schema 3 named the content and kept its tables out of the header; schema 6
still does. Since #386 a new recording's header also carries `presentation`, once,
beside `contentId`: the display descriptor of [22.7](22.7-content-and-presentation.md#presentation-descriptor)
(weapon and kit labels, default ammo, role capacities, duration and charge
ticks). It is display data, not the tuning: nothing in it can rebuild or
resimulate the match. The room service builds it from the pinned content before
the first frame and the writer only serializes it. Frames, commands, frame key
order and the retained-frame digest are unchanged, and no frame, projection or
input carries it. `minSchema` stays as before, so older readers ignore it.

A reader resolves display metadata with `resolveRecordingPresentation` in
`shared/presentation.ts`, in order: a valid embedded descriptor naming the
header's `contentId` (even content this build does not ship); the retained
descriptor of a known shipped id; otherwise none (`source: 'unknown'`, shown as raw ids and unavailable values).
Present frame values (ammo, `duration`, `cellChargeTicks`) beat all of these.
An unusable or missing descriptor never makes a playable schema 10+ archive a format error;
`recordingFit` alone decides that.

## Diagnostic markers (schema 5)

A recording may end with `diagnostics: { marks, dropped? }` in its trailer (the `end` line since
schema 17, a top-level field after `frames` before it), written only when there is something to say,
as `recording` is. It was additive (`minSchema` unchanged) and never touches frames or the digest.
They are in a trailer, not in frames, because a frame is omitted whole under storage pressure, which
is when a stall is most likely. `writer.mark(marker)` keeps at most `MAX_DIAGNOSTIC_MARKS` (512); later
ones are counted in `dropped`. A crash `.partial` file loses the trailer, which is acceptable.

A mark is `{ tick, kind, ... }`. `server-stall` is
`{ tick, kind, wakeMs, owed, simulated }` (`simulated` is the steps actually taken, fewer than the budget if the match ends), raised by the room's catch-up step in
`advance` when more ticks are owed than `MAX_CATCHUP` allows. Tick numbers stay
continuous after a stall (wall time is lost, not ticks), so the mark is the only evidence in
the replay. Readers treat marks as untrusted: `createReplayTimeline` keeps known kinds at
valid ticks, in tick order, and reports `droppedMarks`. Client-reported kinds
(`frame-drop`, `packet-gap`, `manual`) arrive as a `diagnostic` message (24) and are written
as `{ tick, kind, playerId, reportedTick, arrivalTick, startTick?, count?, worstMs? }`.
A dev teleport (24) is not a mark but a command, `{ type: 'teleport', id, x, y }`, in the
frame after it, whose state already shows the player there.
A change of role or kit in the lobby (#235) is a command, `{ type: 'choose', id, role, kit }`,
beside the joins in the first frame, which already shows the player in their chosen place.
A dev pause (24) is `{ tick, kind: 'pause', pausedMs }`, written when the room resumes or
ends: no tick passes while paused, so it sits between two consecutive frames and is the
only sign of the pause in the replay.

The viewer draws one pip per mark over the scrubber (`#replay-marks`), distinct by shape as
well as colour (square red stall, triangle orange client drop or gap, circle blue manual, narrow lime bar for a dev pause), with
the mark named in its tooltip. Activating a pip seeks `MARK_LEAD_SECONDS` (2) before the tick
and follows the reporting player when the roster has them. Marks whose pips
would overlap (`clusterMarks`, from the rendered thumb travel and pip width, recomputed when
the track resizes) share one pip showing their count; it opens a list, so a stall and the
reports from several players at one tick each stay individually selectable. The frozen fixture and `version` are unaffected.

## Bounded recording

The room scheduler never waits for replay storage. The writer accepts immutable
serialized frames into a bounded queue of uncompressed pending data, including
bytes handed to gzip but not consumed. By default the bound is the larger of 8 MiB and
the header plus four frames of the size being appended, so it grows with the map: a
72x36 frame is about 3.3 MiB ([42.22](42.22-tick-cost-attribution.md)). Gzip/output stream buffers
have their own bounded high-water marks. An incoming frame that exceeds available
queue capacity is omitted in its entirety; no command/frame fragments are written.
The writer resumes accepting frames when capacity returns. It never retains
mutable snapshots.

A room opens its recording as soon as its match is prepared, not at the start (#1088), and adopts
the match once the writer reports the header taken into gzip (`opened`), or after five seconds
if it has not. At 36x18 the header, which carries the map, is about 6.6 MB of JSON, and a frame is
about 1.06 MB. Opened at the start, the header was still being compressed when the start's ticks
arrived (one room alone dropped ticks 3–5). The budget beside the header held only four frames,
and the first tick's catch-up burst outran it. The header's bytes, the frames and the archive are
unchanged; only when the header is written moves. Nothing is recorded before the start. A file
store creates its file only when the first frame or the trailer reaches the worker, holding the
header's compressed bytes until then, so a room that retires or closes before its start discards
the recording (`discard()`) and leaves no file. An unstarted prepared room therefore holds one
recording worker. The changing top-level fields and commands are serialized on the main thread,
as key and JSON pairs (#728). The recording worker owns the stored form (#901): it compares each
field's text with the previous stored frame's, parses only fields that changed, and writes a keyframe
or a delta; it then hashes and compresses the line and takes checkpoints. Kept item/gate lists are sent
only when their serialized value differs from the last retained frame; an omitted frame cannot advance
that worker cache, nor the encoder's base.

The main thread reserves each accepted frame's full uncompressed line length (what a keyframe
stores, and more than a delta) until the worker's gzip write callback acknowledges consumption. The budget
therefore includes messages waiting in either thread and bytes offered to gzip,
without depending on how quickly the worker receives messages. Production file
streams live in the recording worker. Injected Writable outputs use an
acknowledged compressed-chunk bridge: the worker waits for the output callback
before sending the next chunk. Worker errors and unexpected exits fail only the
recording; abort and finalization deadlines also terminate the worker.

## Playback

The viewer reads an archive as it arrives, line by line (`readRecordingStream`), and rebuilds every
frame once at load: consecutive frames share unchanged values, so memory follows what changed, and a
seek is a lookup. No string ever holds the whole archive, so its size is not bounded by the longest
string the browser can hold. Archives from schema 16 and earlier are one document and are still read as one.
Rebuilt frames are shared, so nothing that reads one may modify it. Downloading saves the stored file,
named by the server (`.ndjson` from schema 17, `.json` before); it is never parsed or rebuilt for that.

Replay playback restores recorded states directly, supports seeking by authoritative tick, and is independent of simulation determinism. Missing intervals hold the latest known state and display a missing-data indicator; no missing state is reconstructed. Full-map viewing is restricted to published recordings, which may be explicitly partial. This preserves exact retained game states, not pixel-identical visual effects; decorative animations use render time. Same-runtime deterministic simulation is tested separately, but cross-platform input-only reconstruction is not claimed. Abrupt power loss can leave an incomplete `.partial` file that is retained but excluded from archives; crash-file salvage remains separate from recovering a bounded live recording after temporary pressure.

Playback advances by recorded ticks, chooses the latest retained frame at or
before the playhead (last duplicate wins), and holds it through missing intervals.
Before the first retained tick it shows that first frame with a missing-data
indicator. Gaps and incomplete tails are labelled; do not extrapolate projectiles
through missing intervals. Dense schema 10+ recordings remain playable. Archive rows
label partial recordings. Sparse playback must not pretend omitted outcomes or
commands are known.

The render playhead retains fractional ticks at every playback speed. Only frame
lookup rounds down to an authoritative tick; rounding the stored playhead loses
elapsed time, and rejecting fractional queries freezes displayed playback.
Presentation alpha is zero on missing ticks, including leading gaps and tails.
The test-design consequence of that fractional playhead is in
[25](25-pacing-and-rendering.md).

## Writer and store API

Writer API: `append(state, commands)` returns true if retained, false if omitted;
`droppedFrames` counts omissions; `failed` is an Error or null; `abort(error)` is
idempotent; `finish(result)` returns one shared completion promise. `opened` settles once the
header has been taken into gzip or the recording failed, and never rejects. `discard()` gives up a
recording that has retained no frame without reporting a failure, and returns false once a frame
was retained. `blocked` may
remain diagnostic but must never control match advancement. Start/serialization,
stream, abort and publication failures are contained. Streams are destroyed on
failure, rejections are observed, and no success is published after failure.
Finalization has a default five-second deadline so a permanently stalled sink
cannot hang shutdown. Queue/deadline options are injectable for tests. A stalled
live sink stays memory-bounded and is terminated no later than finalization.

Store API: `start(header, { onError } = {})` forwards writer errors to the room;
the existing single-argument form remains valid. The room catches synchronous
start/append errors, clears accepted recording commands even after recording
fails, and continues normal fixed ticks and broadcasts. Typed `replay-status`
messages carry `status: 'partial' | 'failed'` and a user-facing message. Notify on
each status transition, and send the current status to late joiners. Replay-only
failures must not use the generic connection-error path. Finish/publication errors
are reported once and never send `saved`. Service finalization also has a bounded
deadline for adapters that never settle; late completions cannot send success.

## Verification

Verification: exact rebuilt frames, checkpoints and the stored-line digest
(`tests/recording-format.test.js`, `tests/replay-writer.test.js`; whole matches with the opt-in
`tools/perf/recording-compare.mjs` witness, run when the frame encoding changes), queue bounds and ownership,
recovery after pressure with tick gaps, zero retained frames, synchronous start/
append failures, async stream and publication failures, stalled finalization,
idempotent close, continued input/other-room ticks, late joins, sparse playback
and live status UI. Run full checks/browser suite and isolated server/client
benchmarks. Owner-only access, retention, BSON, process isolation and crash-file
salvage remain separate follow-ups.

## Cell-masked maps (schema 4)

`GameMap.playableArea` records the owned cells as sorted row runs, including
holes, at a stated `cellSize`. Collision, prediction, the arena floor and the
minimap use it. Maps also carry optional `hunterSpawns`, a `generator` label
(`chain-live-1`), and generated loot `tier` metadata.

Schema 4 introduced these additions (`minimumReaderForMap` then required 4 for
masked maps, leaving diamond archives at 0); #953 raised `MIN_SCHEMA` to 10,
deleted `minimumReaderForMap` and the client's diamond/route/module fallbacks,
and requires `playableArea` on drawn maps and replays. Simulation rules at the
time stayed `last-exit-0.7` and tuning stayed `content-2`. Frozen simulation
characterization continues to use its stored legacy maps offline and is not
regenerated.

## Schema 19: tick-stamped input (#1096)

Schema 19 records the tick each client input is for ([24](24-networking-privacy.md#tick-stamped-input)).
A recorded `input` command keeps its `input` as accepted, now with `tick`; the player's buffered
`inputQueue` entries carry the same stamp; and recorded player state gains `inputMargin` (the margin the
client was told this tick), `inputMarginNext` (arrivals gathered for the next tick) and
`inputLeadTicks` (the lead its measured round trip grants). Every field is optional and present only
when a stamped input or a measurement put it there, so in-process matches that queue unstamped input
(the physics fixture among them) record exactly what they did before. The change is additive and
`minSchema` stays at 17: playback draws stored frames and reads none of these.

An input refused as late or too far ahead never reaches the simulation and is not recorded; that it
arrived shows only in the next frame's `inputMargin`. Which tick spent a recorded input follows from its
stamp, which the recording carries, so the rules version stays `last-exit-0.8-physics`: nothing
dispatches on it, and the recording states what a reader needs. The supported recording remains a record
of authoritative ticks; there is no delayed sealing, and no recorded tick is rewritten (#1096's option 2
was not built).

## Schema 16: contestant roster place (#792)

Schema 16 adds an optional `seat` to recorded player state: a contestant's roster place, which a client
uses to assign the same identity hue before and after a human takeover, a reconnect or a callsign change.
It is presentation identity, not gameplay, and it changes nothing about how a match runs. The change is
additive, so `minSchema` stays at 10; a reader between 10 and 15 ignores the field and draws the hue from
the id or callsign as before. Rules stay `last-exit-0.8-physics` and no content id changes.

## Schema 15: transit route selection (#692)

Schema 15 records the optional `transit` command (a station id) with the others, and, while a gladiator is in
transit, its `status: 'transit'` and private `transit` state (destination and arrival tick). Both appear only
under content that uses them: `content-10` tunes travel time to zero, so its frames never carry the state.
The change is additive, so minimum readers are unchanged. A reader that does not know the status draws nothing
for that player, as for any player that is not active.

## Schema 14: experimental hook (#446)

Schema 14 adds optional private `physics.hooks`, explicit bounded spring/rope
constraint fields, and optional `hookFlights` presentation records. This was
the next writer revision after L2's schema 13; the physics reader floor remains 10.
New P6 simulation behavior was separately identified
by `last-exit-0.8-physics-6` and `content-physics-6` until #921; no legacy content is changed.
P8 added explicit `last-exit-0.8-physics-8` / `content-physics-8` for local dynamic
navigation and drop-placement behavior. It keeps P6's frame representation,
schema and minimum reader; private local detours are not recorded. Old content
and recorded poses remain unchanged.
P9's local playtest export uses the separate `last-exit-physics-lab-1` diagnostic
format ([42.20](42.20-physics-p9.md)), with pinned map/content, ordered actions,
retained gameplay frames and private diagnostic samples. It is not accepted as
a production replay and changes no schema, reader floor or rules identity.
Flight/pending/pull transitions are stored state, not instructions to replay an
engine. Old frames omit the new records; seek/removal follows complete captured
lists. Private pending target/generation/force state never enters live projection.
