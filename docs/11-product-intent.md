# 11. Product intent

Last Exit is an asymmetric top-down escape game. Many contestants move through a
large, elongated diamond arena while a small number of gladiators hunt them. A
left-to-right hazard forces the whole match forward. Contestants are trying to
reach a small number of extraction places; gladiators are trying to claim kills
and improve their kits.

The first milestone is a playable proof of the pursuit-and-escape loop. It is
successful when a player can understand the space, make route and information
decisions, outplay or be outplayed by another role, and explain the outcome
afterward through a perfect replay. The prototype should test route choice,
pursuit, concealment and escape scarcity before investing in progression or
monetization. The working title is provisional.

## Premise

Contestants cross a large arena while gladiators attempt to eliminate them. A
hazard advances from left to right and threatens both roles. The arena is an
elongated diamond, narrow at entry and exit and broad through its middle. Only a
few contestants can escape.

Contestants gain power from environmental equipment. Gladiators have distinct kits
that upgrade when they claim kills. Contestants are smaller and faster; gaps that
admit them physically exclude gladiators. Gladiators compensate with tracking,
abilities and a private transport network.

## Spatial and control intent

- "Tiles" means composable, procedurally generated map sections. It does not mean
  a visible square grid, grid movement or narrow grid corridors.
- A section chooses a layout and generates continuous geometry inside it: open
  yards, depot structures, cover clusters, access checkpoints and bypasses.
- The live map spans several camera views. Players cannot see all gameplay at once.
- Solid obstacles occlude vision. The server sends a bounded potential-visibility
  projection and the client resolves exact sight. The sight polygon fills the
  play-area viewport while retaining obstacle occlusion for dynamic entities.
- Keyboard movement is independent of mouse aiming. Mouse buttons fire toward the
  pointer.
- Touch uses independent movement and aim/fire sticks, with separate ability and
  interaction controls.

## Presentation target

The prototype's playful arena presentation is a baseline, not the target. The
accepted art direction is cyberpunk urban dystopian ruins, preserving clear
silhouettes, readable equipment and obvious interactions. Zombs Royale remains a
handling and inventory reference. The accepted target includes ramps, playable
roofs and overlapping floors on discrete collision planes; their navigation and
transition rules remain future work. See [13](13-accepted-features.md) F-01 and
F-04 for status, and [16](16-deferred.md) for what is postponed.

## Loops

Moment to moment: assess nearby cover, choose a route, collect or spend a
resource, evade or confront a threat, and advance. Across matches: change role or
kit, try a different section arrangement, and learn from the replay.

Replayability should come first from different human pursuits, constrained
information, generated route opportunities and scarce escapes. Later progression
should unlock gladiators and contestant perks, and should reinforce those choices
only after the core match proves worthwhile. Packs, stickers and pre-match
modifiers remain ideas, not implemented systems.
