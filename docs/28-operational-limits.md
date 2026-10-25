# 28. Operational limits

The server defaults to loopback and caps active rooms at eight. It has no authentication, public matchmaking, encrypted public hosting, horizontal scaling, retention policy, persistent unlocks, or automated crash recovery. Finished recordings accumulate until manually archived. Publishing publicly needs a separate deployment and security pass, and must leave `DEV_TOOLS` unset: `npm run dev` gives every connection the dev view's unfogged, undelayed map ([24](24-networking-privacy.md#dev-view)). The first slice intentionally has no sounds or persistent economy.

HTTP JSON request bodies are limited to 2 KiB. Clients send uncompressed JSON;
non-identity `Content-Encoding` is rejected with HTTP 415 before decompression,
including gzip, deflate and Brotli. Malformed JSON returns 400 and oversized
uncompressed bodies return 413. Replay downloads still use gzip responses; this
request restriction does not affect them.

These limits are deliberate for a local vertical slice. The live-service policies
that would replace them are batched in [17.4](17.4-live-service.md), and the
boundaries that would have to exist first are in [41](41-roadmap.md).
