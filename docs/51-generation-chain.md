# 51. The generation chain

Status: accepted 2026-09-28 (PR #80). Integrated with the game's micro half
2026-09-29 (50). Built through the switch-over, 2026-10-03 (step 10). Live matches now use it through the map-layer adapter (14, 20, 22).

This document family specifies map generation as a series of checkpoints with clear
interfaces between them. mapgen owns the macro stages, 0 to 5 and the map-level
part of 8. The game owns what happens inside a region, stages 6 and 7 (50).
The pipeline is new, and it reuses existing leaf modules on both sides.

mapgen's old generators, `generateMap` and `generatePlannedMap`, were deleted
at the switch-over (step 10, #146), not kept as legacy. The archived mapgen
docs in `map/macro/docs/archive/pre-integration/` describe them, as history.

Corey's directions for the chain (2026-09-28 and 29), verbatim in
[17.2.3](17.2.3-chain-and-authoring.md) and [17.2.2](17.2.2-boundaries-and-prescriptions.md):
- rebuild generation as a series of transforms with clear interfaces
- name superficially similar objects apart, and make pure readings views
- set pieces keep their distribution, and core elements belong to set piece classes
- region types' builders deliver the core elements
- macro prescribes no geometry
- the library is authored fresh against a region type catalogue

`map/macro/design_notes.txt` is the original statement of intent. Corey's later answers under [17.2](17.2-map-questions.md) and the accepted model in 51 govern where they differ. For example, the notes describe segment-aligned fences and doors, and [17.2.2](17.2.2-boundaries-and-prescriptions.md) records that macro prescribes no geometry for now.

## The chain

```
Library ─┐
seed ────┼─► Placement ─► Layout ─► Resolution ─► ResolvedLayout ─► Regions ─► LayoutRegions
params ──┘                (object)                (view)                       (view)
                                                                                 │
                                          Proof ◄────────────────────────────────┤
                                          (view)                                 ▼
                                                                    Briefs ─► RegionBrief[] (view)
─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ mapgen above, the game below (50) ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─
                                                                                 ▼ one per region
                                                                    Build ─► RegionResult[] (object)
                                                                                 │
                                                                    Composition ─► BuiltMap (view)
                                                                                 │
                                                                                 ▼
                                                                    Measurement ─► Report (view)
```

Only two things hold decisions: the **Layout** (placement's draws) and the
**region results** (the strategies' output). Everything else is a view. A
saved map is therefore a Layout, optionally with its region results (see
[51.12](51.12-map-and-saving.md)).

## Reading guide

Start with [51.1](51.1-principles-and-names.md) for the shared invariants and vocabulary, then load only the stage or concern being changed. Stage numbers (0-8), build steps (1-10) and tracks (A-C) keep their original meaning; decimal document IDs are separate stable citations.

<a id="stages"></a>

| Part | Load for |
| --- | --- |
| [51.1](51.1-principles-and-names.md) | Principles and vocabulary |
| [51.2](51.2-library.md) | Library (stage 0) |
| [51.3](51.3-placement.md) | Placement (stage 1) |
| [51.4](51.4-resolution.md) | Resolution (stage 2) |
| [51.5](51.5-regions.md) | Regions (stage 3) |
| [51.6](51.6-proof.md) | Proof (stage 4) |
| [51.7](51.7-briefs.md) | Briefs (stage 5) |
| [51.8](51.8-build.md) | Build (stage 6) |
| [51.9](51.9-composition.md) | Composition (stage 7) |
| [51.10](51.10-measurement.md) | Measurement (stage 8) |
| [51.11](51.11-core-elements-and-playground.md) | Core elements and playground mode |
| [51.12](51.12-map-and-saving.md) | Map container and saving |
| [51.13](51.13-reuse-and-retirement.md) | Reused modules and retired paths |
| [51.14](51.14-build-order.md) | Build order and implementation record, by track |
| [51.15](51.15-earlier-issues.md) | Earlier issue mapping |

## Earlier heading links

These landing links preserve bookmarks into the former single file.

<a id="principles"></a>

- Principles: [51.1](51.1-principles-and-names.md#principles).

<a id="names"></a>

- Names: [51.1](51.1-principles-and-names.md#names).

<a id="0-library-input-all-prescriptions"></a>

- 0. Library (input, all prescriptions): [51.2](51.2-library.md#0-library-input-all-prescriptions).

<a id="1-placement-seed-params-library--layout-object"></a>

- 1. Placement: seed, params, library → **Layout** (object): [51.3](51.3-placement.md#1-placement-seed-params-library--layout-object).

<a id="2-resolution-layout--library--resolvedlayout-view"></a>

- 2. Resolution: Layout + library → **ResolvedLayout** (view): [51.4](51.4-resolution.md#2-resolution-layout--library--resolvedlayout-view).

<a id="3-regions-resolvedlayout--layoutregions-view"></a>

- 3. Regions: ResolvedLayout → **LayoutRegions** (view): [51.5](51.5-regions.md#3-regions-resolvedlayout--layoutregions-view).

<a id="4-proof-layoutregions--reachabilityproof-view"></a>

- 4. Proof: LayoutRegions → **ReachabilityProof** (view): [51.6](51.6-proof.md#4-proof-layoutregions--reachabilityproof-view).

<a id="5-briefs-layout-layoutregions-zones-cell-size--regionbrief-view"></a>

- 5. Briefs: Layout, LayoutRegions, zones, cell size → **RegionBrief[]** (view): [51.7](51.7-briefs.md#5-briefs-layout-layoutregions-zones-cell-size--regionbrief-view).

<a id="6-build-each-regionbrief--regionresult-object-in-the-game"></a>

- 6. Build: each RegionBrief → **RegionResult** (object), in the game: [51.8](51.8-build.md#6-build-each-regionbrief--regionresult-object-in-the-game).

<a id="7-composition-layout-layoutregions-region-results--builtmap-view-in-the-game"></a>

- 7. Composition: Layout, LayoutRegions, region results → **BuiltMap** (view), in the game: [51.9](51.9-composition.md#7-composition-layout-layoutregions-region-results--builtmap-view-in-the-game).

<a id="8-measurement-builtmap-proof-layout--report-view"></a>

- 8. Measurement: BuiltMap, proof, Layout → **Report** (view): [51.10](51.10-measurement.md#8-measurement-builtmap-proof-layout--report-view).

<a id="core-elements"></a>

- Core elements: [51.11](51.11-core-elements-and-playground.md#core-elements).

<a id="playground-mode"></a>

- Playground mode: [51.11](51.11-core-elements-and-playground.md#playground-mode).

<a id="what-the-finished-map-is"></a>

- What the finished map is: [51.12](51.12-map-and-saving.md#what-the-finished-map-is).

<a id="saving"></a>

- Saving: [51.12](51.12-map-and-saving.md#saving).

<a id="reused-on-each-side"></a>

- Reused, on each side: [51.13](51.13-reuse-and-retirement.md#reused-on-each-side).

<a id="retired-when-the-chain-lands"></a>

- Retired when the chain lands: [51.13](51.13-reuse-and-retirement.md#retired-when-the-chain-lands).

<a id="build-order"></a>

- Build order: [51.14](51.14-build-order.md#build-order).

<a id="earlier-issues"></a>

- Earlier issues: [51.15](51.15-earlier-issues.md#earlier-issues).
