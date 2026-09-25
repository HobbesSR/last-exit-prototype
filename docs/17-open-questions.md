# 17. Open questions

Indented bullets under a question are the user's verbatim answers. Preserve them
exactly; do not paraphrase them into the requirement tables, and do not treat an
answered question as implemented. An answer that has become a requirement is
tracked as an F-## row in [13](13-accepted-features.md).

Nothing here blocks the work already sequenced in [41](41-roadmap.md).

## Micro-generation direction and next answer batch (2026-09-19)

**Where to answer:** Reply in chat using “Micro 1” through “Micro 5” and I will
record your answers verbatim here, or add an indented answer directly beneath
each question below. Partial answers are welcome. Keep answers in this document,
not in `FRESH_SESSION.md`, which is only a resume checkpoint.

The user's current direction, preserved verbatim:

> I do feel like we want something more like 24 contestants in the real game. Anyway, let's see. I think the thing I was most working towards was getting "micro" generation map details working where micro generations take in meta / macro parameters to procedurally generate classes of structures / architectures / settings within bounded regions, connecting with the macro generation using segments and cells, and using those primitives internally as well for convenience and modularity in structures, but not being as rigidly bound to them as the macro generations (unimplemented here, a prototype in the works in a sibling directory.). I'd like you to push as far as you can continuing on that effort for now. Defer questions for batch answering later and proceed in the directions you can without answers. Where the difference is negligible or easy to refactor, take your best guess.

This authorizes micro implementation with recorded reversible assumptions; it
supersedes the older blanket F-01 specification deferral. Implementation and
assumptions are in [20](20-micro-generation.md). Approximate 24-contestant scale is
future direction; live content remains eight contestants pending spawn, map and
crowd validation. No answer below blocks the current preview or region contract.

1. **Scale:** Should the eventual macro bridge rescale cells, the whole arena or
   bodies to match the sibling's segment/body proportions? Current micro preview
   uses 40 world units per cell and unchanged game body sizes.
    - Scale is roughly 2 cells is a doorway, a contestant is more than 1 cell and less than 1.5. A hunter is more than 1.5 and less than 2. That allows us to make 1.5 cell length gaps contestants can fit through and hunters can't.
2. **Architecture priorities:** Which settings should get the next detailed
   grammars: apartment blocks, markets, transit/service infrastructure, industrial
   interiors, gardens, or another class? Current builders cover depots, courtyard
   compounds, open ground and ruins with reversible density/room/decay tuning.
    - Not a high priority. These are going to be examples. I think in particular we want to explore novel ways of generating things in regions but look for the commonality to provide a micro-generation SDK like library.
3. **Feature regions and 24 contestants:** How dispersed should contestant entry
   areas be, and how many spawn/charger/transit/exit sites should a region owe?
   Current micro output offers budgeted loot candidates only; it does not invent
   feature or extraction capacity rules.
    - The contestant entry areas should be treated like a region that gets micro generated. The simplest implementation just tries to spawn players with roughly equal spacing given the region area provided.
4. **Access contracts:** Can a required macro path include a locked door or a
   breakable barrier? Current required routes assume unlocked doors may be opened;
   locks never satisfy a required path by assumption.
    - This gets into parameter passing we can defer I think for now.
5. **Subregions and appearance:** Should a builder hand unused ground to a named
   child class, or should macro name all classes? Current room assemblies are
   hierarchical geometry, but recursive region delegation/material palettes and
   height/collision-plane semantics are still future work.
    - I have a write up for a micro generator design that provides a separate SDK library for decomposing regions into sub regions and assigning micro-generators to them, including potentially generic ones or borrowing from other region type's associated generators in some cases. So a region type will have a decomposer that tries to break up regions into region "shapes" it is happy to build in with its associated generators, and decide what to do with other regions. But we don't need to get into all that. And you also might look at where we're at with the last exit map generator in the sibling directory. I think it's gotten into a good place where it can produce a map composed of regions. I don't think integration is a right now thing. But it may inform your work to make integration in the near future easier. I'll see if I can get that micro generation design I was talking about pasted in here, but feel free to get to work. I'd like to be able to test the microgeneration work you've done somehow, even if it's not in a live game.

Answers above were received September 22. The question descriptions retain their
September 19 context; current implementation is in [20](20-micro-generation.md).
The lab uses the accepted scale bands with provisional midpoint diameters (1.25
and 1.75 cells), plus a live-scale comparison. Entry spacing is a reusable local
placement operation. Special access policy remains deferred; architecture
examples are not a priority backlog of art styles. September 24 clarifies the
boundary abstraction and post-generation reachability obligation in [19](19-decomposition-design.md).
Segment inheritance and physical validation are now SDK utilities in 20; special
access policies such as locks and breakable barriers remain deferred.

The decomposition design has now been supplied (September 22–23); its accepted
contract and selected verbatim statements are in [19](19-decomposition-design.md).
The framework should allocate candidate footprints according to generator fitness,
residual quality and useful interfaces. It should not impose rectangle or convex
partitioning universally. The first concrete strategy and implementation limits
are in [20](20-micro-generation.md); the design is no longer awaiting input.

The sibling's original `design_notes.txt` supplies existing cell/segment intent;
its current generator is a standalone prototype. Its uncommitted UI work was left
untouched, and its dimensions, clearance values and topology proofs were not
silently adopted as game contracts.

## Product and gameplay — review together when convenient

1. Modular hierarchy: provide hierarchy levels, template sizes, connector contracts and one concrete example. Current street generation remains explicitly interim.
2. Exterior visibility: choose the outside proximity threshold and roof-cutaway presentation for the now-accepted opening-based sight rule (F-18). Current roofs keep interiors hidden until entry.
    - I'm essentially trying to use the same mechanics as Zombs royale. I believe when inside you can see outside or at least what is visible through the windows. When you are outside you can only see in if you're nearby the window or door.
3. Human balance: review route readability, vertical exploration, five-second charging, the ten-minute wall, PvP engagement distances and three extraction slots.
4. Ammo: reloads and ammo pickups are accepted. Choose magazine/reserve capacities, ammo sharing between weapon types, reload cancellation/timing and whether reserves cost inventory slots. R currently means move/merge, so the reload binding needs resolution. Additional weapon types and an equipped-ability slot remain undecided.
    - Need reloading. Unused loaded ammo is not lost. We also need ammo pickups.
5. Hunter travel/respawning: automatic safe placement versus chosen destinations, 20-second respawn, retained upgrades, and rewards for taking down a hunter.
6. Multi-floor implementation: ramp transition rules, overlapping-floor visibility/projectile rules, and a navigation representation compatible with intended templates.
7. Matchmaking and lifecycle: soft role preference, 15-second bot-fill timer and 30-second empty-room grace. Public hosting/accounts/ranking are separate work.
8. Performance: if a slowdown recurs, capture Replays → Download performance diagnostics. It includes recent raw frame intervals, packet gaps, browser/viewport, seed/location and live/empty room counts, but no owner credentials, chat or player list. Note whether movement stutters or the whole display freezes, plus elapsed match time and number of game tabs.
    - Slowdowns seem to occur when lots of bots (or maybe just players) are nearby, even when off screen
9. Patron actions, persistent progression, presenter UX and fairness remain separate milestones.
10. Weapon tiers: tier count/names, affected statistics, refill/merge compatibility between tiers, and the relative influence of vertical excursion versus rightward progress.
    - Let's say there are 5 tiers. Let's say we split the diamond into a "grid" of 5 x 5 virtual zones (not in like map layout). But essentially horizontally the likilihood of
    higher tier lier bumps up by a tier each zone. You catch my drift. Not hard jump of what tier stuff can be found in each zone. So you'll find a mix in each zone. Vertically
    middle zones don't modify that, while moving away from the center adds 1 and then 2 to that tier mix. So I mean you can probably just set this to 5 different tier mixes and the way the diamond works it's like 1 through 5 in the center, then in column 2 you'll have 2 in the center and 3 above and below it, and then the map doesn't extend into where the 4 would be. So by the time you get to 3 you'll have essentially a tier 5 at the top and bottom zones in the middle column. However, there's also a novelty factor I'd like to add in, where the more novel and special items and weapons will be distributed vertically further from the center.
11. Trap/hazard scaling: density and severity curves, proximity triggers, subtle tells, visibility after deactivation and rearming rules. Keep mandatory charging/spawn safety constraints explicit.
    Probably trap / hazard scaling can go hand in hand with loot tier scaling
12. Physics: first required interactions (knockback, sliding, pushing, grapples or movable props), collision response expectations and maximum supported actor/prop counts. Prototype both implementation approaches only against those concrete needs.
    So we need sliding like on ice, and slowing down. Responses to explosions. 2 1/2d ballistics (not sure what this really will mean). Dynamic objects should push. Shouldn't be
    able to clip out of the level or anything. (Zombs royale level of physics essentially). But also importantly we want to make fun kits for the hunters / gladiators. Like
    Overwatch's Roadhog's Hook mechanic would be awesome, but it actually went through a lot of iterations to get right and deal with all the mechanical edge cases that causes.
13. Live-service policy questions are in the next section; none blocks the current in-process encapsulation work.

The reported severe slowdown is still open. Off-screen culling and navigation reuse are implemented; abandoned rooms now retire; previous benchmarks used smoothed frame deltas and have been replaced with raw timing. Passing local tests alone does not establish a fix.

## Live-service policy

No answer is required for the current implementation. Existing prototype behavior
remains the default until these policies are decided. These supplement, rather than
replace, the map hierarchy, multi-floor, balance and presentation questions above.

1. First release: private invited playtests, public anonymous play, or accounts?
   What concurrent players/matches and geographic footprint should we plan for?
   Let's say worldwide for now. Imagine we deploy this on a VPS and other turn key services for deploying something like this as a live service.
2. Deployment behavior: finish matches on the old server version, reconnect to a
   replacement, or tolerate interrupted matches? Is crash recovery required?
   So I guess you know there is the lobby server and then there are the spawned game server. So I guess when you come back to join a new game yoru client will have to update.
3. Replay policy: who may download full-state recordings, how long are they kept,
   and how long must old recordings remain playable?
      - Replays can only be downloaded by the room owner. They last as long as the owner has not exited the game. Ideally replays will be stored in BSON and recorded in JSON only for debugging.
4. Content rollout: should a match always retain its starting balance/content,
   and are simultaneous balance variants/experiments needed?
5. Persistent progression/rewards: which outcomes survive a match, and what must
   happen when storage fails or the same result is delivered twice?
6. Observer fairness: public spectators/presenters, delay policy, and whether the
   same person may participate and observe through separate sessions?
      - We should plan to be able to restrict who is allowed to spectate, but not implement it. We should plan to be able to delay spectation,
      but not automatically do it. During the initial bring up of the game, we will not worry about whether there are bad actors, we simply tolerate
      them during rapid development. But we try not to box ourselves in.
7. Failure policy: if recording cannot keep up or fails, pause the match, continue
   without a replay, or end it? Current disk backpressure pauses advancement.
      - Recording replay should not impact gameplay. If replay fails for some reason it should
      fail gracefully for all clients and systems. If replay can be recovered, playback should
      handle missing data gracefully.

Question 7 has been answered and implemented; see [26](26-recording-contract.md).
The answers to 3 and 6 are accepted direction and remain unimplemented: archives
are still process-wide and persistent, and spectators are still owner-gated and
delayed by default. Do not present either behavior as satisfying those answers.

## Open playtest questions

Can a contestant break pursuit using cover and gaps? Can a gladiator find
engagements without camping extraction? Is opening a gate worth consuming a charge
when it also opens the route for pursuers? Does the hazard matter before the match
ends? Do all three kits offer viable counterplay? Do generated sections produce
routes players can read at speed? Do three exits create competition without making
early outcomes inevitable?

Persistent progression, monetization, destructible cover, player-built impediments,
command centers, additional extraction zones and hunter-triggered traps should
follow evidence from these tests.
