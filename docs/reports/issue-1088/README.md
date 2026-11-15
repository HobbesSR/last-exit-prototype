# A starting room's own recording drops (#1088)

Owning measurement: [42.22](../../42.22-tick-cost-attribution.md#recording-opened-at-preparation-1088).

2026-11-15, Node v24.15.0, content-7, main `435c883`. No fixture, content, wire or
recording schema changed.

## First step: one room alone

A scratch probe started one 36x18 room (seed 4218, production-worker map) with no
other room, live-paced by the production scheduler, one dev viewer, recording
into a discarding output, and logged each `append`'s queue state. On main it
dropped ticks 3, 4 and 5. The header was 6.58 MB, each frame about 1.06 MB, so
the default budget was the header plus four frames. The header, frame 0 and
frames 1–2 were still pending (9.77 MB) when tick 3 arrived. The queue cleared
only around tick 6, about 330 ms after the start, while tick 1 itself took about
120 ms. **So the cause is the room's own start, not contention.** A shorter tick 1
does not remove it: four frames at the 50 ms cadence (~200 ms) were less than
the header's time to compress after the worker started. A match-only probe
recording every tick dropped 10–11 frames at its start for the same reason.

## Choice

Of the issue's two routes, this writes the header earlier, during preparation,
which [26](../../26-recording-contract.md#bounded-recording) allows without changing a byte:
the header's fields are all known once the match is prepared (`createdAt` is the
room's). A larger start budget would still lose at 72x36, where frames are about
3.3 MiB and the header grows with the map. The room opens its recording when the match is prepared and
adopts the match once the writer reports the header taken into gzip (`opened`),
bounded at five seconds. A file store creates its file only at the first frame,
so a room that never starts discards its recording without a file or a reported
error.

## Results

| Run | Recorder drops (cold room, new room) | Cold make/ready wall / CPU, ms | Concurrent make/ready, ms |
| --- | --- | --- | --- |
| main, 36x18 (four runs from the #1087 pairs) | 10,1 / 10,1 / 11,1 / 10,1 | 653.5–669.5 / 969–1218 | 789.0–1059.7 |
| #1088, 36x18 run 1 / 2 / 3 | 0,0 / 0,0 / 0,0 | 796 / 806 / 810, CPU 1359–1484 | 1011 / 1005 / 966 |
| #1088, 12x6 run 1 / 2 / 3 | 0,0 / 0,0 / 0,0 | 189–197, CPU 234–375 | 169–182 |

The alone probe on the branch kept every frame: the queue was empty at tick 0
and 1, and at most two frames were pending afterwards. Every run had zero lifecycle errors and
no contention stamp. Readiness at 36x18 grows by about 140 ms, the header's
compression, which moves out of play. Comparisons with main use same-day runs on
the same cache, not alternating pairs.

The byte claim is tested directly: `tests/replay-writer.test.js` records the same
header and frames through the file store with the header written early and late,
and the compressed archives are byte-identical.

## Retained files

- `summary.json.gz`: per-run drops, phases, wall/CPU, contention and cache
  digests for the runs above, and both alone-probe outputs.
