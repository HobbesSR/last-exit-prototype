# 22. Ownership

Each decision has exactly one owner. Boundary tests enforce the ones that matter;
the rest are conventions this file records so a change lands in the right module.

`shared/shape.ts` owns what a shape is: the rect/circle/polygon description, its bounds, outline, edges, SAT body, containment, overlap and transform. It is a dependency-free leaf, and collision, sight and the renderer all read geometry through it rather than from raw `w`/`h`/`r` fields; see [29](29-geometry-and-drawing.md). `shared/map.ts` exposes map generation and routing. `shared/movement.ts` owns what the simulation does with a shape: occupancy, the movement sweep, sight queries and visibility polygons. `shared/simulation.ts` is the public simulation facade and explicit fixed-tick coordinator. `server/index.js` composes the server and serves static assets. `public/client.js` owns application startup, networking, authoritative state, prediction/reconciliation and lobby flow; `public/replay-controller.js` owns recorded-match playback. `public/snapshot-buffer.js` owns the receive buffer and the delayed, interpolated frame drawn from it, and knows nothing of sockets, Phaser or the scene: frames go in and one interpolated frame comes out, which is the seam a state-sync framework would replace. `client.js` decides which frame the renderer sees — the buffered one live, the replay's own playhead when a recording is open — so the scene draws what it is given rather than deciding what is current. `public/arena-scene.js` renders the world and visibility mask. `public/ui.js` owns the client's shared presentation vocabulary — DOM lookup, tick formatting and kit naming read from the authoritative kit table rather than a transcribed copy.

## Reading guide

| ID | Topic | Read |
| --- | --- | --- |
| 22.1 | Shared simulation | [22.1](22.1-shared-simulation.md) |
| 22.2 | Map generation and live map assembly | [22.2](22.2-map-generation.md) |
| 22.3 | Server | [22.3](22.3-server.md) |
| 22.4 | Client | [22.4](22.4-client.md) |

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
