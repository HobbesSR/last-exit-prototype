# 33. Maintenance rules

## Where a fact belongs

One statement of each fact, in one file. Before adding a paragraph, check whether
it restates something in another numbered file; if it does, link the number instead.

| The change is | Update |
| --- | --- |
| A gameplay rule, capacity, or balance number | [14](14-match-rules.md), and the F-## or P-## row it satisfies |
| A newly accepted feature or a status change | [13](13-accepted-features.md) |
| An answer to an open question | The relevant record under [17](17-open-questions.md), verbatim, then the requirement row it becomes |
| Module structure, ownership, or a contract | The relevant 2x file or decimal child; [20](20-micro-generation.md) and [22](22-ownership.md) route by concern |
| A map generation decision: the chain, the library model, artifacts or tools | The relevant 5x file. The micro half stays in 19 and 20 |
| An answer about map generation | The relevant record under [17.2](17.2-map-questions.md), verbatim; retain its M-number where one exists |
| A measurement | [42](42-performance-history.md), with its workload and limits |
| Raw measurement data supporting a durable finding in 42 or a child | `docs/reports/`, linked from the owning numbered document; retain source/configuration provenance and distinguish historical results from new runs. Transient outputs stay in `test-results/` |
| What to build next | [41](41-roadmap.md) |
| Work in progress or a session handoff | A comment on its Forgejo issue or pull request ([32](32-delegation.md)) |

When a requirement changes, update its row first, then the explanation in a 2x file
only if the explanation belongs there. Add or update an acceptance test for every
implemented requirement, in the same change. Keep deferred work in
[16](16-deferred.md) until it is either implemented and tested or explicitly removed
by a design decision. Record meaningful engine or library substitutions in
[21](21-stack.md) with license and rationale.

## Ownership and retained evidence

The #380 ownership decision separates current contracts from dated observations:

| Fact | Canonical owner |
| --- | --- |
| Active map compatibility domains and refusal rules | [53](53-map-artifacts-and-tools.md); separate wire, macro, library, module and region-result versions |
| Delegation execution, builder and snapshot compatibility | [20.7](20.7-builder-delegation.md) |
| Replay format/read floor, simulation meaning and content selection | [26](26-recording-contract.md), with gameplay defaults in [14](14-match-rules.md) |
| Complete fixture lineage, digests and reconstruction | [Fixture README](../tests/fixtures/README.md); [31](31-verification.md) owns verification policy |
| Catalogue intent, status, fallback and type-specific obligations | [54](54-region-types.md); implementation mechanics in [20.3](20.3-builders-decomposition.md), margins in [20.6](20.6-passable-margins.md), delegation in 20.7 |
| Current unresolved slowdown status | [42](42-performance-history.md#the-reported-slowdown-is-still-open) |
| Runtime measurements | [42.2](42.2-runtime-performance.md) |
| Generation, delegation and verification-cost evidence | [42.3](42.3-generation-and-delegation-evidence.md) |
| Dated chain captures | [42.4](42.4-chain-checkpoint-history.md) |
| Player/operator entry commands; developer labs; agent setup | [README](../README.md); [20.5](20.5-tools-and-next-boundaries.md); [34](34-forgejo-workflow.md) respectively |

Retain historical evidence in the repository. Keep witness scripts at their
existing paths; moving documentation does not authorize deleting or adapting them.
A historical witness may require its recorded revision and input, rather than HEAD.
Keep source pins, dates, workload/seed/shape/roster, machine/runtime/browser/viewport
where known, dirty-source state, dependency pins, run order/count, aggregation,
input hashes, raw locations and negative findings with each measurement. Explicitly
mark missing provenance as unknown; do not borrow another record's machine details.
A new rerun is new evidence, never a replacement for a missing historical artifact.

Before moving a section that cites local raw artifacts, inspect those artifacts and
retain substantiated durable data under `docs/reports/` with source paths, checksums
and provenance. Keep original local files intact. If a required artifact or input pin
cannot be established, leave the affected block in place and record the gap. A
compact guide must not replace the evidence it links to. Keep safety-critical
fixture rules in AGENTS even when complete provenance has one owner.

### Runnable tools and historical witnesses

| Class | Retained paths and source context |
| --- | --- |
| Maintained command/test surface | `tools/{micro-region,decompose-region,builder-fill}.mjs`; `map/tools/{cli,mcp,sweep}.mts` and dependencies; `tools/forgejo-usage.mjs` and `tools/doc-reads.mjs` are machine-local process tooling |
| Active navigation research/test dependencies | `tools/navigation/{clearance,graph,hierarchy,optimistic,witnesses}.mjs`; retain while #353 remains open and while tests import them |
| Reproducible navigation reports | `tools/navigation/{report,continuation}.mjs`, `docs/reports/navigation-364.json`, `navigation-364-continuation.json`; source pins and limits in [42.1](42.1-navigation-experiment.md). `tools/navigation/portal-report.mjs` and `docs/reports/navigation-420.json`, in [42.5](42.5-portal-graph.md). `tools/navigation/mesh-report.mjs` and `docs/reports/navigation-422.json`, in [42.7](42.7-navigation-mesh.md) |
| Fixture-reproduction witnesses | `tools/compound-siting-audit.mjs`, `compound-siting-solution-audit.mjs`; exact briefs and commands in the fixture README; full-map regeneration is a different workload |
| Pinned migration witness | `map/tools/tests/library-v3-audit.mjs`, S3 source pin `3fe884f`, 224-case comparison; a HEAD assertion failure does not justify deletion |
| Historical audit/timing harnesses | `tools/{boundary-portal-audit,depot-portal-audit,local-quarter-fill-audit,delegation-adoption-audit,compound-delegation-audit,compound-delegation-timing,hut-delegation-audit,hut-delegation-timing}.mjs`; source/input context in 42.3 |

Hut witnesses load `3b54da0`, with `e6d0449` also used by timing. Compound
preparation timing defaults to `4a7a5ba`; the recorded after run uses `0a8e3aa`
and contemporaneous sibling modules. Compound adoption consumes the preserved
`types-24` candidate report, not an equivalent rerun on an already-adopting HEAD.
Timing harnesses may create temporary patched source files; they are not unit gates.
Do not claim fresh-checkout reproducibility without verifying retained input
locations and explicit input flags or a non-destructive setup recipe.

## Rules for this documentation

- The number is the identity. Do not renumber a file or reuse a retired number.
  Add a new number instead. Decimal children follow the rules below.
- Cite the most specific owning number, not a heading, in briefs and handoffs.
- A status column says whether behavior exists. "Accepted" never means implemented.
- Preserve the user's verbatim answers in the records under [17](17-open-questions.md). Do not
  paraphrase them into a requirement and delete the original.
- Do not record a measurement without its workload, machine and limitations.
- Point-in-time reports do not belong here. A finished verification pass leaves its
  durable findings in [42](42-performance-history.md); its narrative stays in the
  commit and the handoff. Raw evidence for those findings may be committed under
  `docs/reports/` as specified in the placement table; that directory is not a
  home for session narratives or transient test outputs.

## Hierarchical documents

Use a child when a topic is independently useful and its parent makes tasks load
unrelated material. Choose coherent contracts or tasks as boundaries; do not split
every heading or answer merely to make files equally small. Shared prerequisites
belong in one place, linked by the guide and by the parts that need them.

- Allocate the next unused positive integer under the parent: `51.16`, then
  `51.17`. Treat components as integers when ordering; `51.10` follows `51.9`.
  Children can themselves branch, as `17.2` does into `17.2.1`. Their IDs do not change when
  topics are reordered, inserted or renamed.
- Name files `<number>-<topic>.md` in `docs/`, give each a matching numbered H1,
  and link back to its immediate parent. The parent lists each immediate child
  with enough description to select it without opening all of them.
- On a split, keep the old filename and number as a guide. Move the source
  content, including status, dates, answers and historical IDs, without changing
  decisions. Keep landing links for moved heading anchors in the old file; update
  same-file references such as "above" to point to their new home.
- Update 00, relevant reading guides and task instructions in the same change.
  Existing broad citations stay valid through the parent. Refine active task
  routes to specific children; archived records and old Forgejo comments need
  not be rewritten. Do not copy facts into the parent to make it self-contained.
- Verify moved content and verbatim answers against the pre-split version. Check
  local Markdown targets and heading fragments, unique IDs, parent/child routes
  and the resulting diff. Documentation-only splits do not require simulation or
  benchmark runs; changes to executable checks require their focused validation.

Issue #100 migrates 17, 20, 22 and 51, whose breadth was already making tasks load
unrelated context. Other files keep their identities and content; split them when
their task boundaries justify it; #510 split 53, 54, 22.6, 20.3 and 29 that way, after measuring
what agents' reads of them loaded (`npm run docs:reads`, from Claude Code transcripts;
`-- --since <ISO date>` measures after a split). New topics can use children instead of filling
another top-level range. The two-digit area system in [00](00-index.md) stays intact.
