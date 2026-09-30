# Claude task: shared macro geometry revalidation

Status: ARCHIVED / COMPLETE. Ingested by Codex. Original brief follows; its timing
requirement is superseded by Corey's instruction to defer timing/tuning targets.
Corey launches Claude manually; communicate through the result
file. Codex has settled the contract below and owns later generator integration.

## Read and inspect

Read AGENTS.md, MODEL_HANDOFF.md, README.md, docs/DESIGN_DECISIONS.md,
docs/NEXT_TASKS.md, docs/MACRO_STRUCTURES.md, src/macro-types.ts, src/macro.ts,
src/nav.ts and tests/macro.test.ts. Inspect current files and preserve user edits.
The previous review is archived in docs/archive/2026-09-12-macro-review/.

## Objective

Implement one reusable recheck of retained corridors and route constraints
against a composition's current walls. `MacroComposition` now retains seed,
segmentOpen and world-space constraint definitions. Composition currently
checks corridors/routes inline and then drops only the local temporary inputs.
Replace those inline checks with a shared helper used by composeMacro and by
callers after changing final geometry. This is the prerequisite to micro/placement
validation, not the generator replacement itself.

## Contract decided by lead

Export `checkMacroRoutes(map: MacroComposition): MacroRouteCheck` from src/macro.ts.
Define `MacroRouteCheck` in src/macro-types.ts with:

```ts
interface MacroRouteCheck {
  valid: boolean;
  errors: string[];
  corridorsChecked: number;
  constraints: Array<{ placementId: string; id: string; connected: boolean }>;
}
```

- Input is a previously constructed composition. Source fields, ownership,
  dimensions, navBoxes and definitions are unchanged; walls may have been added,
  removed or replaced. This is not an arbitrary-JSON validator. Reject malformed
  wall records/non-finite wall coordinates and return errors instead of sending
  them to navigation. Do not assume a previous manifest proves anything.
- Always invalidate the target's nav cache at entry, including failure cases.
- Check every retained corridor segment using shared segmentClear. Original
  centre-line ownership containment was proved during composition and need not
  be rescanned. Count a corridor only if all its segments pass. Check all corridors
  and collect useful placement/id errors instead of stopping after the first.
- For every retained constraint, require both endpoints occupiable, then compute
  observed connectivity with existing reachable/nodeIndex and the defined radius.
  Record the observed result even when it mismatches desired connectivity. If an
  endpoint is blocked, record an error and omit that constraint's observation;
  blocked endpoints never count as a successful disconnected constraint.
- Return valid only if no errors. Report sampled disconnection precisely; do not
  claim continuous completeness. No tile edge or graph degree may grant passage.
- Do not modify walls, definitions, regions or prior manifests. Return a fresh
  report. composeMacro calls the helper once, rejects an invalid report using its
  existing authoring-error convention, and copies checked counts/observations
  into the initial manifest. Avoid maintaining two implementations of checks.
- No region regeneration is needed for this helper: changed final walls can be
  micro geometry and do not redefine macro paint/regions. seed and segmentOpen
  are retained for later reconstruction/codec work but do not drive this check.
- Precision stays at the documented 1e-9 endpoint ticks; do not replace it with
  tolerance-based last-writer agreement. Preserve ownership and mask behavior.

## Owned edits

Allowed: src/macro.ts, src/macro-types.ts, tests/macro.test.ts,
docs/CLAUDE_MACRO_REVALIDATION_RESULTS.md. No other edits. Do not update task or
handoff files: Codex archives and updates those on ingestion. Do not spawn more
agents. Do not touch sibling, dependencies, legacy artifacts, GUI/CLI/MCP, nav.ts
or core.ts. Escalate any necessary contract change in the result file first.

## Acceptance checks

Add focused tests showing: fresh compositions pass; corridor blockers added
after caches are populated fail; removed blockers allow recovery; retained
connected/disconnected constraints are reevaluated after geometry edits;
blocked endpoints fail even for a negative constraint; different radii evaluate
independently; result/definition/manifest objects are not aliased or overwritten;
non-finite wall input fails without navigation work. Use actual swept geometry.

Run npm test. Preserve the existing max-size containment regression budget.
Browser and 200-seed legacy batch are unnecessary because this task does not
change UI or the active generator. No new packages.

Write the results file with COMPLETE or BLOCKED, changed files, actual commands
and outcomes, any remaining failures/ambiguities and a concise next action for
Codex. Do not claim unrun tests.

Launch prompt: Read AGENTS.md and docs/CLAUDE_MACRO_REVALIDATION.md, implement the
task, verify it, and write docs/CLAUDE_MACRO_REVALIDATION_RESULTS.md.
