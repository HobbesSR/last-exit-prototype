# 41. Roadmap

The order *between* efforts and the reason for each: one line per effort, with the
Forgejo tracker that owns it. Sequencing inside an effort, and the state of every
issue, live on its tracker ([33](33-maintenance.md#where-a-fact-belongs)). Accepted
features and their status are in [13](13-accepted-features.md), deferred work in
[16](16-deferred.md), and the policy answers that shape later efforts in
[17](17-open-questions.md).

The roadmap before 2026-11-13, with the finished efforts' narratives and the retired
plans 41.1–41.3, is in [the plan history](archive/2026-11-13-plan-history/README.md).
The netcode alpha core (#1092) closed on 2026-11-19. Its remaining transport work moved under #1173, and its later
items moved to rank 7 (#1092's closing comment).

## Order

Gameplay and content advance in light iterations alongside system hardening, prioritizing gameplay elements that stress the systems being hardened (#1053).

| Rank | Effort | Outcome | Reason for position | Tracker |
| --- | --- | --- | --- | --- |
| 1 (Now) | Foundation Pass (second pass) | Cross-surface cleanup, doc/instruction reduction, dead-code and leftover-adapter retirement, verification speedups, and pre-feature hardening across Rust core/edge, TypeScript, mapgen, and docs under a freeze ([33.1](33.1-foundation-pass.md), [33.1.1](33.1.1-running-a-pass.md)) | Follows the completed Rust WebTransport/WebSocket edge (`#1095`, `#1207`), WASM core and state flip (`#1175`, `#1192`, `#1210`–`#1215`, `#1219`), and governing tick rewrite (`#1279`, `#1280`–`#1284`, `#1358`) before new gameplay builds on top | #1388 (#1389; open #1173 follow-ups #1201, #1222, #1241) |
| 1 (Now) | Room hosting, worker density and memory | Configurable multi-room workers sharing compiled WASM, bounded tick/frame allocation churn, and pre-tick recorder readiness ([22.3](22.3-server.md), [28.1](28.1-deployment-topology.md)) | Reduces per-room RSS (~145 MB) and resolves 36x18 startup/frame costs before multi-room hosting scales out | #1088, #1375, #1376, #1374, #1334 |
| 2 (Parallel) | Development and appearance tools | One pure core per domain with lab, CLI and MCP faces ([22.8](22.8-development-tools.md)) | Low-conflict multiplier that accelerates art, renderer and map work without touching server/netcode seams | #772 |
| 3 | Renderer bake/batch and SVG pipeline | Bake per-frame Phaser shapes into textures and design declarative SVG/op content ([29.4](29.4-drawing.md)) | Measures and fixes per-frame draw overhead before expanding authored art or choosing a renderer checkpoint | #1099, #841 |
| 4 (Light iterations; frozen during #1388) | Gameplay, equipment and spatial reward/danger | Rebalance equipment, tiers, gunfire cues and traps; opening-based sight and physics/network stress ([13](13-accepted-features.md) F-12/F-15–F-18, [14](14-match-rules.md), [29.1](29.1-physics-design.md), [17.3](17.3-product-gameplay.md) Q2–Q4) | Core product goal, iterated lightly alongside hardening systems with priority on mechanics that stress them | #436, #443, #444, #825; per [13](13-accepted-features.md) |
| 5 | Map connectivity and authorship | Connectivity skeleton guarantees, gladiator corridor check and builder perimeter/coordinate follow-ups ([17.2.11](17.2.11-navigation-structure-direction.md), [42.42](42.42-connectivity-skeleton-experiment.md)) | Informed by playtest feedback on sparse layouts and accelerated once `#772` preview tools are ready | #910, #913, #1012, #1015 |
| 6 | World and art grammar follow-ups | Expand block landmarks, appearance presets and lighting defaults ([11.1](11.1-world-and-art-direction.md), [29.4](29.4-drawing.md)) | Builds cleanly once renderer batching (`#1099`), SVG/declarative ops (`#841`) and appearance tools (`#772`) land | #581, #877, #1013, #1035, #1036 |
| 7 (Later) | Live service, transport, renderer checkpoint and replay memory | Hosting/session compatibility ([28](28-operational-limits.md#before-public-deployment)), the anti-cheat baseline, viewer-publication/access/archive design ([17.4](17.4-live-service.md) #16, [26](26-recording-contract.md#proposed-viewer-publication)), the typed welcome/ready codec (#1171, when join latency on the deployment topology calls for it), archive split and downstream delayed spectator consumer ([28.1](28.1-deployment-topology.md)), Phaser/Pixi checkpoint, and on-demand arbitrary-seek replay rebuilds ([26](26-recording-contract.md)) | Waits on `#1099` measurements, or only binds at public scale and `72x36` matches; the room host (`#1078`/`#1089`) and the alpha wire (`#1092`) it waited on are done, and the publication design is part of this row | #907, #1074, #1097, #1098, #1171, #1100, #1102, #1123 |

## Parked

- **Destructible environment (`#794`):** geometry-changing destruction waits on Corey's design ([17.3](17.3-product-gameplay.md) #25).
- **Multi-floor collision planes (`#1075`):** overlapping floors and ramps wait on transition, navigation and sight design ([16](16-deferred.md), [17.3](17.3-product-gameplay.md) #6).
- **Deformable bodies and squish (`#455`):** lab prototype stays isolated until damage, teammate and visual rules are decided ([17.3](17.3-product-gameplay.md) #18).
- **Non-rectangular building footprints (`#860`):** L/U/T wings wait on authorship direction ([17.2.11](17.2.11-navigation-structure-direction.md)).
- **Navigation warming breadth (`#1105`):** amortized contestant tile warming waits until after `#1087` and `#1089` are measured.
- **Waiting-yard emotes (`#265`, `#268`):** social polish parked behind core loop and system hardening.
