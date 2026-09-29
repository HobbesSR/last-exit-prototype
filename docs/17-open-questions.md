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
not in issue or pull request comments, which are only working state.

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

## Map generation (folded from mapgen, 2026-09-29)

mapgen kept its own questions file until 2026-09-29. It is archived as
`mapgen/docs/archive/pre-integration/QUESTIONS.md`, and its answers are
preserved verbatim below with the ones given since. The design they produced
is in 50–53. Answers are grouped by topic, each under the question it settled.

### Answers

**Reachability.** Must a hunter reach everything?
  - (2026-09-27) "Everything must be reachable by a hunter so we are pessimistic about passablility."
  - (2026-09-27) "remember we ignore gaps."

**What does `open` guarantee?**
  - (2026-09-27) "Open is a special class of region." "Every cell in the regions formed by open cells must be passable as well as every internal segment of those regions. Addressing the open regions may ultimately use a decomposer and microgenerator that enforces its special requirements, but there is a notion that it is a privileged region class."

**Saving a map.**
  - (2026-09-27) "Can we not make the interior generation essentially a function of a seed, a library, and generation algorithm? And can we not make the objects saveable separably and compoundly as needed?"

**Region boundary openings.** Who states which boundary segments are passable, and what does a builder owe?
  - (2026-09-27) "We may require tile makers to declare passable segments between cells of different regions, i.e. on the perimiter of regions. It's the tile designer's job to mark internal as passable. For convenience, we may make perimeter segments default to passable with explicit nonpassable indicators."
  - (2026-09-27) "just because something isn't marked passable doesn't mean it won't be passable. It just means we can prove its passable."
  - (2026-09-27) "segment passability isn't really enforced in any way, save through the geometry that builders create within their regions. Now we might at some point want to say we want explicit nonpassable and that is a directive that builders must honor, but I don't want that to be another constraint because all builders work on the honor system, and I'd prefer them to honor passable than try to honor multiple objectives."
  - (2026-09-27) "the whole idea is we can trust that any passable perimiter segment in a aggregate region is reachable through passable segments."
  - (2026-09-27) "passable segments must all be part of a chain of perimeter segments on the region large enough to be passable for hunters."
  - (2026-09-28) "there was talk about segments being explicitly impassable on the perimeter of regions, without prescribing a segment object like wall or fence, as a directive to the region builder to make its placed geometry make that segment impassable, and I decided I don't want to make builders, which already work on the honor system, to have to solve for two external objectives at the same time as part of their pinky promise contract, so I suggested they would be, at best, if at all, architectural suggestions for the builers."

**Segment prescriptions.** What does a segment carry?
  - (2026-09-27) "we have for segments cell adjacency requirement for each side, a geometry prescription, and passability prescription. And there are Any DNC modes and stuff." "It can be confusing since some things can imply other things and we accept don't care on some dimensions. So I guess it's just important we distinguish that a segment has that set of prescriptions, which different labels specify directly and indirectly."
  - (2026-09-27) "yes hunters can break fences."
  - (2026-09-28) "Perhaps what's best is to have open / default / any pass down as deep as possible if that information is pertinent (along with the assumption of what it implies if that choice is also needed)"
  - (2026-09-28) "The passability requirement is something that must be matched, either with a corresponding passability or any (and it might be derived), and a "macro" geometry directive, that prescribes something placed not by a builder (which I'm beginning to regret even allowing as a way for macro to prescribe specifics of geometry placement but I just can't write off just yet) like walls and fences, the former creating a derived not-passable conclusion, and the latter deriving a passable conclusion. And so I guess there is also a difference between the declaritive nature at the tile layer, and the knowledge layer derived after solving after valid placements."
  - (2026-09-28) On whether macro geometry directives survive: "I'm going to say no. I'll add them back in (this affects set pieces and tile designs we already have)."

**Rebuilding the chain.** How should generation be structured?
  - (2026-09-28) "let's think about this as a series of transforms to new classes of objects, some very superficially similar, and perhaps relegated to a "view" over the primitive data structure."
  - (2026-09-28) "maybe we keep what we currently have, but now that we have a better understanding we also just try implementing from scratch the whole series of transformers, defining clear interfaces between the layers' transforms, and then implementing within them."
  - (2026-09-28) "I'm giving you license to be the architect here. My architectural directives have been suggestive and the msot concrete thing I've prescribed is clear interfaces between different layers / views of map generation. Somewhat like transformation checkpoints and that resolve conflation of things with the same name like the declaration of passability versus the knowledge of what segments are passable, etc."
  - (2026-09-28) On the planned path: "I don't care about loot prescriptions, that can be added in later and so the "how much" isn't something I care to make first class right now from the macro side. And I"m not sure what's being measured about tiles and anchors, or if anchors are even relevant anymore after previous discussions."

**Set pieces and features.**
  - (2026-09-28) "The set pieces should use the same distribution as before. If I remember, they're actually chosen from set piece classes, sets of set pieces, so I'm not sure that system needs changing."
  - (2026-09-28) "I believe each of those things essentially belong to certain set piece classes, which are the only things we give first class status in the engine. So from a macro perspective, if we need to reason about the existence and relationships of features, it is reasoning about the set piece classes our macro generator has our specific placement rules for that guarantee at least the existence. However, missing from that, is at least a set piece class that owns chargers I think. So we'll make a set piece class that covers charging stations. And remember, set piece classes are sets of set pieces, which are layouts of tile sets, which are sets of tiles, sometimes with just one."
  - (2026-09-28) "class is kind of a suggested "default" or primary region class/type. I don't know if it's really all that helpful or not, but it's supposed to correspond with the type of aggregate region it is predominantly intended to form, which I'm not sure every tile that even makes sense for and its main effect ends up being telling the editor what the default cell region type is. Yup we'll have hunter spawn in end for simplicity right now. We'll assume that the builder for a region type will be responsible for those features. It is up to the authors to ensure that all set pieces that are members of set piece classes generate set pieces with regions that satisfy the special classes. From a macro perspective, we only know its satisfied by trust in the set piece class itself. As far as validation, maybe for now we just trust that the macro generation placement rules for specific set pieces ensure what is placed is valid for feature requirements. There is no loading validation of this and it can only be subsequently reasoned about after micro generation with all buildersis complete. Playground mode I think is just supposed to make our lives easier. It's a debug / development feature that needs to evolve. One per map is fine for now. We can refine the macro generation algorithm as needed for charger placement."

**The library.**
  - (2026-09-29) "I think we may need to once again create a new tile / set piece library. Now each region type essentially gets its own bespoke code, so we can just imagine the decomposers and builders we need and prescribe region types for them. Perhaps we can reuse what exists to some extent, but we shouldn't be bound by it. We're proposing such large changes and ones that essentially put some responsibility on authors, that I think its reasonable to suggest a fresh round of authoring the needed assets."

**The two projects, the SDK and the documentation.**
  - (2026-09-29) "Well I thought the idea of the generation SDK is more about providing a library of reusable functionality likely to be used across builders. But there's kind of a documentation sweep that seems to be necessary in general as well."
  - (2026-09-29) "I kind of wonder if next_tasks is fighting forgejo now."
  - (2026-09-29) "Yes mapgen's docs I think have been part of the bane. I think we need to integrate and normalize the documentation and I'm not sure we could have done it without going through the pains we went through to get to where we are now. And I also think we're in a very delicate place where this is probably the best context that understands how to merge the designs of the two coupled projects that were inadvertantly trying to solve the same things. But mapgen evolved towards owning bottom of macro up, and the original game engine owned building aggregate regions down. And that helps generally decide whose work is relevant versus deprecated, but it might take some searching to truly understand."

### Open

Each has a working assumption, so work continues without an answer. Answer by
number ("M3: …") and the answer is recorded verbatim here.

1. **M1. Which way the halves import.** The chain needs mapgen to hand briefs
   to the game's strategies. *Assumption:* mapgen imports the contract and
   the SDK from `shared/map/micro/`; the game doesn't import mapgen until the
   live game adopts the chain; mapgen's code stays in `mapgen/` until then.
2. **M2. When the proof gates generation.** No library prescribes passable
   runs yet, so the proof has nothing to connect, and which region holds a
   feature isn't known until micro is complete. *Assumption:* the proof is
   reported and never gates for now, and measurement is the gate.
3. **M3. What a passable run obliges.** The chain keeps every guaranteed
   segment open along its whole length. The SDK's `RegionPort` today means "a
   centred aperture somewhere in this run", and the SDK draws jambs beside it,
   which is macro-prescribed geometry. *Assumption:* the contract gains a
   whole-run open obligation for passable runs, with no jambs. Apertures, jambs
   and sealed runs stay available to a strategy for boundaries between its own
   children, where the geometry is its own choice.
4. **M4. Ceilings.** The SDK's `allowed` is a ceiling, and its portal
   negotiation can seal runs: in effect, "not passable" directives. You declined
   those as macro-to-builder directives. *Assumption:* macro never sends a
   ceiling (every obligation it sends allows a hunter), and a strategy may still
   use ceilings and seals between its own children.
5. **M5. One body scale.** mapgen uses radii 0.55 and 0.90 cells; the SDK's
   `cell` profile uses diameters 1.25 and 1.75. Both sit in your band.
   *Assumption:* the chain uses the SDK's `cell` profile as the one source of
   body sizes. The shortest passable run stays 2.
6. **M6. What the whole-map measurement runs on.** *Assumption:* the game's
   geometry with swept discs, once the built map exists in it (51 track C3).
   mapgen's cell lattice stands in until then and is not proof of the game's
   geometry.
7. **M7. Region size limits.** The SDK bounds a region to 4,096 cells and 64
   per axis, and composes up to 16 regions. A macro region may span a hundred
   tiles, wider than 64 cells, and a map has hundreds of regions.
   *Assumption:* those are tool limits (20) and get raised for macro-sized
   regions. A strategy that can't build a large region whole decomposes it.
8. **M8. Guarantees inside a region.** A segment prescribed passable with the
   same region on both sides isn't on a boundary, so the proof doesn't use it.
   *Assumption:* the strategy still keeps it passable.
9. **M9. Does an `open` region need a minimum width?** Every cell and inside
   segment of an `open` region is passable, but a one-cell neck still carries no
   hunter. *Assumption:* at least the door width wherever it has to carry a
   route, checked when regions are formed.
10. **M10. Where cover goes,** if `open` cells can't hold obstacles.
    *Assumption:* cover comes from other classes placed among open ground
    (trees, rocks, rubble, huts).
11. **M11. Skeleton first, or the open-face rule alone?** A spanning tree of
    required passable seams could be pinned before WFC, so the fill adds loops
    but never cuts it. *Assumption:* the open-face rule alone first (#59), with
    backtracking measured, and a skeleton only if that's too costly.
12. **M12. Any versus don't care.** Is "DNC" a mode separate from `any`, one
    that accepts anything and adapts to nothing? *Assumption:* one don't-care
    value per dimension, with today's adopting behaviour, until a case needs
    two.
13. **M13. The shape near exits.** Should the diamond's narrow tip remain when
    several exits share one corridor? *Assumption:* keep it.
14. **M14. Omitting optional structures.** Which set pieces may placement omit
    when they are optional? *Assumption:* none yet; required classes try bounded
    alternatives, then fail explicitly.
15. **M15. 2½D.** Are flat levels with ramps and occasional bespoke
    multi-height regions enough, or do generic overlapping floors matter?
    Deferred until 2D tuning progresses (16).
16. **M16. Tier composition.** How does the diamond diagram combine the
    horizontal tier and the vertical bonus into one number, and are novelty
    rewards a separate category? *Assumption:* the axes stay independent.

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
