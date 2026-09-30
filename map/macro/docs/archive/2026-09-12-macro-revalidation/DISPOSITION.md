# Revalidation ingestion

Accepted after source and test review. checkMacroRoutes is the single shared
implementation for initial composition and post-wall-edit corridor/route checks.
Cache invalidation, per-radius evaluation, blocked endpoint rejection, finite
wall checks and independent report objects match the brief.

The reported interface questions are settled for current callers: violating a
required connectivity constraint remains invalid; there is no soft-constraint
mode. Per-corridor structured results are deferred until a consumer needs them;
diagnostic strings must not be parsed for control flow.

Corey's latest direction supersedes the original brief's performance requirement.
Removed the clock import, measurement and 2-second assertion from the large-field
test. It now checks region area and corridor preservation only. Runtime targets,
route-length targets and difficulty/balance optimization are premature.

Original task/results preserved in this folder. Current validation and next
work are in the workspace-root MODEL_HANDOFF.md. Active generator and UI were
not changed, so browser and legacy seed batches were not repeated.
