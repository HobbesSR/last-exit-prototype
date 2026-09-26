# Map generator (mapgen/)

These rules add to the repository root `AGENTS.md`, which carries the session
start rules, delegation policy and the Forgejo workflow. Run commands from this
directory unless a step says otherwise.

Read README.md, docs/DESIGN_DECISIONS.md and docs/NEXT_TASKS.md before substantive work. Read design_notes.txt for original user intent. Implementation documents describe current behavior and reversible defaults, not an overriding specification. The retired Claude proposal in docs/archive/retired-design-proposal/ is historical only. Keep unanswered design choices in docs/QUESTIONS.md; proceed with documented reversible defaults.

This directory was the separate `last_exit_map` repository until its history was imported here. The game does not import it yet; wiring it in is ordinary integration work governed by the root docs (20 and 22), not a boundary to defend. Prioritize working and tunable flat 2D. 2.5D is later. GUI, CLI and MCP must share the core rather than reimplement generation.

Run npm test for core/tooling changes and node tests/browser.mts for meaningful UI behavior changes. Browser tests resolve Playwright from the repository root's dependencies. Use bounded seed batches for generator changes and report actual sample limits. Do not call graph connectivity a proof for geometry that has not been checked. Keep navigation cache invalidation and region manifest validation intact.
