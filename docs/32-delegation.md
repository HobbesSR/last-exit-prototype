# 32. Delegation and model handoffs

The user requests persistent cost-aware delegation. The lead owns the plan,
cross-system reasoning, task boundaries and final verification. Workers own bounded
deliverables. Delegation should reduce total context/rework, not just elapsed time.

## Task selection

| Work | Preferred owner |
| --- | --- |
| Physics ownership, replay/content compatibility, conflicting requirements, uncertain performance causes | Lead; GPT-6.1 Sol (`gpt-6.1-sol`) preferred for deep reasoning and broad context |
| Algorithmic/spatial logic, non-trivial state machines, complex refactors within defined contracts | GPT-6.1 Sol, medium (`gpt-6.1-sol`) |
| Implement an agreed inventory gesture, extract a specified adapter, add meaningful tests for a defined contract | GPT-6.1 Terra, medium (`gpt-6.1-terra`) |
| Bounded call-site inventory, mechanical edits, documentation updates with settled facts | GPT-6 Luna, low/medium (`gpt-6-luna`) |
| Integration review and decisions affecting multiple tasks | Lead |

These are routing preferences, not guaranteed price or availability claims. Use
the current tool's actual model identifiers. Avoid copying the whole chat into a
worker; reread the necessary sources and write a small complete brief. A task that
depends on unwritten context is not ready to delegate. Do not create workers just
to demonstrate delegation, run a single short command or wait for another worker.

## Required worker brief

```text
Task and status: <one bounded outcome; ready / in progress / blocked / done>
Model and reasoning: <available model; why it fits>
Starting checkpoint: <commit; relevant dirty files; never assume a clean tree>
Objective: <observable result>
Read: <specific files/sections and established decisions>
Write ownership: <files this worker may edit; other workers' boundaries>
Invariants: <behavior/order/format/API constraints>
Non-goals: <explicit exclusions>
Acceptance: <meaningful tests/commands and expected behavior>
Escalate if: <missing product choice, contract change, invariant failure>
Return: <changed files, actual checks/results, uncertainties and remaining work>
```

Workers must preserve concurrent edits and should not make commits or launch other
agents unless assigned that responsibility. The lead inspects their changes and
validation, resolves integration, and runs shared checks once the pieces are ready.
Benchmarks must not compete with other CPU-heavy workers. A focused worker failure
is a cue to refine the brief or escalate, not to repeat an ambiguous assignment.

## Manual model switch or fresh conversation

If subagents/model overrides are unavailable, post the next task as a handoff
comment on the Forgejo issue (or its pull request), using the brief above. Include
the branch and worktree, what is complete, current dirty files, unresolved failures
and the precise next action. Add a new comment rather than editing earlier ones.
Do not tell a fresh model to infer missing decisions from the old chat.

Tell the user the recommended model and why switching is useful. Name the exact
issue or pull request where the comment was posted in the pickup prompt:

> Read AGENTS.md and the latest handoff comment on issue #N or PR #N. Implement the next ready task within its scope, run its acceptance checks, and post an updated handoff there.

For escalation back to the lead, replace "Implement" with "Review the blocked task,
resolve the cross-system decision, and prepare the next bounded implementation task."

No gameplay task is newly authorized by this workflow document. Consult current
user instructions and requirements before selecting the next deliverable.

## Persistence

Instruction loading and machine-specific setup belong to
[34](34-forgejo-workflow.md#instruction-loading). These files cannot grant
missing tool capabilities. This document owns the delegation and handoff policy.

Official references checked September 11, 2026:
- [AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Subagents and model selection](https://learn.chatgpt.com/docs/agent-configuration/subagents)
