# Frames from the core's output: continuity (#1344)

Frames moved from the `Game` mirror to the core-fed frame store ([27.2](../../27.2-tick-architecture.md#frames-3d3),
recording schema 26). This report shows that the simulation did not move and the frames kept their values.

## Method

`node tools/frame-continuity.mjs --out frame-continuity-before.json` ran on the untouched tip of `main`, `08fb0e4d`, before
any edit. `--compare` then ran on the change. Both ran over the frozen fixture's stored arenas: the scripted scene on
seed 4217's arena (20 labelled captures) and the whole bot matches on seeds 9 and 4217 (3,206 and 3,254 ticks, cut into 100-tick
chunks). Each chunk holds three hashes:

- **core**: the core's opening snapshot, every completed tick (inbound queue, change list, discontinuities and
  discovery) and the whole core snapshot every hundredth tick, serialized as they are;
- **frame**: each private frame with sorted keys, less `receivedSeq`, `inputQueue` and `inputTick` on players;
- **views**: the `c0`, `g0` and directed projections of each frame, with sorted keys.

The comparison names the first unequal chunk of each kind.

## Result

```
scripted: core equal over 20 chunks
scripted: frame equal over 20 chunks
scripted: views equal over 20 chunks
bots-9: core equal over 33 chunks
bots-9: frame equal over 33 chunks
bots-9: views equal over 33 chunks
bots-4217: core equal over 33 chunks
bots-4217: frame equal over 33 chunks
bots-4217: views equal over 33 chunks
```

The core's output is byte-identical, so the simulation, the bots and the RNG and ID order are unchanged. Every frame and
view has the same values as before. A frame differs from its schema 25 form only in the order of its players' fields and
in the boundary fields it no longer carries. `inputMarginNext` is also no longer written, but no frame these traces
sample carried it: it is set by an admission and cleared by the next tick.

The exact fixture failed on the same code before the recapture, on frame bytes only. That shows the comparison ran the
new frames. The capture tool reproduced the old checkpoint exactly with `--check` on `08fb0e4d` before it recaptured.

## Limits

These traces are in-process matches without connections, so they never resume or relabel a seat. The room-tick tests
cover a room's joins, resumes, leaves, finish and recording. `tools/bot-label-witness.mjs` resimulates a room with
relabelled seats (26, Schema 25).
