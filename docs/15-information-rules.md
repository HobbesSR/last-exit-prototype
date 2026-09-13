# 15. Information rules

What a viewer may know is a gameplay rule, not a rendering detail. F-09 and F-10
in [13](13-accepted-features.md) govern viewport-wide sight and remembered gates.
The mechanism that enforces these rules is in [24](24-networking-privacy.md).

The server uses a bounded potential radius for transport; it is not a rendered circular fog boundary.

The server sends each player the state that could become relevant within the configured visibility radius, plus revealed information. The client applies actual line of sight using the same shared obstacle geometry. Static terrain remains drawn and falls into shadow; actors, pickups, projectiles, and transient effects are withheld when they are not visible. A directed spectator/presenter view is intentionally unfogged and must not be available to a player holding a slot.

Player projections must not include private inventory, ability timers, bot status, path state, input bookkeeping, RNG state, or replay internals. A live projection may be narrower than the recorded frame but must never change values it does include. Tests must compare live projections against the recording field by field.

Camera coverage is capped at 2,400 x 1,600 world units, and the server's potential-visibility radius includes its diagonal plus a 250-unit margin. The sight polygon covers the viewport rather than imposing a circular cutoff. Obstacles conceal dynamic actors, including allies, except explicit gladiator sensor/scan reveals. Static geometry stays visible with shade. Gate memory is local historical presentation; authoritative collision uses actual gate state. This is not a production anti-cheat system: potential state and actual gates remain available to a modified client within the existing trust model.
