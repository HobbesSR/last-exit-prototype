# 28. Operational limits

The server defaults to loopback and caps active rooms at eight. It has no authentication, public matchmaking, encrypted public hosting, horizontal scaling, retention policy, persistent unlocks, or automated crash recovery. Finished recordings accumulate until manually archived. Publishing publicly needs a separate deployment and security pass, and must leave `DEV_TOOLS` unset: `npm run dev` gives every connection the dev view's unfogged, undelayed map ([24](24-networking-privacy.md#dev-view)). The first slice intentionally has no sounds or persistent economy.

These limits are deliberate for a local vertical slice. The live-service policies
that would replace them are batched in [17.4](17.4-live-service.md), and the
boundaries that would have to exist first are in [41](41-roadmap.md).
