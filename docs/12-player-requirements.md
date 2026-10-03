# 12. Non-negotiable player requirements

P-01 through P-16 describe the core implementation and its acceptance evidence.
Accepted improvements and their status are tracked separately as F-01 through F-18
in [13](13-accepted-features.md). Implemented numeric defaults are in
[14](14-match-rules.md).

| ID | Requirement | Acceptance evidence | Status |
| --- | --- | --- | --- |
| P-01 | The arena is elongated left-to-right, diamond-shaped, and larger than one camera view. | Live chain is 17,280 by 8,640 with a stepped diamond outline; collision and rendering use its actual owned cells. Live view shows only part of it. | Implemented |
| P-02 | Tile templates will eventually compose the map; movement remains continuous. | Authored tiles and set pieces feed region strategies through the generation chain (51); the live adapter consumes their geometry (22). | Implemented initial chain |
| P-03 | The hazard advances from contestant entry toward extraction and pressures both roles. | `hazardX` advances against real time; actors behind it take damage; the match has a fixed duration. | Implemented |
| P-04 | Contestants are smaller/faster and can use passages that block gladiators. | Live radii remain 12 and 23 by user choice. The new cell-profile squeeze balance needs separate tuning (14, 17). Legacy clearance tests remain. | Bodies implemented; live gap balance pending |
| P-05 | Contestants collect environmental items that affect the current match. | Access charges, weapons, shields, and healing are generated in sections and collected authoritatively. | Implemented |
| P-06 | Access charges open optional barriers without making keys mandatory for escape. | Legacy locked-door mechanics remain supported; chain doors are currently unlocked (14). | Mechanics implemented; chain authoring pending |
| P-07 | There are few escape places. | The match begins with three extraction slots; each successful extraction consumes one. | Implemented |
| P-08 | Gladiators have distinct kits and improve after kills. | Warden, Specter, and Striker have separate abilities; kills raise level, health, damage, and recovery. | Implemented |
| P-09 | Gladiators have movement options contestants do not. | Six authored transit regions provide stations for hunter-only travel and safe redeployment (52, 54). | Implemented |
| P-10 | Stealth and detection are legible. | Gladiator scan reveals contestants; sensor/sneak mechanics remain supported in legacy maps, with chain sensor authoring pending (14). | Partial in live chain |
| P-11 | Solid obstacles block vision and projectile travel. | Solid walls and closed doors occlude; windows pass sight and shots but block bodies and item interactions. | Implemented |
| P-12 | Desktop controls separate movement and aim. | WASD/arrow movement and pointer aim; left mouse fires. | Implemented |
| P-13 | Touch controls support simultaneous movement and aim/fire. | Independent virtual sticks are tested with two concurrent touch contacts. | Implemented |
| P-14 | A player cannot see the whole live battlefield. | Camera follows the player; full-map view is reserved for completed replays. | Implemented |
| P-15 | A player can replay exactly what the authoritative server recorded. | Normal recordings retain every tick with commands, map and SHA-256. Storage pressure may omit whole frames without pausing gameplay; recovered recordings are labelled incomplete and playback preserves recorded timing. Permanent recording failures notify viewers without ending the match. | Implemented with explicit failure policy |
| P-16 | Server authority prevents client-side state injection. | Inputs are bounded, sequenced, rate-limited, and validated; clients cannot set position, health, inventory, or outcomes. | Implemented |

## Roles in the current prototype

| Role | Strength | Constraint | Growth |
| --- | --- | --- | --- |
| Contestant | Smaller body, faster movement, six equipment slots, no innate ability | Fragile; escape places are scarce | Access charges, weapons, shields, healing |
| Warden | Close-range shockwave | Must reach its target | Kill-based level, damage, recovery, health |
| Specter | Scan reveals nearby contestants | Lower basic damage | Kill-based level, damage, recovery, health |
| Striker | Temporary speed burst | Ability timing matters | Kill-based level, damage, recovery, health |

Contestants can shoot each other and compete for equipment and escape slots.
Gladiators killed in combat respawn after 20 seconds at a safe transit station,
retaining upgrades. Human PvP incentives and balance remain playtest questions;
see [17](17-open-questions.md).

Default matches have three gladiators (F-11). The retained `content-1` baseline
has two; see [14](14-match-rules.md) for the versioned roster.

## Information and counterplay

Solid walls and closed doors block ordinary sight and projectile travel. Windows
pass sight and shots, while roofs hide interiors from outside. Sensors reveal
nearby running contestants; sneaking bypasses detection. A Specter scan counters
concealment. Sensor marks appear on the schematic minimap even when direct sight
is blocked. Camera viewing stations are deferred.

Transit currently cycles gladiators among stations ahead of the hazard and has a
cooldown. A later implementation may offer route selection and travel time.
Contestants cannot use it. Physical gaps and movement speed provide escape
opportunities between transit points.

The rules governing what any viewer may know are in [15](15-information-rules.md).
