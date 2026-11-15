# First Foundation Pass Retrospective (`#914`)

**Window:** `2026-11-09` (`#915`, `399ec90` right after `1e3d5cd`) → `2026-11-14` (`#1108`, `fda295f`)  
**Prerequisite charter PR:** `#875` (`e59dc81`, `2026-11-07`) established [33.1](../../33.1-foundation-pass.md), [17.6](../../17.6-foundation-pass.md), and `docs/archive/`.  
**Repository state at `fda295f`:** Clean `main` (`fda295f`), Forgejo CI `run 1052` green on both `ci / verify` and `ci / slow`, **0** open PRs, **0** open `"Foundation Pass:"` work issues. *(Closeout follow-on: `#948`/`#949` combined schema-18 physics recapture submitted in PR `#1109`, and final `npm run test:times` + `31.1` / `33.1.1` / `41` closeout submitted alongside archiving this retrospective.)*

---

## 1. Executive Summary & By-the-Numbers Scorecard

The first Foundation Pass ran for five days as a structured, freeze-backed cleanup across code, architecture, tests, developer tools, documentation, and onboarding entry points. The core hypothesis held up: **running a dedicated stocktake before surface sweeps, separating mechanical cleanup from judgment-class reworks, and gating Phases 0 → 1 → 2 → 3 removed huge amounts of parallel-reality drag without destabilizing behavior.**

| Metric | Value / Change (`1e3d5cd` → `fda295f`) |
| --- | --- |
| Total merges on `main` | **82 PRs** (`40` `claudecode/`, `25` `antigravity/`, `17` `codex/`), **150** non-merge commits, **0 reverts** |
| Daily merge cadence | Nov 9: `4` · Nov 10: `18` · Nov 11: `11` · Nov 12: `17` · Nov 13: `21` · Nov 14: `11` |
| Repo diff (`1e3d5cd..fda295f`) | `679` files changed, `+22,754` / `−89,971` (**−67,217 net lines**) |
| Prep/Phase 0 + Stocktake (`#915`–`#950`) | `21` PRs · `289` files · `+4,012` / `−77,229` |
| Phase 1 Sweeps + Follow-ups (`#951`–`#1069`) | `49` PRs · `471` files · `+15,222` / `−12,014` |
| Phase 2 & 3 + Reworks (`#1070`–`#1108`) | `12` PRs · `187` files · `+4,115` / `−1,323` |
| Agent instructions (`AGENTS.md`, root + macro) | `188` lines → **154 lines** (`99` root + `55` `map/macro/AGENTS.md`) |
| `docs/00-index.md` | `188` lines → **139 lines** |
| Active `docs/**/*.md` (excl. `docs/archive/`) | `192` files (`33,489` lines) → **185 files (`32,273` lines)** (`213` total / `35,111` incl. archive) |
| `docs/41-roadmap.md` | `465` lines → **35 lines** |
| Root `README.md` | `184` lines → **88 lines** (+ `README.controls.md` `52`, `README.authoring.md` `63`, `README.forking.md` `97`; `map/macro/README.md` `41`) |
| Code outside tests | `~58,000` lines → **406 files (`57,502` lines)** |
| Tests | `324` files (`~46,400` lines) → **375 files (`46,855` lines)** |

**Test runtime trend:** Root fast tier dropped from `127.4 s` wall / `453.4 s` serial (`#916`, `2915025`) → `111.0 s` wall / `377.7 s` serial (`#1058`, `bf6f8d0`) → `~90.9–101 s` wall after `#1080` relocated `~58 s` serial of map-building/whole-match cases out of fast (`100.2 s` on `#1108`, `test:mapgen` `59.3 s`). An exclusive-lock `npm run test:times` run at `fda295f` measured **963 s total serial across 297 unit files** (fast and slow, zero files over budget, zero contention; down from `1,119.6 s` serial across 289 files at `#916` and `1,052.9 s` at `#1058`). Targeted fast tests were sped up dramatically (e.g., `loot-tiers` `10.0 s → 1.1 s`, `view-items` `11.8 s → 3.1 s`, `navigation-knowledge` `10.7 s → 1.1 s`), and `placeables.browser.mts` (`3.2 s`) was isolated from the `348 s` art-witness/Lab script.

---

## 2. Major Wins

1. **Retiring "parallel realities" in Phase 0 (`#917`, `#920`–`#929`) gave every later phase a clean target.**
   - Freezing live Rapier behavior in `behavior-physics-1.v8.gz` (`#938`) and removing P2–P8 stage sets (`#921`), the legacy mover, `seat-1`, legacy street generator (`#920`), custom solver (`#925`), static-barrier/curtain/order/planner experiments (`#923`–`#929`), and un-unified library modes (`#922`) cut **73,217 net lines before Phase 1 sweeps began**.
   - Without `#917` first, every Phase 1 sweep would have spent tokens polishing dead branches.

2. **Subsystem contracts and boundaries are measurably clearer.**
   - **Single simulation & wire reality:** Required Rapier and L0 fields everywhere (`#954`/`#976` PRs `#968`/`#980`), put waiting-yard prediction onto Rapier and deleted `movePlayer` (`#975` PR `#996`), split `phased.ts` cleanly into `game.ts`/`tick.ts` (`#977` PR `#990`) and `bots.ts` into `bots.ts`/`bot-routes.ts` (`#978` PR `#981`), and unified all WebSocket + HTTP message validation in `shared/protocol.ts` (`WIRE_VERSION = 2`, `#957` PR `#991`).
   - **Client/server/map decoupling:** Split `public/client.js` (`886 → 417` lines, `#955` PRs `#992`/`#993`) and `public/arena-scene.js` (`1,077 → 370` lines + 3 modules, `#956` PR `#969`); moved tile-grid routing out of `shared/` to `map/tools/` (`#984` PR `#997`); retired the diamond fallback map (`#985` PR `#998`); decoupled `wfc.ts` from `chain/` (`#1004` PR `#1008`); enforced strict `decodeChainMap` validation (`#1005` PR `#1007`); curated `map/micro/sdk.ts` (`#1011` PR `#1024`); extracted pure region brief validation (`#1076` PR `#1084`), host-owned `room-service.metrics()` (`#1077` PR `#1083`), and `shared/playable-area.ts` + macro library/params APIs (`#1082` PR `#1108`).

3. **Investigation-first optimization (`#1060`) caught real wins and prevented speculative over-engineering.**
   - Declining `#900` (demand-loaded static AABB complexity for `~0.48 ms` solver cost), `#904` (BSON without paired win), `#549`, and `#732` preserved optionality.
   - Pursuing `#908` + `#1086` cut `swept.ts` index cost (tick 601 `78.6–88.5 → 15.6–21.6 ms`) and `36x18` tick-1 pickups (`16.87–17.52 → 5.61–9.54 ms`).
   - Adopting `#901` (`PR #1090`, schema `17` delta-frame NDJSON) turned out to be a **playback correctness fix**, not just an optimization: Chrome already crashed loading real `3,493`-frame default replays (`565 MB`, over V8's string limit), and schema `17` shrank a whole `36x18` match to `19.97 MB` (`2.98 MB` for `12x6`).

4. **Documentation, tooling, and roadmap coherence.**
   - [docs/41-roadmap.md](../../41-roadmap.md) (`465 → 35` lines) is now a pure order/tracker table, and active specs (`29.1`/`29.2`, `54*`/`20.3*`, `31`/`31.1`/`31.2`) have single owners with dated archives (`docs/archive/`) preserving provenance without polluting active context.
   - Entry points (`#1079`/`#1104`, PR `#1103`) split [README.md](../../../README.md) (`184 → 88` lines) into audience-focused guides with fresh demo media, and [33.1](../../33.1-foundation-pass.md) + `#876` (`check-doc-links.mjs`) + `#815/#871` (`machine-lock.js` + CPU times) give permanent guardrails for future work.

---

## 3. Losses, Friction & Incomplete Ends

1. **Scope expansion & queue starvation inside Phase 1 (`49` PRs).**
   - Five-decision caps produced 3–5 approved reworks per sweep (`>35` rework issues total). While `shared/` reworks (`#975`–`#979`, `#984`–`#988`) filled the agent slots for two days (`2026-11-10` → `2026-11-12`), the seven other sweeps (`#958`–`#964`) sat unclaimed, and early reworks made their unstarted sweep briefs go stale (four staleness notices had to be posted on `2026-11-12`).
   - Similarly, `#901` started as a bounded design investigation (`#1060 D3`), expanded into schema-17 implementation mid-pass (which proved right because Chrome was failing), and Phase 2's `#1072` and `#1085` each spawned extra in-pass reworks (`#1082`, `#1086`). That pushed the pass to 82 PRs over 5 days.

2. **One planned optimization didn't pay out cleanly (`#1105`), and physics recapture (`#948`/`#949`) stayed held past `fda295f`.**
   - Unconditional all-map navigation warming in `#1086` cost `~8–9 s` readiness (`10.7–14.6 s` CPU) on `36x18` without fixing tick-1 target-dependent planning, so the code was stripped back and `#1105` was deferred outside the pass.
   - `#948`/`#949` (retiring `Player.path`, `navigation: 'tiles'`, `replanning: 'sliced'`, `GameMap.{modules,nodes,routes,streets}`, `physics.{settings,profile,world.pending}`) was held intentionally for one combined schema-18 fixture recapture rather than recapturing mid-pass (`PR #1109` opened at closeout).

3. **Closeout housekeeping deferred to the end of `fda295f`, plus open outside-pass defects.**
   - Re-running `npm run test:times` and reconciling stale slow-tier set-header totals in [docs/31.1-test-catalogue.md](../../31.1-test-catalogue.md) (`rooms` `37 s`, `macro` `33 s`, pre-`#1080`) waited until closeout (`963 s` serial across `297` files measured at `fda295f`).
   - **Open test/browser flakes outside pass:** `#1000` (`tests/browser.mjs:430` replay 4x speed race) still tripped PR runs late in the pass (`#1073`, `#1082`, `#1109`); `#1107` (spectator-welcome timeout in diagnostic copy) and `#1088` (starting `36x18` room frame drops) remain open for post-pass triage alongside `#994`, `#995`, `#1031`–`#1038`, `#1041`–`#1042`.

4. **Sweep execution mechanics that tripped early agents.**
   - **Regex vs. semantic deadness:** In `#958`, a reader's regex scan flagged imports used via object spread; 9 removals had to be restored after test failure. In `#959`, spot-checking caught two false `"verified"` reader claims.
   - **Lost or premature closures:** Early sweep PRs (`#920` stage 2b closing on `#944`; `#959` needing `"Refs"`) auto-closed parent issues via `"Fixes #N"` while decisions still waited. Early `"later"` / `"for the steward"` notes left only in `#914` comments risked disappearing (`#953`'s orphan palette hand-on to closed `#581`, recovered as `#1040`; `#973`'s comment `12356`, fixed by filing `#984`–`#987`).
   - **Authority ambiguity resolved mid-flight (`review 763` on `#983`):** File-local deduplication and new shared exports looked like unilateral abstraction merges to the reviewer, forcing a rework (`#988`) and a rule update (`#914` `"What a sweep may change on its own"`).
   - **Late arrival of timing isolation:** `#815`/`#871` (machine lock + CPU timing) merged at `bf6f8d0` (end of Phase 1), *after* `#916`'s baseline rather than in Phase 0.

---

## 4. How the Workflow Went

- **The Pilot (`#918`) was high-ROI.** Running one surface sweep first exposed five real ambiguities (`tests/sets.mjs` test ownership, splitting `>~5k`-line surfaces between lead + readers upfront, evidence on hand-offs, pre-existing red browser rule, and recording defects outside pass) *before* seven Phase 1 sweeps fanned out.
- **Cross-model review (`#885` diff-only + different model family) worked exceptionally well.** Across 82 merges, there were **0 reverts**. Diff-only review (`34`) avoided burning 10+ minutes re-running green suites per PR while catching substantive gaps:
  - Scope/policy boundaries (`#938` test routing, `#983` review `763`, `#1085` review `824` closing `#842`).
  - Correctness & contract edge cases (`#968` review `756` post-dispose throw, `#1007` review `784` validating packed fields *before* coercion, `#1025` review `792` demanding 430-map size coverage & fixture provenance, `#1046` review `803` preserving transit/charger intent, `#1103` review `829` catching a nonexistent Spectate UI button and CLI precondition omissions).
- **Single-ledger stewarding scaled across three agent families (`40` / `25` / `17` PRs).** Once `#914` locked body edits to the steward while work sessions appended 1-line comments and filed every open item on an issue, parallel PR collisions stayed low (`#993`/`#985` rebases were routine).
- **Human decision throughput was the healthy bottleneck.** Capping decisions at `≤5` per sweep let Corey review and unblock entire subsystems in short single-comment turns (`#917`, `#918`, `#972`, `#973`, `#958`–`#960`, `#962`–`#964`, `#1058`–`#1060`, `#901`, `#1082`).
- **Two tooling friction points to note:**
  1. Forgejo MCP cannot unassign `corey` programmatically, requiring manual unassignment or `"assignee left due to MCP limit; claim anyway"` steward notes (`#1082`).
  2. Merging a PR while `ci / verify` is still running triggers `cancel-closed-pr.yml`, which marks the closed PR's latest check status as `failure` (`#1106`, `#1108`, `#1085`) even when `main` push CI passes immediately afterward.

---

## 5. How to Improve the Next Foundation Pass

These lessons are distilled operationally into [33.1.1](../../33.1.1-running-a-pass.md):

1. **Put `machine-lock` + timing/link backstops in Phase 0.** Run the Phase 0 inventory, link check, *and* exclusive-lock `test:times` baseline on Day 1 so every Phase 1/2 sweep compares apples-to-apples CPU/wall times from the start.
2. **Enforce semantic/build verification over grep in reader subagents.** Never delete imports/exports from regex alone (`#958`); run `tsc` / module execution on any `"unused"` list, and spot-check reader `"verified"` assertions as standard lead checklist (`#959`).
3. **Standardize issue hygiene from PR #1:**
   - Sweep PRs use **`Refs #N`**, never `Fixes #N`, until all D1–D5 decisions are filed or declined.
   - No orphan notes: every handed-on item, recorded defect, or deferred choice is posted on an open issue before the session stops.
   - Every new helper or shared export is treated as a judgment-class decision (`#983` review `763`), not unilateral cleanup.
4. **Prevent Phase 1 sweep starvation and staleness.** When Phase 1 opens in parallel, avoid letting one subsystem's follow-up reworks starve unstarted sweeps (`#958`–`#964`), or batch docs sweeps alongside early reworks so shared `AGENTS`/`31`/`53` references don't drift mid-flight. Schedule a quick steward staleness check whenever >5 reworks land before remaining sweeps start.
5. **Fix/isolate known timing flakes before heavy browser passes, and bundle schema/fixture recapture explicitly.** Treat pre-existing flakes on core regression gates (`#1000` style) as blocking defects if they touch multi-PR acceptance; decide upfront at pass kickoff whether the closing recapture batch (`#949` pattern) closes *inside* the pass before closure declaration or is explicitly deferred out of pass.
6. **Keep what already proved gold:** feature freeze (`33.1`), Day-1 stocktake (`#917`), single pilot (`#918`), `≤5` ranked decisions per sweep, upfront `>~5k`-line lead/reader split naming exact `tests/sets.mjs` ownership, diff-only cross-model review (`#885`/`34`), and dated `docs/archive/<YYYY-MM-DD>-<topic>/` preserves provenance.
