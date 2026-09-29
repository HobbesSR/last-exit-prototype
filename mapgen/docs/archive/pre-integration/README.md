# mapgen's docs before integration (to 2026-09-29)

These were mapgen's own docs until they were folded into the repository's
numbered set (root 50–53 and 17). They still describe the code that runs today,
mapgen's `generateMap` and `generatePlannedMap`, and they retire with it at the
generation chain's switch-over (root 51, step 10).

Read them only when changing that old code. For direction, read the numbered
docs, where statements here that conflict with the chain are superseded.

| File | Covered | Now in |
| --- | --- | --- |
| `DESIGN_DECISIONS.md` | Map layers, the old chain stages, primitives, segment prescriptions, reachability, regions and micro, encoding, wire form, BSON, build, provenance | Decisions: 51, 52, 53. Answers: 17. Old-code detail stays here |
| `VOCABULARY.md` | Layering rule, primitives, cell class, region, tier zone, tile, coordinates | 52 |
| `QUESTIONS.md` | mapgen's open questions and Corey's answers | 17, "Map generation", verbatim |
| `NEXT_TASKS.md` | mapgen's backlog | Retired. Direction is in 51 and 16; order is in 41 and on Forgejo |
| `MICRO_GENERATION.md` | mapgen's builder contract, catalogue, streets and blocks | Retiring; the micro half is 19 and 20 |
| `PLANNED_GENERATION.md` | The planned path | Retiring (50) |
| `MACRO_STRUCTURES.md` | The macro structure contract (`macro.ts`) | Retiring (51) |
| `VALIDATION.md` | A checkpoint report from the legacy generator | History |
| `MODEL_HANDOFF.md` | Session handoffs | History; handoffs now go on Forgejo (root 34) |
