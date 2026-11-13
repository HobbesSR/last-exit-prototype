# 22. Ownership

Each decision has exactly one owner. Boundary tests enforce the ones that matter;
the rest are conventions this file records so a change lands in the right module.

`shared/shape.ts` owns what a shape is: the rect/circle/polygon description, its bounds, outline, edges, SAT body, containment, overlap and transform. It is a dependency-free leaf, and collision, sight and the renderer all read geometry through it rather than from raw `w`/`h`/`r` fields; see [29](29-geometry-and-drawing.md). `shared/free-space.ts` is the shape module's derived free-space index: each region's ground outside those outlines, eroded by a body's clearance and triangulated, with its corridors and funnel paths ([22.6.1](22.6.1-portal-graph-and-mesh.md#bottom-level-free-space-triangulation)); it keeps `shape.ts` a leaf by depending on it, never the reverse. `shared/shape-construction.ts` owns building shapes from shapes: union, subtraction and intersection on the clipper's integer grid, the breakdown into disjoint convex pieces, and the constrained triangulation of integer rings that the free-space index shares ([29.3](29.3-shape-construction-and-assembly.md#shape-construction)). It depends on `shape.ts` too. `shared/map.ts` exposes the world size; maps come from the generation chain (`map/live.ts`). `shared/movement.ts` owns what the simulation does with a shape: occupancy, the movement sweep, sight queries and visibility polygons. `shared/simulation.ts` is the public simulation facade and explicit fixed-tick coordinator. `server/index.js` composes the server and serves static assets. `shared/frame-layers.ts` owns how a live frame's slow-changing layers travel, keyframes and change sets, encoded on the server and decoded per socket on the client ([24](24-networking-privacy.md#layered-frames)). `public/client.js` owns application startup, networking, authoritative state, prediction/reconciliation and lobby flow; `public/replay-controller.js` owns recorded-match playback. `public/snapshot-buffer.js` owns the receive buffer and the delayed, interpolated frame drawn from it, and knows nothing of sockets, Phaser or the scene: frames go in and one interpolated frame comes out, which is the seam a state-sync framework would replace. `client.js` decides which frame the renderer sees — the buffered one live, the replay's own playhead when a recording is open — so the scene draws what it is given rather than deciding what is current. `public/arena-scene.js` is the Phaser scene: camera and eye, sight and the visibility mask, actors, and the order the frame's layers draw in. `public/static-drawing.js` draws the map into `public/tile-cache.js`, which bakes recorded drawings into tiles and knows nothing of maps; `public/frame-drawing.js` draws the per-frame layers ([29.4](29.4-drawing.md#drawing)). `public/ui.js` owns the client's shared presentation vocabulary — DOM lookup, tick formatting and kit naming read from the authoritative kit table rather than a transcribed copy.

## Scope

22.1 to 22.5 record ownership of code that exists. They name modules that own a
contract or sit on a boundary; a module they don't name belongs to its
directory's part (`shared/` simulation to 22.1, `map/` to 22.2, `server/` to
22.3, `public/` to 22.4), owns what its own header says, and changes nothing a
named owner decides. Smaller owners that the parts don't list:

- `shared/equipment.ts` owns the default weapon table, slot count and inventory
  item operations; a match reads its pinned copy (22.1, "content").
- `shared/traps.ts` owns trap and hazard effects, with damage and effects
  injected so it stays a leaf.
- `shared/profiler.ts` owns the off-by-default sampling profiler shared by the
  server loop, the bench and the client ([21](21-stack.md), [24](24-networking-privacy.md)).
- `public/diagnostics.js` owns the client's bounded timing sample and its
  downloadable performance report (17.3 #8).
- `public/equipment-ui.js` owns equipment glyphs; `public/replay-timeline.js`
  owns the replay timeline and its diagnostic markers, which it treats as
  untrusted file content; `public/sat-browser.js` hands the browser the global
  SAT build.
- `public/dev/dev-nav.js` and `.css` own the developer tools' shared navigation
  bar, and `public/lab-walk.js` the labs' walker keys and gate toggle
  ([20.5](20.5-tools-and-next-boundaries.md)). They are DOM-only, so they sit
  outside the portable core.

22.6 records #353, closed 2026-10-25: bots plan over the free-space tiles (adopted in
`content-3` and carried forward with sliced replanning and local repair in `content-6`/`content-7`; #920 retired `content-1`–`5`), and default `content-7` uses the portal graph (#420) for gladiator legs (#682). 22.7, designed for #385, was implemented in #386. Their numbers sit in this
range because they concern ownership, and numbers never change (33).

## Reading guide

Physics design/gameplay contracts and tick/prediction/replay contracts live in
[29.1](29.1-physics-design.md) and [29.2](29.2-physics-state-networking.md);
physics is required on every match (#920, #975, #976) alongside the module owners
recorded in [22.1](22.1-shared-simulation.md).

| ID | Topic | Read |
| --- | --- | --- |
| 22.1 | Shared simulation | [22.1](22.1-shared-simulation.md) |
| 22.2 | Map generation and live map assembly | [22.2](22.2-map-generation.md) |
| 22.3 | Server | [22.3](22.3-server.md) |
| 22.4 | Client | [22.4](22.4-client.md) |
| 22.5 | Lobbies, matchmaking and rooms: the design for #237, what each part owns and the stages | [22.5](22.5-lobbies-and-matchmaking.md) |
| 22.6 | Hierarchical navigation (#353): a free-space mesh and the knowledge tiles bots plan over (standard since #920), plus gladiator portal-graph legs (`content-7`, #682); private map knowledge and optimistic bot planning; load the relevant 22.6.x part | [22.6](22.6-hierarchical-navigation.md) |
| 22.7 | Content/presentation metadata, client configuration, compatibility defaults and shared-rule ownership (#385; implemented in #386) | [22.7](22.7-content-and-presentation.md) |
| 22.8 | Development tools: one core with lab, CLI and MCP faces, state documents and links, the in-page handle, pictures; appearance tools (#772, design) | [22.8](22.8-development-tools.md) |

## Earlier heading links

These links preserve bookmarks into the former single file.

<a id="shared-simulation"></a>

- Shared simulation: [Shared simulation](22.1-shared-simulation.md#shared-simulation).

<a id="map-generation"></a>

- Map generation: [Map generation](22.2-map-generation.md#map-generation).

<a id="server"></a>

- Server: [Server](22.3-server.md#server).

<a id="client"></a>

- Client: [Client](22.4-client.md#client).

<a id="live-map-assembly"></a>

- Live map assembly: [Live map assembly](22.2-map-generation.md#live-map-assembly).
