# mapgen's docs before integration (to 2026-09-29)

These were mapgen's own docs until they were folded into the repository's
numbered set (root 50–53 and 17). They describe mapgen's old generators,
`generateMap` and `generatePlannedMap`, which were deleted at the generation
chain's switch-over (root 51, step 10; #146). The code they describe is in git
history before that change.

They are plain history. For direction, read the numbered docs.

| File | Covered | Now in |
| --- | --- | --- |
| `DESIGN_DECISIONS.md` | Map layers, the old chain stages, primitives, segment prescriptions, reachability, regions and micro, encoding, wire form, BSON, build, provenance | Decisions: 51, 52, 53. Answers: 17. Old-code detail is history |
| `VOCABULARY.md` | Layering rule, primitives, cell class, region, tier zone, tile, coordinates | 52 |
| `QUESTIONS.md` | mapgen's open questions and Corey's answers | 17, "Map generation", verbatim |
| `NEXT_TASKS.md` | mapgen's backlog | Retired. Direction is in 51 and 16; order is in 41 and on Forgejo |
| `MICRO_GENERATION.md` | mapgen's builder contract, catalogue, streets and blocks | Retired; the micro half is 19 and 20 |
| `PLANNED_GENERATION.md` | The planned path | Retired (50) |
| `MACRO_STRUCTURES.md` | The macro structure contract (`macro.ts`) | Retired (51) |
| `VALIDATION.md` | A checkpoint report from the legacy generator | History |
| `MODEL_HANDOFF.md` | Session handoffs | History; handoffs now go on Forgejo (root 34) |
