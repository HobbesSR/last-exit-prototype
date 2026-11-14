# Controls, Replays, and Diagnostics

Up: [README.md](README.md). Match rules and tuning defaults live in [docs/14-match-rules.md](docs/14-match-rules.md); visibility and spectator rules live in [docs/15-information-rules.md](docs/15-information-rules.md) and [docs/24-networking-privacy.md](docs/24-networking-privacy.md).

## Match Controls

| Action | Keyboard and mouse | Touch |
| --- | --- | --- |
| Move | `WASD` or arrow keys | Left virtual stick |
| Aim | Mouse pointer | Right virtual stick |
| Fire / melee / use selected item | Hold left mouse button | Deflect right stick |
| Select equipment slot | `1` to `6` | Slot buttons |
| Move / merge item | Drag between slots, or `M` then destination `1`–`6` | Drag between slots, or **Move / merge** then destination slot |
| Drop equipment | Drag a slot onto the arena canvas, or `G` for selected slot | Drag a slot onto the arena canvas, or **Drop selected** |
| Reload (`content-ammo-1` only) | `R` | **Reload** button |
| Drop reserve ammo (`content-ammo-1` only) | Click a reserve chip | Tap a reserve chip |
| Gladiator kit ability | `Q` | **Ability** button |
| Interact (door / charge cell / extract / transit) | `E` (or click a destination ring in `content-10`+) | **Hand** button (or tap a destination ring) |
| Sneak | Hold `Shift` | Hold **Stealth** (footprints) button |
| Fullscreen | `F` | Fullscreen button |
| Toggle In-Match Dev View (`npm run dev`) | `` ` `` (backquote) or top-bar telescope button | Top-bar telescope button |
| Toggle Profiler Overlay | `P` (or append `?profile=1`) | Append `?profile=1` |
| Flag lag in the replay | `B` or top-bar flag button | Top-bar flag button |

### Inventory Gestures

Drag an occupied slot at least eight pixels to another slot to move, swap, or merge it (medkits and shields stack up to three; weapons and power cells take one slot each). Select a medkit or shield, then use the fire input to consume it. Releasing a dragged slot over the arena canvas drops that item beside your character with a one-second self-pickup delay. Pressing `E` near ground loot when all six slots are full swaps the ground item into your selected slot.

## Spectating and In-Match Dev View

- **Directed Spectator View:** The developer/presenter hook `window.arenaSpectate()` in the browser console joins the current room using its owner key, opening an unfogged directed view delayed by 60 simulation ticks (3 seconds) without enabling dev-tool manipulation ([24](docs/24-networking-privacy.md)). The client has no spectator admission button; use the hook from a room-owner session.
- **In-Match Dev View (`--dev-tools=all|owner`):** Press `` ` `` (backquote) or click the telescope button in the top bar (or open `?room=<id>&dev`) to step into an undelayed, unfogged whole-arena overview:
  - Drag or use `WASD` to pan; scroll the mouse wheel to zoom (`0` resets to the whole arena).
  - Click any player or bot to follow them in their own sight (`V` toggles their fog of war; `Esc` stops following).
  - Press `T` to teleport the followed actor to the cursor, or `Space` to pause and resume the room.

## Replays

Completed matches are recorded to compressed archives under `replays/` ([docs/26-recording-contract.md](docs/26-recording-contract.md)). Click the **Replays** (clapperboard) button in the top bar to browse and play saved matches; the room creator can also end a live match early to save immediately.

- Playback supports pause/resume, timeline scrubbing, playback speed selection, actor follow with fog toggles, diagnostic event pips along the timeline, and raw archive download.
- Recording is bounded so storage backpressure never stalls live gameplay; any omitted frames are marked as gaps during playback.

## Performance Diagnostics

If a live match stutters:

1. Press `P` while the slowdown is happening to open the live profiler overlay, and keep playing for at least ten seconds while it is slow.
2. Press `B` or the top-bar flag button at its worst to add a manual marker to the replay.
3. While it is still slow, open **Replays → Download performance diagnostics** to save a sanitized JSON report of recent frame times, packet arrival gaps, viewport metrics, renderer state, and actor counts. End the match, then save and download its replay too.

See [docs/42.2-runtime-performance.md](docs/42.2-runtime-performance.md#capture-procedure) for the full capture procedure and [docs/31.2-benchmarks-and-timing-tools.md](docs/31.2-benchmarks-and-timing-tools.md) for headless and browser benchmark commands (`npm run bench`, `npm run bench:client`).
