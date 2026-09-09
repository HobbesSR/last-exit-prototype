# Last Exit: Design Working Draft

The canonical requirements and the preserved original prompt notes are in [REQUIREMENTS.md](REQUIREMENTS.md). This file stays intentionally shorter and explains the current design shape.

## Purpose

Capture the intended game and define a playable primitive implementation. The working title is provisional. The prototype should test route choice, pursuit, concealment, and escape scarcity before investing in progression or monetization.

## Premise

Contestants cross a large arena while gladiators attempt to eliminate them. A hazard advances from left to right and threatens both roles. The arena is an elongated diamond, narrow at entry and exit and broad through its middle. Only a few contestants can escape.

Contestants gain power from environmental equipment. Gladiators have distinct kits that upgrade when they claim kills. Contestants are smaller and faster; gaps that admit them physically exclude gladiators. Gladiators compensate with tracking, abilities, and a private transport network.

## Spatial and Control Requirements

- "Tiles" means composable, procedurally generated map sections. It does not mean a visible square grid, grid movement, or narrow grid corridors.
- A section chooses a layout and generates continuous geometry inside it: open yards, depot structures, cover clusters, access checkpoints, and bypasses.
- The live map spans several camera views. Players cannot see all gameplay at once.
- Solid obstacles occlude vision. The server also withholds unseen enemies and nearby transient objects from live clients.
- Keyboard movement is independent of mouse aiming. Mouse buttons fire toward the pointer.
- Touch uses independent movement and aim/fire sticks, with separate ability and interaction controls.
- Art direction is a readable, playful top-down arena: clear silhouettes, bright equipment, restrained effects, and obvious interaction shapes. Zombs Royale is the handling and readability reference; Nintendo/Fortnite playground design is an interaction goal, not copied branding or assets.

## Primitive Match

Eight contestants and two gladiators enter a seeded arena with three escape slots. Bots occupy unclaimed slots and are replaced as people join. Contestants travel toward extraction, collect equipment, and use charges to open barriers or choose exposed/hazardous bypasses. Gladiators hunt through sight, sensor information, and kit abilities. The advancing hazard prevents indefinite retreat. The match ends when all exits are claimed, no contestants remain active, or time expires.

The current build has nine generated sections across a 6,720 by 2,880 world, three gated checkpoints with bypasses, three physical escape gaps, three transit stations, and three sensors. These numbers are tuning defaults, not final design commitments.

## Roles

| Role | Strength | Constraint | Growth |
| --- | --- | --- | --- |
| Contestant | Smaller body, faster movement, smoke sprint, blaster pickups | Fragile; escape places are scarce | Access charges, weapon levels, shields, healing |
| Warden | Close-range shockwave | Must reach its target | Kill-based level, damage, recovery, health |
| Specter | Scan reveals nearby contestants | Lower basic damage | Kill-based level, damage, recovery, health |
| Striker | Temporary speed burst | Ability timing matters | Kill-based level, damage, recovery, health |

Provisional rule: contestants cannot damage each other. They still compete for limited extraction slots and pickups. Friendly fire, alliances, revives, and direct contestant combat require playtesting and an explicit decision.

## Information and Counterplay

Obstacles block ordinary sight and projectile travel. Smoke breaks visual tracking unless a reveal is active. Sensors reveal nearby running contestants; sneaking bypasses detection. A Specter scan counters concealment. Sensor marks appear on the schematic minimap even when direct sight is blocked. Camera viewing stations are deferred.

Transport currently cycles gladiators among stations ahead of the hazard and has a cooldown. A later implementation may offer route selection and travel time. Contestants cannot use it. Physical gaps and movement speed provide escape opportunities between transit points.

## Loops and Replayability

Moment to moment: assess nearby cover, choose a route, collect or spend a resource, evade or confront a threat, and advance. Across matches: change role or kit, try a different section arrangement, and learn from the replay. Later progression should unlock gladiators and contestant perks. Packs, stickers, and pre-match modifiers remain ideas, not implemented systems.

Replayability should come first from different human pursuits, constrained information, generated route opportunities, and scarce escapes. Progression should reinforce those choices after the core match proves worthwhile.

## Influences

The Running Man, Battle Royale, Hunger Games, Smash TV, and the remembered Sliders episode inform competition framing. Evolve and Dead by Daylight inform role asymmetry and pursuit. Zombs Royale and Fortnite/PUBG inform top-down or battle-royale legibility and pressure. The original Cycle suggests objective pressure beyond eliminations. Garden Warfare suggests clear kits and cooldowns; Titanfall 2 suggests pre-match modifiers; Mark of the Ninja suggests understandable detection. Specific mechanics should be evaluated on their contribution to this game.

## Open Playtest Questions

Can a contestant break pursuit using cover and gaps? Can a gladiator find engagements without camping extraction? Is opening a gate worth consuming a charge when it also opens the route for pursuers? Does the hazard matter before the match ends? Do all three kits offer viable counterplay? Do generated sections produce routes players can read at speed? Do three exits create competition without making early outcomes inevitable?

Persistent progression, monetization, procedural interiors, destructible cover, player-built impediments, command centers, additional extraction zones, and hunter-triggered traps should follow evidence from these tests.
