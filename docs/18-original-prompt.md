# 18. Original prompt notes

This section preserves the original design stream that started the project. It is intentionally rough; it is a source record, not a list of accepted requirements.

## Initial section ideas

- Introduction: purpose of the document is to outline the core game elements and the most primitive design that can be implemented and played.
- Game premise/concept; battle-royale root; inspirations from The Running Man, Super Smash TV, a Sliders episode, Zombs Royale, Maze Runner, Battle Royale, The Hunger Games, Evolve, Dead by Daylight, Fortnite/PUBG, The Cycle, Plants vs. Zombies: Garden Warfare, and Titanfall 2.
- Character abilities with cooldowns; card packs/stickers; pre-game cards.
- Game elements: many contestant players, few hunter/gladiator players, map, contestant spawn zones, hunter spawn zones at one narrow end, a diamond-shaped maze, middle challenge area, procedurally generated simple maze, contestant pickups, keys, weapons, temporary and match-long power-ups, macro-loop collectibles and consumables, locked shortcuts, weapons and utility items, locked pickups.
- Environmental hazards and static traps; hunter-triggerable hazards and traps; trigger controls; command-center zones; a progressing hazard zone; contestant extraction zones; hunter fast travel locations; blockades; projectiles; player-spawnable temporary impediments; player-created temporary area damage or crowd-control zones; cameras and motion sensors; Mark of the Ninja; hunter HUD; cooldowns; map; contestant inventory; mechanics; design goals; player experience; monetization; micro/macro loop; replayability.

## Clarifications added afterward

- The diamond is elongated left-to-right.
- A hazard pushes across from left to right and compels contestants and gladiators forward.
- Gladiators have kits and abilities that upgrade as they claim kills.
- Contestants scale through items found in the environment.
- Barriers require keys mechanically, while exposed areas and environmental hazards provide alternatives.
- Only a few escape slots exist.
- Gladiators are larger and slower or equal-speed; contestants escape through gaps they cannot fit through.
- Gladiators have exclusive travel such as rails and transport stations.
- There are multiple gladiator kits.
- Cameras and sensors can alert gladiators or be inspected at viewing stations.
- The long-term loop is unlocking gladiators and earning contestant perks.
- The visual and interaction target is a Nintendo/Fortnite-style playground.
- The proof of concept is top-down and Zombs Royale-like in handling, with free movement rather than grid movement.
- The map is procedurally generated from reusable sections, not a visible square grid.
- The server should be authoritative and save perfect replays.
- Rust was considered for the core server and shared prediction; the current prototype uses a shared JavaScript core with a documented Rust/WASM path.

## Future-work notes added 2026-09-09

These notes are accepted direction, unlike the exploratory original prompt above; [13](13-accepted-features.md) provides requirement IDs. Improve procedural generation through hierarchies and selected tile templates controlling paths, with top/middle/bottom routes, some dead ends, keys, and relatively fixed access points. Require finding a power cell, charging it at a station, and delivering it to escape pods. Use cyberpunk urban dystopian ruins, interiors and exteriors, and a 2½D playing field. Add motion-sensitive mines, turrets, flamethrowers, and web-bound spider bots with limited pursuit and grappling. Give contestants weapon/item slots, more weapons, and no innate abilities, with one equipped-ability slot still a possibility. Add private rooms and matchmaking with optional role preference. Increase map size and tune objectives/travel toward ten minutes, with the wall reaching the end around ten minutes.

Visibility clarification: remove circular fog and fill the play-area viewport. Static map elements remain visible, while obstacles conceal dynamic entities. Retain the last-known state of changeable map elements such as doors; future dynamic terrain should follow that model. The precise meaning of 2½D remains open.

## Influences

The Running Man, Battle Royale, Hunger Games, Smash TV, and the remembered Sliders
episode inform competition framing. Evolve and Dead by Daylight inform role
asymmetry and pursuit. Zombs Royale and Fortnite/PUBG inform top-down or
battle-royale legibility and pressure. The original Cycle suggests objective
pressure beyond eliminations. Garden Warfare suggests clear kits and cooldowns;
Titanfall 2 suggests pre-match modifiers; Mark of the Ninja suggests understandable
detection. Specific mechanics should be evaluated on their contribution to this
game, not adopted because a reference game has them.
