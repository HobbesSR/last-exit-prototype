# Last Exit: Design Working Draft

The canonical requirements and the preserved original prompt notes are in [REQUIREMENTS.md](REQUIREMENTS.md). This file stays intentionally shorter and distinguishes the implemented prototype from accepted future direction.

## Purpose

Capture the intended game and define a playable primitive implementation. The working title is provisional. The prototype should test route choice, pursuit, concealment, and escape scarcity before investing in progression or monetization.

## Premise

Contestants cross a large arena while gladiators attempt to eliminate them. A hazard advances from left to right and threatens both roles. The arena is an elongated diamond, narrow at entry and exit and broad through its middle. Only a few contestants can escape.

Contestants gain power from environmental equipment. Gladiators have distinct kits that upgrade when they claim kills. Contestants are smaller and faster; gaps that admit them physically exclude gladiators. Gladiators compensate with tracking, abilities, and a private transport network.

## Spatial and Control Requirements

- "Tiles" means composable, procedurally generated map sections. It does not mean a visible square grid, grid movement, or narrow grid corridors.
- A section chooses a layout and generates continuous geometry inside it: open yards, depot structures, cover clusters, access checkpoints, and bypasses.
- The live map spans several camera views. Players cannot see all gameplay at once.
- Solid obstacles occlude vision. The current server sends a bounded potential-visibility projection and the client resolves exact sight. The sight polygon fills the play-area viewport while retaining obstacle occlusion for dynamic entities.
- Keyboard movement is independent of mouse aiming. Mouse buttons fire toward the pointer.
- Touch uses independent movement and aim/fire sticks, with separate ability and interaction controls.
- The prototype's playful arena presentation is a baseline. The accepted art direction is cyberpunk urban dystopian ruins, preserving clear silhouettes, readable equipment, and obvious interactions. Zombs Royale remains a handling and inventory reference. The accepted target includes ramps, playable roofs and overlapping floors on discrete collision planes. Their navigation and transition rules remain future work.

## Primitive Match

This section and the role table describe implemented behavior, not completion of the future requirements below.

Eight contestants and two gladiators enter a seeded arena with three escape slots. Bots occupy unclaimed slots and are replaced as people join. Contestants travel toward extraction, collect equipment, and use charges to open barriers or choose exposed/hazardous bypasses. Gladiators hunt through sight, sensor information, and kit abilities. The advancing hazard prevents indefinite retreat. The match ends when all exits are claimed, no contestants remain active, or time expires.

The current interim build is a 24,000 by 12,000 connected street maze with loops and offset passages, optional locked buildings, windows and roofs, separated loot, transit and chargers. A cell uses an ordinary equipment slot and charges in five seconds. The wall finishes at ten minutes, leaving room for exploration instead of constant running. The actual modular hierarchy remains deferred for a detailed user specification.

## Accepted Direction — status 2026-09-10

- Hierarchical procedural generation selects tile templates controlling paths and connections. Guarantee top, middle, and bottom routes to extraction, with optional dead ends, key-gated areas, and relatively fixed access-point distribution. Include playable interiors and outdoor spaces.
- Extraction requires finding a power cell, charging it at a station, and delivering the charged cell to an escape pod. Limited escape capacity remains; cell handling and charging details need design work.
- Increase map size substantially. Initially tune travel plus objectives toward ten minutes, with the wall of death reaching the map end around ten minutes. Current dimensions are not the target dimensions.
- Add motion-sensitive mines, turrets, flamethrowers, and spider bots that attack anything in web range, pursue only a limited distance, and can grapple.
- Replace innate contestant abilities, including smoke sprint, with weapon/item slots and broader weapon variety. A single equipped-ability slot remains optional and undecided. Gladiator kits and kill-based growth remain.
- Support private rooms and server matchmaking with gladiator, contestant, or no role preference. Assignment policy is still open; this requirement does not imply completed public hosting.
- Fill the entire play-area viewport without a circular sight cutoff. Static map elements stay visible; obstacles conceal dynamic entities. Doors and other changeable map elements retain their last-known state outside sight, refreshing on observation. Future dynamic terrain should use the same principle.

These are tracked as F-01 through F-10 in `REQUIREMENTS.md`. The requested hierarchical template system is explicitly deferred; the interim maze improves playability without claiming to implement it. Indoor/outdoor mechanics are implemented, but 2½D presentation and finished art remain incomplete. Batched design questions are in requirements section 8.

Inventory now uses six icon-based slots, finite ammo, move/swap/merge controls and retained ammunition on drops. Weapon pickups replenish matching ammunition. Magazine/reload design remains an open balance question; current ammo is attached to each weapon.

## Roles (Current Prototype)

| Role | Strength | Constraint | Growth |
| --- | --- | --- | --- |
| Contestant | Smaller body, faster movement, six equipment slots, no innate ability | Fragile; escape places are scarce | Access charges, weapons, shields, healing |
| Warden | Close-range shockwave | Must reach its target | Kill-based level, damage, recovery, health |
| Specter | Scan reveals nearby contestants | Lower basic damage | Kill-based level, damage, recovery, health |
| Striker | Temporary speed burst | Ability timing matters | Kill-based level, damage, recovery, health |

Contestants can shoot each other and compete for equipment and escape slots. Bots avoid initiating contestant fights for 30 seconds, then contest close personal space; after two minutes their engagement distance increases. Retaliation remains immediate. Gladiators killed in combat respawn after 20 seconds at a safe transit station, retaining upgrades. Human PvP incentives and balance remain playtest questions.

## Information and Counterplay

Solid walls and closed doors block ordinary sight and projectile travel. Windows pass sight and shots, while roofs hide interiors from outside. Sensors reveal nearby running contestants; sneaking bypasses detection. A Specter scan counters concealment. Sensor marks appear on the schematic minimap even when direct sight is blocked. Camera viewing stations are deferred.

Transport currently cycles gladiators among stations ahead of the hazard and has a cooldown. A later implementation may offer route selection and travel time. Contestants cannot use it. Physical gaps and movement speed provide escape opportunities between transit points.

## Loops and Replayability

Moment to moment: assess nearby cover, choose a route, collect or spend a resource, evade or confront a threat, and advance. Across matches: change role or kit, try a different section arrangement, and learn from the replay. Later progression should unlock gladiators and contestant perks. Packs, stickers, and pre-match modifiers remain ideas, not implemented systems.

Replayability should come first from different human pursuits, constrained information, generated route opportunities, and scarce escapes. Progression should reinforce those choices after the core match proves worthwhile.

## Influences

The Running Man, Battle Royale, Hunger Games, Smash TV, and the remembered Sliders episode inform competition framing. Evolve and Dead by Daylight inform role asymmetry and pursuit. Zombs Royale and Fortnite/PUBG inform top-down or battle-royale legibility and pressure. The original Cycle suggests objective pressure beyond eliminations. Garden Warfare suggests clear kits and cooldowns; Titanfall 2 suggests pre-match modifiers; Mark of the Ninja suggests understandable detection. Specific mechanics should be evaluated on their contribution to this game.

## Open Playtest Questions

Can a contestant break pursuit using cover and gaps? Can a gladiator find engagements without camping extraction? Is opening a gate worth consuming a charge when it also opens the route for pursuers? Does the hazard matter before the match ends? Do all three kits offer viable counterplay? Do generated sections produce routes players can read at speed? Do three exits create competition without making early outcomes inevitable?

Persistent progression, monetization, destructible cover, player-built impediments, command centers, additional extraction zones, and hunter-triggered traps should follow evidence from these tests. Playable interiors, doors, roofs, windows and the trap types above are implemented prototype mechanics.
