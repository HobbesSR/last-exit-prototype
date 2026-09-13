# 33. Maintenance rules

## Where a fact belongs

One statement of each fact, in one file. Before adding a paragraph, check whether
it restates something in another numbered file; if it does, link the number instead.

| The change is | Update |
| --- | --- |
| A gameplay rule, capacity, or balance number | [14](14-match-rules.md), and the F-## or P-## row it satisfies |
| A newly accepted feature or a status change | [13](13-accepted-features.md) |
| An answer to an open question | [17](17-open-questions.md), verbatim, then the requirement row it becomes |
| Module structure, ownership, or a contract | The relevant 2x file |
| A measurement | [42](42-performance-history.md), with its workload and limits |
| What to build next | [41](41-roadmap.md) |

When a requirement changes, update its row first, then the explanation in a 2x file
only if the explanation belongs there. Add or update an acceptance test for every
implemented requirement, in the same change. Keep deferred work in
[16](16-deferred.md) until it is either implemented and tested or explicitly removed
by a design decision. Record meaningful engine or library substitutions in
[21](21-stack.md) with license and rationale.

## Rules for this documentation

- The number is the identity. Do not renumber a file; add a new number instead.
- Cite numbers, not headings, in briefs and handoffs.
- A status column says whether behavior exists. "Accepted" never means implemented.
- Preserve the user's verbatim answers in [17](17-open-questions.md). Do not
  paraphrase them into a requirement and delete the original.
- Do not record a measurement without its workload, machine and limitations.
- Point-in-time reports do not belong here. A finished verification pass leaves its
  durable findings in [42](42-performance-history.md); its narrative stays in the
  commit and the handoff.
