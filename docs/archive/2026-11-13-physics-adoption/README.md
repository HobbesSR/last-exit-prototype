# Physics adoption text, archived 2026-11-13

**What it holds.**
- `29.1-physics-design.md` and `29.2-physics-state-networking.md` are those documents as they stood
  before 2026-11-13, verbatim apart from links retargeted to this folder. They were written while
  Rapier was an experimental direction beside the legacy mover, and they record the adoption in its
  stages: the #451 remediation gates and the native-spring lab evaluation, the engine candidates and
  their sources, the legacy sequential tick order at checkpoint `8fa07ff`, the P1 trace matrix with
  its legacy observations, the P2–P9 stage sections, the P7 ballistic lab's witness, admission bounds,
  analytic sweep and lab recording format, and the network validation profiles for prediction.

**Why it was archived.** Rapier became the only engine (#920, #976), so the stage framing described a
rollout that had finished, and repeated settled rules several times over in proposal form (#963 D2,
approved in #963 comment 13639; done in #1049).

**What supersedes it.**
- *The contracts:* [29.1](../../29.1-physics-design.md) and [29.2](../../29.2-physics-state-networking.md)
  state the current rules once, without stage framing. Tuning numbers stay in
  [14](../../14-match-rules.md), schema numbers in [26](../../26-recording-contract.md).
- *Evidence for each stage:* [42.6](../../42.6-physics-comparison.md) (P0 comparison),
  [42.9](../../42.9-physics-remediation.md) (remediation), [42.11](../../42.11-physics-p1.md)–[42.20](../../42.20-physics-p9.md)
  (P1–P9), [42.21](../../42.21-jelly-squish.md) (jelly and squish lab).
- *Engine choice and reserves:* [21](../../21-stack.md).
- *The ballistic lab:* its code, `tools/physics/ballistics.mjs`, and [42.18](../../42.18-physics-p7.md);
  the detailed witness specification is kept only in the archived 29.1 and 29.2 here.
