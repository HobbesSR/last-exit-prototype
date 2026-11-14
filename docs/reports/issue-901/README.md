# Recording delta evaluation evidence (#901)

The owning summary is [42.22](../../42.22-tick-cost-attribution.md), "Recording delta
evaluation (#901)". These are prototype measurements for a format decision, not a
recording format, and not server tick or capacity measurements.

Source: main `4455dfb`, Node v24.15.0, 2026-11-14, `content-7`, seed 4217. Map caches came
from `tools/perf/room-startup.mjs --maps-cache` at the same revision (12x6 and 36x18). The
36x18 startup measurement in that cache run reported recorder drops while the 12x6 smoke probe
held the machine. The cache file is written before that measurement and was used unchanged.

Reproduce with `node --expose-gc --max-old-space-size=12288 tools/perf/recording-delta.mjs
--maps-cache=<cache> --out=<json>`, adding `--ticks=1200 --kept=1 --cadences=100` for the
kept-list encoder timing.

- `whole-12x6.json`: whole 12x6 match, 3,104 frames, cadences 20, 100 and 600.
- `whole-36x18.json`: whole 36x18 match, 12,001 frames (the 12,000-tick limit), same cadences.
  The top-level-key archive is too long to parse as one string and is reported as such.
- `kept-36x18-1200.json`: the first 1,200 ticks at 36x18, with the entity encoder skipping
  unchanged items and gates through their owners' kept JSON.

Every file's `verification` rebuilt every frame from each retained archive and compared it
with a fresh replay of the match. `matchesWriterDigest` is the SHA-256 over the rebuilt lines,
equal to the full-state digest. `cpu.msPerMiB` is synchronous gzip plus SHA-256 over the first
32 MiB of each stream. It is single-sample and noisy (5.8–14.1 ms/MiB), so only its range is used.

Browser check: `fetch('/replay').json()` in installed Chrome 157.0.8103.39 (headless, Playwright),
the replay served gzip-encoded as `server/http-api.js` serves it, with the call
`public/replay-controller.js` makes:

| Archive | Frames | Uncompressed | Result |
| --- | ---: | ---: | --- |
| `3e9b6803` (default size) | 2,852 | 468,451,880 B | loaded in 2.3 s |
| `916fc5b1` (default size) | 3,493 | 565,309,841 B | `SyntaxError: Unexpected end of JSON input` after 1.2 s |

V8's longest string is 536,870,888 characters (`buffer.constants.MAX_STRING_LENGTH`). The two
archives are local recordings from ordinary matches; they are not checked in.
