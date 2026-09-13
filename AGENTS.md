# Last Exit Map Lab

Read README.md, docs/DESIGN_DECISIONS.md and docs/NEXT_TASKS.md before substantive work. Read design_notes.txt for original user intent. Implementation documents describe current behavior and reversible defaults, not an overriding specification. The retired Claude proposal in docs/archive/retired-design-proposal/ is historical only. Keep unanswered design choices in docs/QUESTIONS.md; proceed with documented reversible defaults.

This repository is a standalone experiment. Inspect ../astra_test read-only for game context; do not couple or modify the sibling without explicit task scope. Prioritize working and tunable flat 2D. 2.5D is later. GUI, CLI and MCP must share the core rather than reimplement generation.

Corey explicitly requests cost-aware delegation when a bounded task can run alongside useful lead work: GPT-5.6 Terra at medium reasoning for focused coding/tests, GPT-5.6 Luna for narrow documentation/inventories. Use fresh compact briefs and nonoverlapping edit ownership. Keep architecture and consequential integration with the lead. Announce substantive delegation and model choice, review actual diffs/evidence, and do not delegate tiny tasks merely to increase agent count. Workers should not spawn further agents without a lead request.

Run npm test for core/tooling changes and node tests/browser.mts for meaningful UI behavior changes. Browser tests can reuse Playwright from the sibling; runtime must not import the sibling. Use bounded seed batches for generator changes and report actual sample limits. Do not call graph connectivity a proof for geometry that has not been checked. Keep navigation cache invalidation and region manifest validation intact.
