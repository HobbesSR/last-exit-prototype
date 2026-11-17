# 23. Types

`shared/` is TypeScript. Nothing is compiled to an output directory: Node erases the types as it loads a module, and `server/shared-assets.js` does the same per request for the browser, so the client runs the same source the server does. `tsconfig.json` sets `erasableSyntaxOnly`, which is what keeps that arrangement honest — enums, namespaces and parameter properties are rejected, so every annotation really is whitespace at runtime. Erasure preserves line and column positions, so a browser stack trace still points at the real source line and there is no source map to maintain. Type checking is `npm run typecheck`, never a step between editing a file and running it.

`shared/types.ts` is the single vocabulary. The branding policy there is deliberate and asymmetric, because a brand costs a cast wherever a value is built. Identifiers are branded: one cast where each is minted separates identity domains. `ItemId` is a positive match-local number (zero is reserved); `ItemLabel` retains artifact and legacy boundary strings. `GateId` and `PlayerId` retain legacy labels at artifact, connection and compatibility boundaries; dense runtime relations use `GateIdx` and `PlayerIdx`. Tile coordinates were branded while the navigation grid lived in `shared/`; that branding moved to `map/tools/route.ts` with the grid. World coordinates and tick counts are plain named aliases: they are combined arithmetically on nearly every line, so branding them would demand a cast per expression and buy less than the named field and parameter types already do.

Closed vocabularies are literal unions rather than `string`, and carried items are a discriminated union so `ammo`, `charge` and `count` cannot be read off an item that has no such field. Collision and routing take the narrow map views they actually read, not the whole map, because they run during generation before the map is complete.

The relational migration ([24.4](24.4-relational-data-model.md), #1147) introduces
zero-cost numeric brands `PlayerIdx` and `GateIdx` for dense match-local array slots.
Connection and map-artifact labels remain strings; projected relations are numeric. The item portion (#1150) uses numeric `ItemId` for ground items, inventory identities/lineage, reloads, discovery and item launch associations. `GameMap<ItemLabel>` describes artifact input, `Game.map` holds `GameMap<ItemId>`, and `Snapshot` defaults to numeric `ItemId`; generic item/player records keep these boundaries checked. Immutable publications preserve frame sharing without converting numeric records to legacy labels.
`shared/enum-tables.ts` declares frozen vocabulary order explicitly; content display
descriptors and equipped weapon codes use that order rather than object insertion order.

`erasableSyntaxOnly` and `exactOptionalPropertyTypes` are on; `noUncheckedIndexedAccess` is not. Enabling it is worthwhile and is deliberately left as separate work: this codebase indexes arrays constantly, and the change belongs in a pass that can consider each site rather than one that sprays assertions.

The original conversion covered `shared/` only. `npm run typecheck` now checks two configurations: the root `tsconfig.json` (`shared/`, `map/micro/`, `map/kernel/` and the top-level `map/*.ts`), and `map/tools/tsconfig.json` (the tools, and what they import). `map/macro/` typechecks in its own `npm test`. `server/`, `public/` and `tests/` remain JavaScript and are not type checked; they import the shared modules by their `.ts` specifiers, which Node and the asset route both resolve.

The player/gate slice (#1151) uses `PlayerIdx` for hooks, dense rewind history,
tick intents and bot scheduling. Runtime `HookState` is distinct from captured
`LegacyHookState`; the physics capture adapter preserves legacy labels/order.
Gate physics state is indexed by canonical `GateIdx`, even when native body
admission traverses those slots in legacy label order. The outward switch is implemented by #1153.

The body/prop/tether slice (#1152) adds numeric `BodyId`, `PropId` and `TetherId`.
Internal presentation bodies use a discriminated `PhysicsBodyOwner` union, keeping
player slots, item identities and prop identities in separate domains. Body IDs key
opaque admission lifetimes rather than generations; hook tether IDs follow logical
flight lifetimes across backend constraint replacement. Snapshots, live views and recordings now use these numeric presentation types.
Private PhysicsWorld state retains deterministic string keys; legacy archives are
normalized only by the playback display boundary in Checkpoint 2 ([24.4](24.4-relational-data-model.md)).
