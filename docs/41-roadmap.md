# 41. Roadmap

The order *between* efforts and the reason for each: one line per effort, with the
Forgejo tracker that owns it. Sequencing inside an effort, and the state of every
issue, live on its tracker ([33](33-maintenance.md#where-a-fact-belongs)). Accepted
features and their status are in [13](13-accepted-features.md), deferred work in
[16](16-deferred.md), and the policy answers that shape later efforts in
[17](17-open-questions.md).

The roadmap before 2026-11-13, with the finished efforts' narratives and the retired
plans 41.1–41.3, is in [the plan history](archive/2026-11-13-plan-history/README.md).

## Order

Gameplay and content advance in light iterations alongside system hardening, prioritizing gameplay elements that stress the systems being hardened (#1053).

| Rank | Effort | Outcome | Reason for position | Tracker |
| --- | --- | --- | --- | --- |
| 1 (Now) | Rust foundations | The network edge in Rust as a full conversion (WebTransport, then the WebSocket), and a Rust core compiled to one WASM binary for Node and the browser that absorbs the simulation behind an adapter; `map/` stays in Node ([27](27-rust-path.md), [17.4](17.4-live-service.md) #18) | Corey, 2026-11-17: the target will not be more stable than under the freeze, and changes belong in their real home; the feature freeze continues while the core is reworked | #1173 (#1174, #1095, #1175, #1066) |
| 1 (Now) | Room isolation and startup | Single-room lifecycle interface, one room per worker thread, and pre-tick physics/recorder readiness ([22.3](22.3-server.md), [17.4](17.4-live-service.md) #13) | Establishes the room host seam needed by netcode and hosting, and eliminates cross-room startup stalls before gameplay work builds on top | #1078, #1089, #1087, #1088 |
| 2 (Parallel) | Netcode alpha core and publication contracts | Binary quantized encoding and lossy-transport state deltas, parallel `#1096` input-timing evaluation, and viewer-publication/access/archive design (`#1098`, `#1074`, `#1123`) ([17.4](17.4-live-service.md) #14/#16, [24](24-networking-privacy.md#two-tier-spectators), [26](26-recording-contract.md#proposed-viewer-publication)) | Sets the alpha wire contract after `#1078` while settling viewer projection, access, delay and failure boundaries before `#1093`/`#1094` and `#1095` lock them out. Implementing deltas and datagrams (`#1094`, `#1095` stage 2) waits on where the projection lives, Node or the Rust core ([27](27-rust-path.md)): Corey decides it after `#1175` stage 2's adapter measurement, with `#1066` | #1092 (#1093, #1094, #1096, #1098), #1074, #1123 |
| 2 (Parallel) | Development and appearance tools | One pure core per domain with lab, CLI and MCP faces ([22.8](22.8-development-tools.md)) | Low-conflict multiplier that accelerates art, renderer and map work without touching server/netcode seams | #772 |
| 3 | Renderer bake/batch and SVG pipeline | Bake per-frame Phaser shapes into textures and design declarative SVG/op content ([29.4](29.4-drawing.md)) | Measures and fixes per-frame draw overhead before expanding authored art or choosing a renderer checkpoint | #1099, #841 |
| 4 (Light iterations; frozen during #1173) | Gameplay, equipment and spatial reward/danger | Rebalance equipment, tiers, gunfire cues and traps; opening-based sight and physics/network stress ([13](13-accepted-features.md) F-12/F-15–F-18, [14](14-match-rules.md), [29.1](29.1-physics-design.md), [17.3](17.3-product-gameplay.md) Q2–Q4) | Core product goal, iterated lightly alongside hardening systems with priority on mechanics that stress them | #436, #443, #444, #825; per [13](13-accepted-features.md) |
| 5 | Map connectivity and authorship | Connectivity skeleton guarantees, gladiator corridor check and builder perimeter/coordinate follow-ups ([17.2.11](17.2.11-navigation-structure-direction.md), [42.42](42.42-connectivity-skeleton-experiment.md)) | Informed by playtest feedback on sparse layouts and accelerated once `#772` preview tools are ready | #910, #913, #1012, #1015 |
| 6 | World and art grammar follow-ups | Expand block landmarks, appearance presets and lighting defaults ([11.1](11.1-world-and-art-direction.md), [29.4](29.4-drawing.md)) | Builds cleanly once renderer batching (`#1099`), SVG/declarative ops (`#841`) and appearance tools (`#772`) land | #581, #877, #1013, #1035, #1036 |
| 7 (Later) | Live service, transport, renderer checkpoint and replay memory | Hosting/session compatibility ([28](28-operational-limits.md#before-public-deployment)), anti-cheat implementation, WebTransport's datagram stages after the edge's stage 1 ([24.5](24.5-transport.md); stage 1 is #1095 under #1173), archive split and downstream delayed spectator consumer ([28.1](28.1-deployment-topology.md)), Phaser/Pixi checkpoint, and on-demand arbitrary-seek replay rebuilds ([26](26-recording-contract.md)) | Waits on `#1078`/`#1089`, `#1093`/`#1094`, publication contracts and `#1099` measurements, or only binds at public scale and `72x36` matches | #907, #1074, #1092 (#1097, #1098), #1100, #1102, #1123 |

## Parked

- **Destructible environment (`#794`):** geometry-changing destruction waits on Corey's design ([17.3](17.3-product-gameplay.md) #25).
- **Multi-floor collision planes (`#1075`):** overlapping floors and ramps wait on transition, navigation and sight design ([16](16-deferred.md), [17.3](17.3-product-gameplay.md) #6).
- **Deformable bodies and squish (`#455`):** lab prototype stays isolated until damage, teammate and visual rules are decided ([17.3](17.3-product-gameplay.md) #18).
- **Non-rectangular building footprints (`#860`):** L/U/T wings wait on authorship direction ([17.2.11](17.2.11-navigation-structure-direction.md)).
- **Navigation warming breadth (`#1105`):** amortized contestant tile warming waits until after `#1087` and `#1089` are measured.
- **Waiting-yard emotes (`#265`, `#268`):** social polish parked behind core loop and system hardening.
