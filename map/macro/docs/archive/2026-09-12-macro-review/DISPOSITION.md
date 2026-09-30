# Review disposition, 2026-09-12

Claude's review is complete and ingested. Original task/result and previous
handoff are preserved alongside this file; no review evidence was deleted.

- BUG-1 / ESC-1 fixed and settled: aperture endpoints normalize to 1e-9-cell
  integer ticks on ingest; reversal uses tick subtraction. Exact normalized
  agreement preserves placement-order independence without coarse half/quarter
  restrictions. Collapsed spans reject. Decimal and third-valued mirrored spans
  now have regression coverage. Tolerance-only merging was declined because it
  permits last-writer geometry drift and non-transitive agreement.
- BUG-2 fixed: all optional lists use nullish-list validation. Falsy scalars
  receive authoring diagnostics. Tests cover 0, empty string and false.
- PERF-1 fixed: containment checks at most four incident-cell keys per point,
  with no footprint scan or repeated string parsing. Repeated world/mask
  containment is removed: local containment plus verified transformed ownership
  implies mask containment. Existing gap/seam checks continue to pass. A bounded
  366x186, 20-point zigzag corridor test took 304 ms in the first full-suite run;
  budget is 2 s. This is one local measurement, not a throughput guarantee or an
  exact reproduction of Claude's unpublished probe polyline.
- ESC-2 settled: output now retains seed, resolved segment spans and copied
  world-space route definitions. A shared geometry recheck is the next delegated
  task in docs/CLAUDE_MACRO_REVALIDATION.md. Full artifact/import validation and
  micro output checks remain pending migration work.
- OPT-1 deferred: internal solid walls are harmless and preserving their current
  semantics avoids coupling a geometry cleanup to this fix.
- OPT-2 deferred to micro integration: no micro obstacles exist in composition;
  a returned composition has passed all macro corridors. Region manifests are
  not accepted as proof of those checks.
- OPT-3 deferred: geometry/regions are order independent; metadata arrays retain
  input order. Whole-object canonicalization is not promised.
- OPT-4 fixed: removed duplicate span validation, preserving the qualified error.

Core validation: npm test passed 70/70 including typecheck after bug/performance
fixes. Final validation after retained-output changes is recorded in the current
MODEL_HANDOFF.md. Browser and legacy batch were not repeated for these changes
to the experimental composition API; their preceding checkpoint passes remain
historical evidence, not new checks.
