# Issue #1282 behavior-driven design interview

**Date:** 2026-11-22  
**Participants:** Corey and GPT-6 Luna (interviewer)  
**Evidence reviewed:** `docs/27.1-tick-mechanic-inventory.md` (D01–D27),
`docs/00-index.md`, `docs/32-delegation.md`, tracker #1279, design issue #1282
and its latest comments, resolution proposal #1276, and merged PR #1286.

This record preserves Corey's messages verbatim. Interviewer prompts are
reconstructed from the interview sequence and notes where the original prompt
wording was not available in the archive capture; see this folder's README.

## Opening and resolver model

**Interviewer (reconstructed):** Start with one scenario: a contestant's
already-fired projectile lethally hits a gladiator on the same tick the
gladiator presses attack and would be in range to land a lethal melee swing.
Today projectile resolution happens first and the swing is skipped. Proposed
redesign: both valid attacks resolve in the tick, so both entities can be
eliminated when the tick's effects are applied. Confirm or correct this
outcome. Does it apply to other damage sources and attack windows?

**Corey:** Yes, I agree with the proposed redesign.

**Interviewer (reconstructed):** Should this be understood as simultaneous
resolution, with entities retained for queries until the tick's effects are
applied?

**Corey:** Yes. And perhaps there is a subtle issue. For example, a melee attack
might be better represented as spawning a hit box that deals damage. But
regardless, if we look at instant hitscan like effects, to entities that
initiate a hitscan effect that elminates either enemy still has all entities
hitscan effect resolve on anything they would hit, including an entity
eliminated that tick. Removal is resolved after all questions about location
for the entity are resolved for the tick.

**Interviewer (reconstructed):** If an eliminated contestant is in the path of
another projectile during that same tick, should it still consume the
projectile?

**Corey:** I believe the eliminated contestant shoudl consume the projectile. I
consider the elimination event an event that marks for removal. So I agree
with the proposal. Also, does this comport with best practices? Do games
typically try to treat events that happen within a tick a simultaneous. For a
scientific simulation it matters, but for game play I'm not sure players can
tell the nuance.

**Interviewer (reconstructed):** Do we need multiple principled resolution
phases, or is one resolution stage followed by applying/deconflicting results
enough? Also, should kill credit require the source to be alive at impact?

**Corey:** Then perhaps we should revisit the idea of maybe allowing for phases,
with a principled reason for each, where effects are resolved as simultaneous
and intermediate state is updated after all resolutions have been identified,
as the way of layering stages. Do we have anything that suggests we want
multiple stages at this time, or is still one two part stage/phase that resolves
and then applies the results to state with conflict resolution rules at the end
sufficient. And as far as the proposal, credit shouldn't be dependent on the
player being alive regardless, even if they die many ticks earlier than the
lethal projectile hitting.

**Interviewer (reconstructed):** For multiple eligible attackers, how should
the kill-credit tie be resolved?

**Corey:** I would say the closer wins first, then in the rare case that's a
tie, actor ID, or random. Actor ID could give some players an inherent
advantage over others if they win all ties. Which is a potential exploit route.

**Interviewer (reconstructed):** Use a match-seeded random draw for exact ties?

**Corey:** match-seeded random draw

## Pickups, extraction, and drops

**Interviewer (reconstructed):** When multiple eligible contestants contest a
whole pickup, propose closest eligible contestant wins and an exact distance
tie uses match-seeded random. For partial pickups, keep the same priority as a
queue and let each take what capacity allows. What should happen to the last
extraction slot?

**Corey:** I don't fully understand the scenario

**Interviewer (reconstructed):** The scenario is two eligible contestants
reaching the final available extraction slot in the same tick. Should the
closest win, with a seeded tie-break?

**Corey:** For items where pickup can be partial, pickup priority is as before.
We can treat it like a queue.

**Interviewer:** Yes.

**Interviewer (reconstructed):** Confirm closest eligible contestant wins the
last extraction slot, with match-seeded random for an exact tie?

**Corey:** Yes.

**Interviewer (reconstructed):** When a player drops an item during tick T,
when does the spawned item become claimable: T+1 or T+2?

**Corey:** Yes, I'd say it might even take two ticks, I'm not sure. Should drops
create a spawn event resolved the next tick, and should that spawn only be
available in the world on the next tick?

**Interviewer (reconstructed):** Treat the drop as a spawn event in T+1, with
the item first claimable in T+2?

**Corey:** I'm going to say T+2 for now. We can tighten it up later. But T+1
cares about the order events and queries are resolved.

**Interviewer (reconstructed):** If multiple attackers land hits on a target
that is eliminated that tick, confirm the common tie-break and reward behavior.

**Corey:** While I'd like both to receive credit, probably good to be consistent
here and use the same tie breaker random seed. However, it would still count
as an assist and the hit is considered landed and all damage is applied, even
after the elimination condition has been met. They are marked for removal but
still there for all queries until the end when state changing impacts are
applied and deconflicted.

**Interviewer (reconstructed):** Confirm kill rewards trigger from kill credit
and are applied on the following tick?

**Corey:** I believe as conceived it goes to those who receive kill credit. So
its triggered on a kill credit event. Which means if we change our mind about
allowing multiple kill credits, that automatically means multiple players will
get the kill reward event applied to the next tick.

**Interviewer (reconstructed):** If an entity is spawned during a tick, can it
be queried or interacted with later in that same tick?

**Corey:** I don't fully understand the scenario

**Interviewer (reconstructed):** Clarified scenario: a drop or respawn enters
the world during T. Can a later same-tick pickup/query see it, or does it first
become available in a later tick?

**Corey:** No, they aren't fully in the world until the next tick. Things that
enter the world within a tick cannot be interacted with until the next tick,
or, as a general rule, if it wasn't in the world at the start of the tick then
it is not available for queries during that tick.

**Interviewer (reconstructed):** Keep the drop item non-interactable until
T+2, consistently with its spawn event being resolved in T+1?

**Corey:** Let's stay consistent and change it, which means it might spawn
already colliding, but collision isn't considered until the next tick. I guess
this also depends a little bit on what rapier wants.

**Interviewer (reconstructed):** Should simultaneous placements with overlapping
geometry (for example, multiple death drops or player drops) use a shared
spawn-conflict rule?

**Corey:** Well the way stations work is likely to change, but let's think about
it as general spawning rules, let's say that the same geometry goveryns the
location of multiple spawns, we're kind in a similar situation to the death
item drop situation. I would think we would try to resolve them similarly.
Which means the answer to this question may also relate to any questions about
death items dropping, or even dropping items by different players on the same
tick within a distance where spawns can overlap, probably something we haven't
even resolved yet.

**Interviewer (reconstructed):** Does spawn placement need to be inside Rapier,
or can game code resolve placement while using Rapier only for collision
queries?

**Corey:** Is there a benefit to not putting them in Rapier? I guess the idea is
they don't play a part of the physics resolution itself, it would just be
utilizing rapier's collsion detection. And I agree with the proposed rule.

## Eligibility, cooldowns, and inputs

**Interviewer (reconstructed):** If a cooldown reaches zero during T, is the
ability available to queries earlier in that same tick?

**Corey:** the eligability status change event would happen within the tick. At
the beginning of the tick, since status wasn't eligible during the query phase,
the skill is not ready.

**Interviewer (reconstructed):** Apply that rule to all cooldowns?

**Corey:** Yup, all cooldowns. Tick establishes a transition event. Might even
be considered an external event that is part of the ticks input event queue,
similar to player input events.

**Interviewer (reconstructed):** Does a gate opening or other tick-time state
change become query-visible only in the following tick?

**Corey:** yes

**Interviewer (reconstructed):** For a held or repeated input when a weapon
finishes reloading on the same tick as fire arrives, which event wins?

**Corey:** This gets into what is valid for input events into the tick. Either
firing instantly cancels a reload process, or a reload process cannot be
cancelled or interrupted by firing. Firing and reloading events in the same
tick are exclusive. A client shouldn't be able to submit them together for
the tick. Should they, the first in the order they are received / pack wins
and the other is flagged as an invalid input event.

**Interviewer (reconstructed):** If reload is already committed, does fire
still enter weapon-fire logic that tick?

**Corey:** I'm going to say that reload events are committed and firing input
events fail to trigger the weapon's fire logic.

**Interviewer (reconstructed):** Movement-changing actions may feel delayed if
all state changes wait until after physics. Should an eligible movement action
affect the current tick's physics solve?

**Corey:** Hmmm this is something where an extra 50ms lag might be noticeable.
ANd it comes down to questions about inputs in general that impact movement.
We do want behaviors to be as responsive as possible, and this is where two
stages of state changing might be necessary, where events that come into the
tick may need to change state that indicate what physics operations are going
to happen during that tick.

**Interviewer (reconstructed):** Use that responsive expectation for now, with
the exact phase/stage design left to the design lead?

**Corey:** Yes that's fine for now

## Spawn timing, transit, and effects

**Interviewer (reconstructed):** Should respawns and other newly spawned
entities follow the same tick-start visibility rule as drops?

**Corey:** Yes it should stay consistent with other spawns

**Interviewer (reconstructed):** If a player is stunned and marked for
elimination during the same tick, does stun take effect before elimination is
resolved?

**Corey:** yes

**Interviewer (reconstructed):** Should a Warden shockwave be treated as a
lag-compensated area event, with consistent lag-compensated queries?

**Corey:** Here I don't fully understand the Warden's design, what is this
ability and what is the rewind aspect of it about?

**Interviewer:** Warden is a gladiator with a close-range shockwave that damages
and stuns. Current implementation rewinds target positions using caster lag;
we should decide how lag-compensated effects query targets and obstruction.

**Corey:** Hmmm interesting. I think this may get into a broader subject about
how the server handles lag compensation in general. I would consider it a lag
compensated AOE event (or series of events if the shockwave literally expands).
And so if that event produces lag compensated queries, lag compensated
queries should have a consistent interface.

**Interviewer (reconstructed):** Should line of sight be evaluated against the
lag-compensated view too?

**Corey:** Yes, los needs to be lag compensated as well

**Interviewer (reconstructed):** For an interact press with multiple eligible
nearby targets, should server-side targeting select one deterministically?

**Corey:** How do games tend to deal with multiple resolveable interactables on
the same input being in range?

**Interviewer (reconstructed):** Typical approach is server-authoritative
selection with a stable priority policy, while the client can predict and
present a target. Should the client nominate and server validate, or should
the server choose without a client target?

**Corey:** Alright. We have another issue. Who decides what the interactable
target is? The client? Or the server? What if the client asserts a target that
isn't eligible. What if it is eligible for the client based on prediction,
but actually isn't due to lag?

**Interviewer (reconstructed):** Proposed split: client may nominate a target
for responsiveness, but the server authoritatively validates eligibility,
range, and line of sight. If invalid, the press fails without falling through
to another target. Confirm?

**Corey:** Probably yes

**Interviewer (reconstructed):** Should the client omit ineligible objects,
such as a locked gate for which the player has no key?

**Corey:** Yes, and also in this scenario I would say that the client ought not
make the locked gate an interact target if there is no eligible key.

**Interviewer (reconstructed):** How much more remains in the interview?

**Corey:** About how much more do we have left?

**Interviewer:** We have a few remaining areas: interaction priority/tie policy,
tick-start query snapshots, effects and trap behavior, and match-time cutoff.

**Interviewer (reconstructed):** How should several eligible interactables be
ordered?

**Corey:** I think we might make it so that there are priority tiers of
interactables with distance resolving within tiers. Unclear what to sort into
different tiers. We can start with too as an example and let agents decide what
goes best in each. It can be rearranged with feedback later.

**Interviewer (reconstructed):** Use two example tiers as an initial proposal,
with tier membership provisional?

**Corey:** yes

**Interviewer (reconstructed):** Does the current design allow a failed
selected interaction to fall through to another eligible object?

**Corey:** yes, in its current design it does not.

**Interviewer (reconstructed):** Should a failed selected target continue to
consume the input rather than fall through?

**Corey:** yes

**Interviewer (reconstructed):** Do interaction target queries use state at the
beginning of the tick?

**Corey:** yes, there targetting sees the state at the beginning of the tick

## Lag compensation, hazards, and match end

**Interviewer (reconstructed):** Should the Warden shockwave be one instant
lag-compensated event for now, with a multi-tick expanding blast left for later
if responsiveness requires it?

**Corey:** For now yes. A blast may need to be modelled over multiple ticks, at
which point if it doesn't feel responsive that will take care of it, should we
get there.

**Interviewer (reconstructed):** If the time limit expires while a tick is in
progress, should that tick finish resolving?

**Corey:** If a tick starts it resolves. The match time limit should probably
just gate if tick processing continues, right?

**Interviewer (reconstructed):** Confirm the next tick is gated after the limit,
but any tick already started runs to completion.

**Corey:** yes

