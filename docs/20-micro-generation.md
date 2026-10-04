# 20. Bounded micro generation

The game now has a standalone micro-generation implementation in
`map/micro/`. It accepts explicit regions and resolves them into the same
obstacles, roofs, windows and doors used by the live game. Live matches consume
the chain through `map/live.ts`; the legacy street generator remains available
for characterization. The macro generator, formerly the sibling
`last_exit_map` repository, now lives in `map/macro/` with its own tests and docs.
The server invokes the chain before creating the simulation and consumes its
completed results (22). Cell masks and replay compatibility are described in 26.

This is the current user-directed F-01 work. Macro gives micro an owned area and
constraints; micro chooses what occupies it. Cells and segments organize that
work without prohibiting freeform shapes. The priority is a reusable local SDK
of geometry and placement primitives; the shipped architecture builders are
examples, not an art-style backlog. The child-region decomposer now supplies
bounded candidate analysis and allocation; its design record is [19](19-decomposition-design.md).

## Reading guide

| ID | Topic | Read |
| --- | --- | --- |
| 20.1 | Region contract and briefs | [20.1](20.1-region-contract.md) |
| 20.2 | Geometry and access | [20.2](20.2-geometry-access.md) |
| 20.3 | Builders and child-region decomposition | [20.3](20.3-builders-decomposition.md) |
| 20.4 | Hierarchical generation and portal negotiation | [20.4](20.4-hierarchical-generation.md) |
| 20.5 | Tools and next boundaries | [20.5](20.5-tools-and-next-boundaries.md) |

## Earlier heading links

These links preserve bookmarks into the former single file.

<a id="input-and-output"></a>

- Input and output: [Input and output](20.1-region-contract.md#input-and-output).

<a id="briefs"></a>

- Briefs: [Briefs](20.1-region-contract.md#briefs).

<a id="geometry-and-reachability"></a>

- Geometry and reachability: [Geometry and reachability](20.2-geometry-access.md#geometry-and-reachability).

<a id="segment-requirements-across-hierarchy-levels"></a>

- Segment requirements across hierarchy levels: [Segment requirements across hierarchy levels](20.2-geometry-access.md#segment-requirements-across-hierarchy-levels).

<a id="builders-and-composition"></a>

- Builders and composition: [Builders and composition](20.3-builders-decomposition.md#builders-and-composition).

<a id="child-region-decomposition"></a>

- Child-region decomposition: [Child-region decomposition](20.3-builders-decomposition.md#child-region-decomposition).

<a id="combined-decomposition-and-generation"></a>

- Combined decomposition and generation: [Combined decomposition and generation](20.4-hierarchical-generation.md#combined-decomposition-and-generation).

<a id="bounded-hierarchical-exploration"></a>

- Bounded hierarchical exploration: [Bounded hierarchical exploration](20.4-hierarchical-generation.md#bounded-hierarchical-exploration).

<a id="dispatch-and-portal-negotiation"></a>

- Dispatch and portal negotiation: [Dispatch and portal negotiation](20.4-hierarchical-generation.md#dispatch-and-portal-negotiation).

<a id="physical-demonstration-policy"></a>

- Physical demonstration policy: [Physical demonstration policy](20.4-hierarchical-generation.md#physical-demonstration-policy).

<a id="inspect-and-verify"></a>

- Inspect and verify: [Inspect and verify](20.5-tools-and-next-boundaries.md#inspect-and-verify).

<a id="next-boundaries"></a>

- Next boundaries: [Next boundaries](20.5-tools-and-next-boundaries.md#next-boundaries).
