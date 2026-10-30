# Production park pocket adoption (#698)

Findings and limits: [42.25](../../42.25-park-pocket.md). Definitions:
[51.10](../../51.10-measurement.md). Open `index.html` for paired real-mask
previews and both-body route/structure summaries.

`manifest.json` pins source bytes, Node, base revision, exact decompressed #688
inputs/metrics and retained artifact hashes. It includes every tracked map and
shared source plus the new modules/audit helpers. The capture revision is initial
base `63fb8aa` with implementation edits identified by the source hashes,
subsequently committed as `d81e2226953a7ea5dbfe239d2fbd6c6e21553461`.
The legacy builder is read from that base and its source hash is pinned. Only its import paths are
rewritten into a gitignored temporary module so they resolve at their original
locations; those dependency modules have unchanged behavior here.

The capture pins raw source bytes. For comparisons across checkout line endings,
`artifact-verification.json` also supplies `lfSourceHashes`: UTF-8 source with
CRLF normalized to LF before SHA-256. This supplement was computed only after
all original raw source digests matched; it does not replace historical pins.

For width 12, 24 and 36, `size-W-after.json.gz` is a complete wire-8 map with
the actual production results at `types-56`. `size-W-report.json.gz` retains
all changed owner geometry, admission counts, independent thorough owner proof,
fixed endpoints, route statuses and points, actual after-loot checks, complete
map reports and structure measures. All parks in each input are rebuilt, and
every unaffected owner is retained. The large 12x6 park is an explicit no-fit
witness, not omitted evidence. `summary.json` is a compact view of those
reports; timing observations also appear in it and the HTML.

Run from the repository root at this source:

```powershell
node tools/park-pocket-audit.mjs test-results/park-pocket-recapture
```

The script uses the shared benchmark lock, warms both builders, runs three
sequential paired family builds, checks exact legacy reconstruction, deterministic
cell-list reorderings, final owner access/fill, content-version save behavior,
actual final loot access and fixed target detours/pocket gains. It separately
measures full-map routes and structure. Do not run competing gates or benchmarks.
Use a new output directory to preserve historical evidence. Timings vary, so
compare geometry/endpoints/statuses and structure rather than hashes of reports
containing wall-clock values.

`timing.json` separates family generation from admission including preparation
of the existing protected routes, independent final proof, and offline whole-map
analysis. It records Node and CPU. `initial-runtime-observations.json` preserves
the first run's costs/source hashes before additional audit assertions, admission
instrumentation and preview cropping. Production geometry is identical across
those audit refinements; do not combine runs into a latency claim.

The 51.10 empty/pocket/boundary definitions remain unchanged. Fixed queries use
whole-map meshes for both bodies; they check actual endpoint body discs and
audit every route segment at its navigation clearance, with existing endpoint
lead radii. Missing paths are separated into disconnected mesh components and
same-component search misses. Strata travel with fixed input pairs. No endpoint
is snapped or substituted. Invalid before endpoints remain failures; paired
valid-only statistics in 42.25 explicitly state their reduced denominators.

Old loot pairs carry `retainedAfter` membership. Geometry may legitimately
filter/resite loot through the existing builder policy; actual-after loot is a
separate category from all original targets. Both lists and every failure remain
in the raw evidence. This audit adds no production loot-ordering framework.
Orange preview lines are fixed pocket routes, teal dots actual loot, and red
rings after composition mark removed before-loot sites. Shadows/lighting/art
are not simulated; the preview shows collision geometry and a local crop.

The cached wider-family replay is retained separately as `park-replay.json`.
The full content sweep, changed-map diagnostics, final capture provenance and
verification results are recorded in 42.25/42.4 and the issue/PR handoff. No
historical #688/#694 capture or gameplay fixture is replaced by this report.

`verification.json` records the completed gates, intentional pre-capture failures,
unchanged sweep cases, final zero-drift comparison, fixture check and retained
artifact hashes. `artifact-verification.json` also binds the normalized source
digests to all 300 corresponding blobs at implementation commit `d81e222`.
