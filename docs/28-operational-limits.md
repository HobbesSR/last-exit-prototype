# 28. Operational limits

The server defaults to loopback and caps active rooms at eight. It has no authentication, public matchmaking, encrypted public hosting, horizontal scaling, retention policy, persistent unlocks, or automated crash recovery. Finished recordings accumulate until manually archived. Publishing publicly needs a separate deployment and security pass, and must leave `DEV_TOOLS` unset: `npm run dev` gives every connection the dev view's unfogged, undelayed map ([24](24-networking-privacy.md#dev-view)). The first slice intentionally has no sounds or persistent economy.

HTTP JSON request bodies are limited to 2 KiB. Clients send uncompressed JSON;
non-identity `Content-Encoding` is rejected with HTTP 415 before decompression,
including gzip, deflate and Brotli. Malformed JSON returns 400 and oversized
uncompressed bodies return 413. Replay downloads still use gzip responses; this
request restriction does not affect them.

Express keeps `trust proxy` disabled by default, and the server currently does not
read `req.ip` or `req.ips`. The `proxy-addr` dependency advisory
[GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) is fixed
in 2.0.8. It describes incorrect trust decisions for IPv4-mapped IPv6 ranges,
including configurations such as `::ffff:10.0.0.0/8` (where `/104` is the
correct mapped prefix) and `::/1`; these can trust every IPv4 sender. Use an
ordinary IPv4 CIDR such as `10.0.0.0/8` to express an IPv4 range. The advisory
does not establish exploitability in this application while proxy trust is
disabled and client IP access is unused.

If a future deployment adds a reverse proxy, review the deployment security
configuration before enabling proxy trust. Specify only the trusted proxy hops
or subnets and verify that clients cannot spoof forwarded address headers.

These limits are deliberate for a local vertical slice. The live-service policies
that would replace them are batched in [17.4](17.4-live-service.md), and the
boundaries that would have to exist first are in [41](41-roadmap.md).
