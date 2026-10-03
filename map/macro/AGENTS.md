# Map generator (map/macro/, "mapgen")

These rules add to the repository root `AGENTS.md`, which carries the session
start rules, delegation policy and the Forgejo workflow. Run commands from this
directory unless a step says otherwise.

mapgen owns macro generation: the tile library, placement, regions, the
reachability proof and region briefs. `map/micro/` owns what fills a region.
Don't extend mapgen's own micro layer (`src/micro/`), which duplicates
`map/micro/`, or its planned path (`src/plan/`). Both retire when the
generation chain lands. Whatever macro and micro must share lives in
`map/kernel/`, which neither owns (root 50).

## Before substantive work

Read, in this order:
1. `design_notes.txt`, the original statement of intent. Corey's later answers
   in root 17 and the accepted model in root 51 govern where they differ.
2. Root `docs/50-map-generation.md`: the two halves, who owns what, and a
   reading guide.
3. The 5x file for the area you're changing:
   - `docs/51-generation-chain.md`: the chain and its build order
   - `docs/52-map-primitives-and-library.md`: the library model
   - `docs/53-map-artifacts-and-tools.md`: artifacts, determinism, the sweep and
     tools
4. For anything inside a region: root docs 19 and 20.
5. Root `docs/17-open-questions.md`, "Map generation": Corey's verbatim answers,
   and the open questions with their working assumptions.
6. The Forgejo issue you're working on, and its latest handoff.

`docs/archive/pre-integration/` holds mapgen's former docs. They describe the
old generators (`generateMap`, `generatePlannedMap`) until those retire. Read
them only when changing that code, and don't take them as current direction.

Before adding a mechanism, search both halves for an existing one. The SDK,
mapgen and the planned path have each built the same thing more than once
(50, "Duplication ledger").

## Rules

- Proceed with a documented working assumption rather than stopping. Record an
  unanswered design choice in root 17, "Map generation".
- Work in flat 2D. 2½D is deferred.
- The GUI, CLI and MCP share the core rather than reimplementing generation.
- Keep navigation cache invalidation and region validation intact.
- Don't call graph connectivity a proof for geometry that hasn't been checked.
- Use bounded seed batches for generator changes, and report the actual sample
  sizes.

## Checks

- `npm test` (typecheck plus unit tests) for core and tooling changes.
- The Map Lab is in `map/tools/lab/` now; its browser check is
  `node map/tools/tests/lab.browser.mts`, from the repository root.
- The seed sweep for any change to the old generators (root 53 and 31).
