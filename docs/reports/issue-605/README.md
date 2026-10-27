# Issue #605 calibration evidence

These retained reports record the sequential observations described in
[42.3](../../42.3-generation-and-delegation-evidence.md#decomposition-counted-work-calibration-605--535-2026-10-26).
They are historical captures, not repeatability or worst-case guarantees. Both
predate the later dispatch optimization. The budgeted capture records a dirty
worktree and source hashes; its script hash names the script at capture time,
before the later removal of its UTF-8 byte-order mark.

| Report | SHA-256 of committed bytes |
| --- | --- |
| `baseline.json` | `f4171ac7b753dac8accb245396aef6c3e118b057e7ad3494da8d53520a5ecf58` |
| `budgeted.json` | `d798b5bd8ad4028160d58b13892db9d13f2d4ee5bcc2e341afd20a3e48e2a86e` |

Run `node tools/decomposition-budget-measure.mjs --out=PATH` for a fresh
observation. Timing depends on the machine and workload; the current script
also reports the input briefs and source hashes used for that run.
