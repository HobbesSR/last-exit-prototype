# 19. Region decomposition design

Accepted direction supplied by the user on September 22–23, 2026. This document
records the design contract and selected verbatim statements from that write-up;
it is not a claim that every suggested algorithm has been implemented. Current
implementation and its limits belong in [20](20-micro-generation.md).

> A region is a polyomino \(R\): a connected set of cells, potentially concave and potentially multiply connected because of holes. Decomposition is an assignment problem over subsets of \(R\), not necessarily a geometric “make everything convex” operation.

> The individual region type owns the strategy. The SDK supplies the machinery.

> the SDK knows geometry and mechanics; the region strategy knows intent

## Representation and ownership

A region is represented by its cells and four-neighbor adjacency graph. Its
boundary, including hole boundaries, is derived information. Analyses inform
decisions; they do not dictate a universal partition. Holes, loops, branches and
noncompact footprints can be desirable for a particular consumer.

`RegionContext` holds original ownership, immutable macro constraints, entrances,
neighbor information, reservations, required cells, annotations and cached analyses.
`DecompositionState` supports cheap hypothetical claims, distinguishing unassigned,
reserved, assigned and forbidden ground. A plan records pieces, generator
assignments, residual components, interfaces, scores and rationale. Child pieces
can become contexts using the same vocabulary; hierarchy need not use one cut type.

Pieces have semantic roles, preferred generators, required capabilities and tags,
as well as footprints. A generator provides a hard feasibility predicate and a
soft utility function. Registries allow one region strategy to borrow another
region type's compatible generators. Hard constraints must not be traded away for
a better score; preferences are policy rather than correctness conditions.

## Four cooperating layers

1. **Analysis:** components, holes/boundaries, distances, local thickness, skeletons,
   bottlenecks, maximal rectangles, monotonicity, visibility, morphology and paths.
   Expensive analyses should be lazy and reusable.
2. **Candidate construction:** rectangles, neck cuts and lobes, rings, corridors,
   templates, grown regions, watershed and seed partitions can coexist. Generators
   may propose their own footprints. Generic predicates and cost-driven growth
   avoid an ever-growing list of special-case algorithms.
3. **Measurements and policy:** features describe geometry; the strategy decides
   their value. Compactness is generator-relative, not a universal aesthetic.
4. **Search/allocation:** compatible candidates compete for cells. Greedy selection,
   beam search, backtracking, repair and other approaches share the same state and
   scoring tools. Optimality is not required, but search limits must be explicit.

These are the intended library families, not a checklist already delivered.

## Residuals, cuts and interfaces

> Treat the residual as another allocation.

Residual quality includes component count, component size, tendrils, narrowness
and useful access. Lower coverage can win when its remainder is more usable.
No cells disappear when a proposal is rejected or a separator is considered.

Cuts are inspectable proposals: affected cells/edges, orientation, length, local
width, resulting component sizes and interface characteristics. A strategy can
prefer a short balanced neck cut to a long cut across broad ground.

Interfaces are shared boundary runs with contact length, coherence, fragmentation,
local thickness and possible portals. They can carry semantic requirements while
deferring the exact doorway. A shared boundary is not automatically traversable;
downstream generators must negotiate and physically realize the transition.

## Boundary reachability contract (September 24)

The user clarified:

> There is a broad requirement within regions that external segment requirements that are passable are all reachable from within the region. That way each level can reason about the connectivity and reachability of things, without explicit knowledge of the internal makeup of a region.

> The passable requirement enforcement, if there is any, would have to be a post (sub)-region generation validation step, so that the generators are very free to construct their internals.

Segments communicate macro obligations, locations and inter-child obligations in
the same vocabulary. Each region must connect all required passable crossings
internally for their applicable body classes. Generators may arrange their
interiors freely; helper routes or reservations are optional construction aids,
not the definition of correctness. Validate the final emitted geometry after
each child and again at the containing region's boundary. Do not accept saved
routes or a connected cell graph as a substitute for physical reachability.

The SDK should support inheritance, paired interfaces and repeatable validation.
Failed contracts must be diagnosed, never silently weakened or repaired by a
validator. Special traversal policies such as keys and breakable barriers remain
separate choices; current static validation assumes unlocked doors can open.

## Scale and diagnostics

The accepted scale is roughly a two-cell doorway, contestant diameter between one
and 1.5 cells, and hunter diameter between 1.5 and two cells. A 1.5-cell aperture
should distinguish the roles. Grid measurements alone do not prove body clearance.

Show candidate rejection reasons, selected fitness components, residual costs,
cuts, assignments and topology. A visualization should make alternatives and
their consequences inspectable, rather than presenting only a final colored map.

## First concrete strategy

The initial example offers maximal rectangles to a rectangular-room consumer,
an intact hole-bearing footprint to a courtyard consumer, lobes and grown neck
connectors to compatible consumers, and connected remainders to a generic utility
consumer. A bounded allocator compares the claims using explicit policy weights.
This is an example strategy for exercising the SDK, not the universal decomposer
or a finalized castle, cave, market or apartment generator.

Physical population of selected pieces, portal negotiation and automatic recursive
dispatch have separate implementation boundaries. The lab now offers bounded
structural tree exploration, and the combined demo has an explicit physical
realization policy; neither is a general recursive generator dispatcher. See 20.
Integration with the sibling macro project
remains deferred under the user's instruction in [17](17-open-questions.md).
