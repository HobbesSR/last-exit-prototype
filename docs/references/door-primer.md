> **Reference material; it creates no requirements** ([33](../33-maintenance.md#where-a-fact-belongs)). A decision
> that draws on it is recorded in its owning numbered document, with its own evidence, and cites this file. Added
> 2026-11-16 verbatim from `DOOR_Combined_Primer_and_Agent_Guidance.md`; only this note was added. Corey, 2026-11-16,
> verbatim: "The document itself has absolutely no bearing on the project requirements. It has many worth while
> considerations. And I'd like to take opportunities to morph towards its prescriptions iteratively and slowly, where
> we can justify it."

# DOOR Architecture — Primer

**Project:** Last Exit  
**Audience:** Implementation agents and engineers  
**Status:** Design direction, not a mandated framework specification

## Purpose

**DOOR** is a pragmatic architectural approach that uses **data-oriented**, **object-oriented**, and **relational** programming as complementary tools within one runtime. It does not claim these techniques are novel, require three tiers in every feature, or prescribe a universal dispatch mechanism. Its central aim is to put different kinds of work in representations that suit them, and to connect those representations without sacrificing clarity or performance.

**Prime directive:** Apply DOOR where it is useful. Do not force a feature to demonstrate every paradigm. The right outcome is maintainable, correct, performant game code—not adherence to a diagram.

## Three complementary perspectives

### Data-oriented / ECS: transform state efficiently

Entity Component Systems and related data-oriented techniques fit repeated, predictable, collection-oriented work: movement, projectiles, spatial updates, collision processing, animation state progression, visibility calculations, and other hot inner loops. Prefer contiguous or locality-friendly representations when profiling or access patterns justify them. Select iteration order and component layout according to actual workloads.

ECS is not a universal substitute for domain behavior. An event need not be translated into a large entity scan merely to preserve an ECS aesthetic.

### Relational: describe and operate on associations

Relationships may include owner-of, contains, controls, belongs-to, targets, occupies, and depends-on. Some relations live in explicit tables or indexes; others are inherent in component membership, aligned arrays, stable identifiers, or adjacency structures. The representation may change with query frequency, cardinality, mutability, and consistency requirements.

Relational thinking is broader than a database or SQL engine. It means treating associations and set-based operations as explicit design concerns and choosing efficient physical forms. A synchronized index can encode a relationship without performing a runtime join.

### Object-oriented / eventful behavior: coordinate meaningful interactions

Object-oriented interfaces and event-driven behavior are often useful for lifecycle, interaction rules, exceptional cases, policies, and cross-system orchestration: a player uses a device; a secured door evaluates access; an encounter advances; a contest controller handles a knockout. Encapsulate cohesive behavior and preserve comprehensible causal paths.

Objects need not own all state they reference. They may read constrained views of simulation state and request changes through explicit interfaces. Conversely, direct methods and straightforward callbacks are acceptable when they are clear and safe.

## A spectrum, not three isolated territories

The architectural distinction is about **workload and responsibility**, not immutable ownership. Object methods may perform calculations; ECS systems may consume events; relations may perform substantial computations. A single feature may involve all three, two, or just one.

DOOR is not a rule that every object emits a command, every command enters a table, and every mutation waits for a bulk ECS pass. Those mechanisms are options for situations where they solve real coordination, ordering, or batching problems.

## Illustrative flow, not a mandatory pipeline

In a complex interaction, the runtime may:

1. Observe an input or external system occurrence.
2. Admit it as an input/request into simulation logic.
3. Evaluate domain behavior or policy.
4. Resolve associations among affected entities.
5. Apply changes via direct targeted operations, grouped commands, or ECS systems as appropriate.
6. Produce *model events* describing committed transitions.
7. Let presentation, audio, networking, and follow-on behavior react in an appropriately ordered way.

This can happen in one call chain, across phases in a tick, or over multiple bounded rounds. The shape is chosen for determinism, correctness, simplicity, and measured performance.

## System events versus model events

Distinguish **external/runtime occurrences** from **simulation facts**:

- **System events** arrive from outside the simulation's authoritative transition logic: input devices, networking, OS messages, timers, and peripheral completions. Buffer, normalize, timestamp, or admit them as needed.
- **Model events** report results of state transitions in the simulated world: `DoorUnlocked`, `DamageApplied`, `CharacterDied`, or `ItemTransferred`. When reproducibility is important, derive them from deterministic simulation state and admitted inputs.

Avoid hidden dependencies in unrestricted observer cascades. The more important the causal order, the more explicit the boundary should be. Presentation side effects should not silently become authoritative gameplay changes.

## Example: secured door in Last Exit

A door may have component data for transform, collision, animation, and lock state. It may relate to a security controller and a credential or faction policy. A player interaction can be interpreted by cohesive behavior code; relevant ownership and authorization relations are resolved; the lock state is changed through the simplest safe authoritative path; animation and collision processing read the resulting state; and a `DoorUnlocked` model event can inform an alarm or encounter controller.

A door used in a handful of scripted locations may need only direct methods and components. A world with thousands of active doors or many simultaneous actions may benefit from indexed relations or batched commands. Both can be DOOR-aligned.

## Architectural qualities to seek

- **Correctness and state ownership:** Invariants are explicit; readers do not accidentally race with or bypass authoritative writers.
- **Data access efficiency:** Hot paths preserve locality and avoid avoidable allocation, lookup, or per-entity dispatch.
- **Visible causality:** A developer can explain why a transition occurred and what consumes its result.
- **Appropriate relationship representation:** No expensive generalized join where a cheap stable mapping works; no fragile duplicated mapping where a real relation is needed.
- **Determinism where valuable:** Simulation phases, input admission, and event ordering support reproducibility or replay as required.
- **Modularity without ceremony:** Contracts isolate meaningful responsibilities, not every line of code.
- **Testability and evolution:** Domain behavior and state transformations can be checked independently where practical.

## Non-goals and cautions

DOOR is **not** a new language or paradigm, a requirement for database infrastructure, a universal event bus, a rigid OO/ECS boundary, or a ban on immediate mutations. It does not justify gratuitous copies between object graphs and ECS storage, proliferating command types for trivial operations, or adding transactional machinery without relevant invariants.

Claims of performance improvement require evidence. Claims of modularity improvement should be supported by simpler dependencies or clearer tests, not architectural vocabulary alone.

## The governing question

**What is the simplest representation and execution path for this responsibility, given its access pattern, relationships, causal requirements, and expected evolution?**

That question—not obedience to a predefined pipeline—is DOOR's operational philosophy.

---

# DOOR — Agent Implementation Guidance

**Companion to:** `DOOR_Architecture_Primer.md`  
**Purpose:** Give coding agents discretion to recognize useful opportunities for DOOR in Last Exit without turning it into a mandatory framework.

## Standing instruction

Use the DOOR primer as **architectural guidance**, not a compliance checklist. Inspect the existing implementation, identify the actual problem, and choose appropriate data-oriented, relational, and/or object-oriented techniques. Not every feature needs every paradigm. Prefer small, local, evidence-based changes over sweeping rewrites. Preserve observable behavior unless the task explicitly asks to change it.

## When considering a change

1. **Identify the work.** Is it a repeated hot loop, a relationship/query problem, eventful coordination, or a straightforward localized operation? A feature may contain several of these.
2. **Locate existing authority.** Which subsystem owns the state and its invariants? What interfaces already exist? Avoid competing authoritative copies.
3. **Trace data access and causality.** What information is read, mutated, observed, and emitted? Does sequence matter? Are operations immediate, deferred, or frame-bound?
4. **Select the simplest fitting mechanism.** Direct function call, object method, indexed relation, ECS pass, queued command, batched operation, or explicit phase boundary. Do not pick an elaborate option by default.
5. **Preserve useful boundaries.** Avoid unpredictable side effects, hidden cycles, and dependencies that thwart testing or make hot loops opaque.
6. **Verify the result.** Test correctness and ordering; benchmark only where there is a meaningful performance claim or regression risk.

## Heuristics for choosing techniques

| Symptom or requirement | Techniques worth considering | Avoid by default |
|---|---|---|
| Large numbers of entities undergo similar transforms | ECS/data-oriented passes, cache-friendly component layout, batching | Virtual dispatch and allocation in a measured hot loop |
| Frequent lookups across entities or groups | Explicit relation tables, indexes, adjacency maps, component membership, stable aligned indices | Repeated full scans or materialized joins without justification |
| Complex interaction or lifecycle rules | Cohesive behavior objects, explicit domain methods, small state machines | Scattering policy across unrelated generic ECS passes |
| Cross-system mutation with ordering/invariants | Typed intents/commands, controlled writer, phase barriers, transactional coordination when needed | Unbounded callback recursion, arbitrary state writes |
| Simple infrequent local mutation | Direct method or narrow write API | Mandatory command bus and event journal |
| Replay/determinism is important | Ordered input admission, deterministic transformations, model-event records, controlled side effects | UI/network callbacks that mutate authoritative state unpredictably |

These are prompts for judgment, not fixed mappings.

## Optional mechanisms already explored for DOOR

The design discussion has considered a **relational backbone**, **typed ephemeral command tables**, **phased command application**, **state-transition/model-event tables**, and **multiple bounded rounds within a tick**. These are useful *candidate mechanisms*, not automatically required components.

A possible pattern is: eventful behavior reads constrained state views → emits typed mutation intents → systems resolve relevant entity associations → an authoritative phase validates/orders/coalesces and applies changes → transition facts become model events for subsequent behavior. Use it when this improves batching, determinism, integrity, or visibility. Simpler direct flows may be preferable.

**Dependency boundaries matter:** Some work genuinely depends on earlier results (movement → collision → damage → death). Maintain appropriate sequence. Parallelize only nonconflicting work and never imply that all systems can run independently.

**Immediate-result cases are real:** Some interactions need an answer before control can proceed. Do not awkwardly defer them merely to fit a queue. Possible designs include a direct authoritative operation, a query plus committed follow-up, or a carefully scoped commit/abort protocol. The choice depends on the invariant and caller semantics.

**Bound cascades:** If model events generate additional commands within a tick, cap rounds or work and explicitly define what crosses into the next tick. Avoid accidental infinite feedback loops.

## Concrete feature example: projectile impact

A high-volume projectile update belongs naturally in a data-oriented pass. Collision data resolves which target was hit; ownership/faction relations determine attribution and rules; an authoritative damage operation changes health; a committed `DamageApplied` or `CharacterDied` model event triggers scoring, encounter behavior, presentation, or network publication. The degree of command buffering depends on volume, concurrency, phase ordering, and the need for auditability. Don't promote every projectile to a heavyweight behavioral object solely to support event handling.

## What to tell the implementer in code review

For architectural changes, explain succinctly:

- **Problem solved:** What access pattern, invariant, coupling, or event ordering motivated the change?
- **Why this technique:** Why an ECS pass, relation, object, direct call, or queue is the better fit here?
- **Authority and timing:** Where does the authoritative state live, and when does mutation become visible?
- **Validation:** What tests, traces, or measurements support the result?

A small feature may need only a sentence or two. Do not manufacture extensive architectural documentation for routine edits.

## Red flags

- Adding a universal bus, ORM, transaction manager, or ECS abstraction before a demonstrated need.
- Rewriting well-functioning OO code into ECS solely for ideological consistency, or the reverse.
- Hiding entity scans behind relational terminology.
- Keeping two mutable authoritative copies of the same state without reconciliation rules.
- Broadcasting events before a transition has actually committed.
- Turning model events into uncontrolled recursive writes.
- Claiming locality, throughput, or determinism gains without checking them.

## Agent decision rule

**When a DOOR-inspired change adds more coordination cost than it removes, don't make it.**

Prefer incremental implementation, preserve the codebase's prevailing conventions unless they cause real problems, and use discretion. Flag architectural ambiguity only when it affects correctness or a significant long-term decision. Otherwise make a defensible local choice and proceed.

## Status and uncertainty

The primer expresses intended architectural principles. Specific mechanics—such as precise table schemas, flush rules, transaction boundaries, reentrant event semantics, and the number of simulation phases—remain implementation decisions unless established by current project code or explicit future requirements. Do **not** treat the examples in these documents as assertions about already-implemented Last Exit features.
