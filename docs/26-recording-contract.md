# 26. Recording contract

Recording failure must never reach gameplay. Current rules are `last-exit-0.7`,
default content is `content-2`, and recordings use schema 5 (4 added masked maps, 5 the diagnostics trailer). Masked live maps require reader 4; legacy maps keep
minimum schema 0.
Storage-only changes must preserve frozen gameplay fixtures.

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
zero so that archives predating the fields keep playing. That is policy, not format. Because both
sides record integers, a reader can later apply a range, a set of supported versions, or a
per-feature table without recordings changing shape again. Policy belongs to the reader; a recording
only states facts about itself.

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
Schema remains 3/minimum 0 because player arrays already support arbitrary lengths;
an extra roster entry is data, not a new field or format. Playback uses recorded
maps and frames, not a resimulation with today's default content, so both old and
new rosters remain playable without a content lookup. `content-1` remains explicitly
selectable for simulation characterization; this does not restore a 0.6 engine.

`version` is a separate axis and keeps its meaning: which simulation rules produced the recording.
The schema pair decides whether a file can be *read*; `version` says what its contents *mean*.
Recordings also embed their own map, so changing map generation never invalidates one. That is
also why map generation is not pinned the way weapons, kits and traps are: the embedded map is the
generator's output rather than its settings, and output is the stronger thing to keep. Reconstructing
an arena from pinned tuning could disagree with what was played; an embedded map cannot.

## Format and integrity

Each room records a map header and offers every authoritative tick to a bounded gzip JSON writer. Retained records contain a complete simulation snapshot plus accepted commands and membership changes. Frames include AI path state. The final metadata contains retained frame count and a SHA-256 digest over each retained serialized frame plus a newline. A recording is advertised only after successful publication. Disk backpressure never pauses tick advancement: incoming frames exceeding the pending-data budget are omitted whole, and subsequent frames can be accepted after the writer drains. Only archives with omissions add `recording: { complete: false, droppedFrames, endTick }` to the file and metadata; ordinary recordings retain their existing format and digest contract.

Normal recordings preserve the existing header, frame JSON and SHA-256 contract.
Only recordings with omissions append a top-level `recording` footer and matching
archive metadata: `{ complete: false, droppedFrames, endTick }`. Integrity hashes
cover exactly the retained frames as before. Missing ranges are derived from
retained `state.tick` values, avoiding an unbounded separate gap list. No surviving
frames means publication fails. An omitted final state must never be invented;
`endTick` records the actual match endpoint, even if the last surviving frame is
earlier. This additive extension does not change simulation version or BSON scope.

## Diagnostic markers (schema 5)

A recording may end with a top-level `diagnostics: { marks, dropped? }` trailer after
`frames`, written only when there is something to say, as `recording` is. It is additive
(`minSchema` is unchanged) and never touches frames or the digest, so ordinary recordings
keep their frame JSON and SHA-256 contract. They are in a trailer, not in frames, because
a frame is omitted whole under storage pressure, which is when a stall is most likely.
`writer.mark(marker)` keeps at most `MAX_DIAGNOSTIC_MARKS` (512); later ones are counted
in `dropped`. A crash `.partial` file loses the trailer, which is acceptable.

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
serialized frames into a bounded queue (default 8 MiB of uncompressed pending
data, including bytes handed to gzip but not consumed). Gzip/output stream buffers
have their own bounded high-water marks. An incoming frame that exceeds available
queue capacity is omitted in its entirety; no command/frame fragments are written.
The writer resumes accepting frames when capacity returns. It never retains
mutable snapshots. Serialization remains synchronous CPU work;
this isolates storage waits and failures, not arbitrary event-loop stalls.

## Playback

Replay playback restores recorded states directly, supports seeking by authoritative tick, and is independent of simulation determinism. Missing intervals hold the latest known state and display a missing-data indicator; no missing state is reconstructed. Full-map viewing is restricted to published recordings, which may be explicitly partial. This preserves exact retained game states, not pixel-identical visual effects; decorative animations use render time. Same-runtime deterministic simulation is tested separately, but cross-platform input-only reconstruction is not claimed. Abrupt power loss can leave an incomplete `.partial` file that is retained but excluded from archives; crash-file salvage remains separate from recovering a bounded live recording after temporary pressure.

Playback advances by recorded ticks, chooses the latest retained frame at or
before the playhead (last duplicate wins), and holds it through missing intervals.
Before the first retained tick it shows that first frame with a missing-data
indicator. Gaps and incomplete tails are labelled; do not extrapolate projectiles
through missing intervals. Legacy dense recordings remain playable. Archive rows
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
idempotent; `finish(result)` returns one shared completion promise. `blocked` may
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

Verification: retained-frame hash/JSON compatibility, queue bounds and ownership,
recovery after pressure with tick gaps, zero retained frames, synchronous start/
append failures, async stream and publication failures, stalled finalization,
idempotent close, continued input/other-room ticks, late joins, sparse playback
and live status UI. Run full checks/browser suite and isolated server/client
benchmarks. Owner-only access, retention, BSON, process isolation and crash-file
salvage remain separate follow-ups.

## Cell-masked maps (schema 4)

`GameMap.playableArea` records the owned cells as sorted row runs, including
holes, at a stated `cellSize`. Collision, prediction, the arena floor and the
minimap use it. Its absence retains the old diamond semantics. Maps also carry
optional `hunterSpawns`, a `generator` label (`chain-live-1`), and generated loot
`tier` metadata. Old archives keep their original map and frames.

Schema 4 identifies these additions. `minimumReaderForMap` requires reader 4 for
masked maps because older renderers would draw a diamond with the wrong floor;
legacy maps keep minimum 0, and this reader still accepts those older archives.
Simulation rules remain `last-exit-0.7` and tuning remains `content-2`: fixed-tick
order, input consumption, player sizes, combat and timers are unchanged. The
intentional new map content is named by `generator` and embedded in full, rather
than rebuilding an old recording with today's chain. Frozen characterization
continues to use its stored legacy maps and is not regenerated.
