# 26. Recording contract

Recording failure must never reach gameplay. Simulation stays `last-exit-0.6`;
frozen gameplay fixtures must remain unchanged by anything in this file.

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
