# Macro switch-over and build history

This archive holds the completed macro generation-chain switch-over and build
record: retired documents 51.13–51.15, including their decimal children. These
numbered IDs remain retired and must not be reused. The records are retained for
their dated decisions, issue mapping, and implementation history; wording, dates
and IDs are preserved. Relative links to active documents are retargeted for the
archive location.

Current guidance is owned by [51.1 principles](../../51.1-principles-and-names.md),
[51.3 placement](../../51.3-placement.md), [51.4 resolution](../../51.4-resolution.md),
[51.5 regions](../../51.5-regions.md), [51.6 proof](../../51.6-proof.md),
[51.7 briefs](../../51.7-briefs.md), [51.8 build](../../51.8-build.md),
[51.9 composition](../../51.9-composition.md), [51.10 measurement](../../51.10-measurement.md),
[51.12 saving](../../51.12-map-and-saving.md), [50 map-generation ownership](../../50-map-generation.md),
[20.5 tools and next boundaries](../../20.5-tools-and-next-boundaries.md),
and [53.1 tools](../../53.1-map-lab-and-tools.md).

The archived `wfc.ts` references in [51.13](51.13-reuse-and-retirement.md#reused-on-each-side)
and [51.14.1](51.14.1-macro-placement.md) describe the pre-#1004 solver context.
#1004 removed chain imports and relation-name knowledge: callers supply
orthogonal relations, the solver owns generic trace types, and orientation is
carried generically. The current `wfc.ts` retains its compatibility function and
named relations. Older comparisons with the pre-integration paths also predate
their retirement at #146.
