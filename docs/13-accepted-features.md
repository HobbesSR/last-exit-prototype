# 13. Accepted features and status

The target is a substantially larger cyberpunk urban dystopian ruin with indoor and
outdoor play, hierarchical generation, equipment-driven contestants and a power-cell
extraction objective. The statuses below distinguish working prototype mechanics
from remaining visual and design work. Unit/server tests and browser checks cover
the implemented mechanics; human multiplayer balance is still unverified.

"Accepted" means the decision is made, not that the behavior exists. Read the
status column before implementing against any row.

| ID | Requirement | Acceptance evidence / limits | Status |
| --- | --- | --- | --- |
| F-01 | Generate maps hierarchically by selecting compatible tile templates controlling paths. | The bounded-region SDK provides masks, geometry/route checks, placement spreading and profile metrics; `micro-1` supports ports, geometry validation, adjacent-region composition and local entry positions with explicit shortfall. It now also analyzes connected polyomino child regions and assigns compatible generator candidates with explicit residual ownership, structural interface opportunities and bounded-search diagnostics. A bounded hierarchy explorer compares recursive allocation trees under objective presets, with exact child ownership and explicit stopping decisions. Architecture builders and previews are examples. A combined demo now realizes child assignments with paired portals and validated physical routes; generalized dispatch/negotiation, sibling adaptation, recursive execution and macro integration remain incomplete; the live street maze is still interim. See [19](19-decomposition-design.md) and [20](20-micro-generation.md). | Partial; local regions and structural decomposition |
| F-02 | Reach extraction through upper, middle, and lower areas; include dead ends and optional keyed areas. | Connected maze with loops, offset passages, optional locked buildings and size-limited shortcuts. 200 seeds verify sampled top/main/bottom route clearance and no-key navigation for both sizes. Access-point semantics remain open. | Interim prototype |
| F-03 | Find a power cell, charge it at a station, and deliver it to a pod. | Cells each occupy one ordinary slot, retain charge on drops, take five seconds to charge, and are consumed on extraction. Inventory, interruption, death/drop, charging and extraction tests pass. | Implemented |
| F-04 | Cyberpunk ruins with interiors/exteriors and a 2½D playing field. | Buildings have open/close doors, windows, and roofs that hide interiors outside and disappear inside. Flat top-down presentation remains; playable elevation and finished art are not implemented. | Partial |
| F-05 | Add motion-sensitive mines, turrets, flamethrowers, and NPC spider bots that attack anything within web range, pursue only a limited distance, and can grapple. | Tests cover mine movement triggers, turret targeting, flame warning/cone/cover, and spider grappling and leash limits against both player roles. | Implemented prototype |
| F-06 | Six weapon/item slots, finite ammunition, icons, rearrangement and compatible stack merging. No innate contestant abilities. | Six slots; pistol/rifle/scattergun with finite rounds; med/shield stacks; unstackable cells; numeric ammo/charge badges; R/touch move/merge; G/touch drop. Server validation and browser tests cover sixth-slot use and rearrangement. | Implemented prototype |
| F-07 | Support private rooms and server matchmaking with gladiator, contestant, or no role preference. | Private owner-started rooms and separate server matchmaking. Tests cover all preferences, fallback, automatic start, and refresh recovery. No internet deployment or account service. | Implemented on one server |
| F-08 | Allow exploration within an approximately ten-minute wall deadline. | Revised 24,000 x 12,000 maze; 600-second limit, 60-second wall grace, five-second charging. Main-route travel targets roughly four to five minutes; generation penalizes late westward backtracking and tests include exploration pauses. Human balance still needs playtesting. | Revised initial tuning |
| F-09 | Remove the circular visibility boundary and use the full play-area viewport. Static map elements remain visible; obstacles still conceal dynamic entities. | Viewport coverage tests include portrait, desktop and ultrawide sizes; browser test renders an actor beyond the former 620-unit cutoff while preserving wall occlusion. Camera coverage is bounded on huge displays. | Implemented |
| F-10 | Preserve the last-known state of changeable map elements such as doors when out of sight. Extend this principle to future dynamic terrain. | Gate memory tests cover unseen changes and observation refresh. Unseen gates are muted; unknown gates are shown closed with an uncertainty marker. Dynamic terrain remains future work. | Implemented for gates |
| F-11 | Three hunters/gladiators per default match. | `content-2` spawns Warden, Specter and Striker hunters. Admission, lobby capacities and matchmaking fractions count that roster; tests cover the third claim, full-role fallback and eleven-player capacity. Frozen traces still exercise two-hunter `content-1`. | Implemented |
| F-12 | Weapons have quality tiers; better tiers become more likely farther toward the top/bottom and farther right. | Define tier statistics and a seeded spatial loot distribution. Verify distribution across many seeds rather than requiring every individual pickup to improve monotonically. | Accepted; not implemented |
| F-13 | Weapons support drag-and-drop slot swapping and dropping into the world. | Mouse/touch drags swap slots or drop the source beside the player when released over the arena canvas. Tap, R/move and G/drop alternatives remain. Server-validated commands preserve ammo and cell charge; tiers remain pending F-12. Cancellation and live mouse/multitouch checks cover the gesture path. | Implemented for current equipment |
| F-14 | Support rudimentary physics: forces, impulses, velocity and friction. | Keep server authority and fixed ticks; test collision/impulse edge cases, replay behavior and crowded-scene cost. Middleware versus custom implementation is undecided and requires a measured comparison. | Accepted; not implemented |
| F-15 | Traps and hazards generally become more frequent and more dangerous toward the top/bottom and farther right. | Use a seeded spatial danger distribution coordinated with higher-tier rewards; preserve reachable routes and deliberate objective-placement constraints. Exact density/severity curves remain tuning choices. | Accepted; not implemented |
| F-16 | Traps have subtle tells, become overt when proximity triggers them, and return to a concealed presentation after deactivation. | Test dormant/triggered/deactivated presentation, visibility projection and minimap together. Concealment after deactivation does not by itself imply automatic rearming. Current traps do not implement this presentation lifecycle. | Accepted; not implemented |
| F-17 | Add reloading and separate ammunition pickups; reloading must not discard unused loaded rounds. | Define magazine/reserve ownership, capacities, ammo compatibility, reload timing/cancellation and inventory cost. Current ammunition remains attached to weapons and matching weapons refill it. | Accepted; not implemented |
| F-18 | Interior/exterior sight follows the user's described reference: inside can see outside through visible openings; outside can see inside when near a window or door. | Use actual line of sight through the opening plus an exterior proximity rule. Exact proximity and roof-cutaway presentation need specification; current exterior roofs conceal all interiors. The reference game's precise implementation has not been independently verified. | Accepted; partially supported |

## Notes on the accepted additions

- Three hunters, weapon tiers, reloads that retain unused loaded ammunition, and
  ammunition pickups are requirements, not undecided yes/no features (F-11, F-12,
  F-17). Drag-and-drop swapping and dropping is implemented for current equipment
  (F-13); tier support follows F-12.
- Stronger weapon rewards and more frequent or dangerous traps and hazards should
  generally occur with greater vertical excursion toward either extreme and greater
  progress to the right. The user's follow-up selects five virtual columns and rows
  and five mixed quality distributions: horizontal progression supplies the base
  mix, while vertical distance from the center adds 0/1/2, capped at tier 5. These
  are distribution zones, not map tiles. Novel and special content should
  additionally favor vertical exploration. Exact weights, tier statistics and
  novelty content remain tuning decisions; trap and hazard scaling should use the
  same spatial policy. The user's verbatim description is in
  [17](17-open-questions.md).
- Traps should give subtle dormant tells, become overt on proximity activation, and
  return to a more hidden state after deactivation. Trigger radii, activation
  duration, reveal audience and which traps can rearm remain open (F-16).
  Deactivation does not by itself imply automatic rearming.
- Physics must support forces, impulses and friction. Choose custom or middleware by
  evaluating correctness, determinism, integration cost and measured performance;
  neither smaller source size nor using an engine proves it is faster (F-14).
  Requested cases include ice-like sliding, slowing, explosion responses, pushing
  dynamic objects, and robust hunter hook/drag interactions without clipping out of
  the level. The meaning of 2½D ballistics still needs a concrete contract.
- Opening-based interior/exterior visibility should follow the user's described
  behavior in F-18. Outside proximity remains to be tuned.

The implementation boundaries these features imply are in [41](41-roadmap.md).
