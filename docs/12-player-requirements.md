# 12. Non-negotiable player requirements

P-01 through P-16 describe the core implementation and its acceptance evidence.
Accepted improvements and their status are tracked separately as F-01 through F-18
in [13](13-accepted-features.md). Implemented numeric defaults are in
[14](14-match-rules.md).

| ID | Requirement | Acceptance evidence | Status |
| --- | --- | --- | --- |
| P-01 | The arena is elongated left-to-right, diamond-shaped, and larger than one camera view. | World is 24,000 x 12,000; live camera width is less than one third of the world width; generated boundary is diamond-shaped. | Implemented |
| P-02 | Tile templates will eventually compose the map; movement remains continuous. | Interim street graph uses coarse 1,000-unit blocks with offset passages and continuous geometry. This is not the requested modular hierarchy. | Partial; hierarchy deferred |
| P-03 | The hazard advances from contestant entry toward extraction and pressures both roles. | `hazardX` advances against real time; actors behind it take damage; the match has a fixed duration. | Implemented |
| P-04 | Contestants are smaller/faster and can use passages that block gladiators. | Continuous circle collision uses contestant radius 12 and gladiator radius 23; generated gaps and tests verify clearance. | Implemented |
| P-05 | Contestants collect environmental items that affect the current match. | Access charges, weapons, shields, and healing are generated in sections and collected authoritatively. | Implemented |
| P-06 | Access charges open optional barriers without making keys mandatory for escape. | Some building doors require one key; unlocking is permanent. Street routes require no keys. | Implemented interim |
| P-07 | There are few escape places. | The match begins with three extraction slots; each successful extraction consumes one. | Implemented |
| P-08 | Gladiators have distinct kits and improve after kills. | Warden, Specter, and Striker have separate abilities; kills raise level, health, damage, and recovery. | Implemented |
| P-09 | Gladiators have movement options contestants do not. | Transit stations relocate gladiators with cooldown; contestants cannot use them. | Implemented |
| P-10 | Stealth and detection are legible. | Sensors reveal running contestants; sneak avoids sensors; gladiator scan reveals contestants. Contestants have no innate smoke sprint. | Implemented |
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

The accepted target is three gladiators (F-11). The frozen `last-exit-0.6`
prototype still runs two.

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
