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
| What to build next | [41](41-roadmap.md) |
| Work in progress or a session handoff | A comment on its Forgejo issue or pull request ([32](32-delegation.md)) |

When a requirement changes, update its row first, then the explanation in a 2x file
only if the explanation belongs there. Add or update an acceptance test for every
implemented requirement, in the same change. Keep deferred work in
[16](16-deferred.md) until it is either implemented and tested or explicitly removed
by a design decision. Record meaningful engine or library substitutions in
[21](21-stack.md) with license and rationale.

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
  commit and the handoff.

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
their task boundaries justify it. New topics can use children instead of filling
another top-level range. The two-digit area system in [00](00-index.md) stays intact.
