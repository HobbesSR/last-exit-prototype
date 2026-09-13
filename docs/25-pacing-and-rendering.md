# 25. Pacing and rendering

## Authoritative pacing

The room loop paces itself against real time rather than against the timer. Platform timer granularity
is coarser than a tick — about 15.6 ms on Windows, which rounds a bare 50 ms interval up to 62.5 ms and
silently ran the match at 16 Hz — so the loop wakes several times per tick and advances each room by the
whole ticks that elapsed real time has earned, capped per wake so a stall cannot spiral into a burst.
Every simulated tick is offered to the recorder; a catch-up batch sends only its newest snapshot. Tick spacing
therefore jitters by the wake granularity while the tick rate itself stays correct, which is what the
match clock and every tick-denominated constant depend on. Gameplay rates are expressed in ticks, so
changing `HZ` means rescaling them together; finer integration for a future physics system belongs in
substeps inside a tick rather than in a faster authoritative rate.

## Presentation smoothing

Presentation smoothing is separate from simulation rate and belongs entirely to the client. Camera, own sprite, fog and cover all read one eased eye position rather than easing independently, because a fog polygon sampled at the raw predicted position while the camera eased toward it led the world by the easing lag and stepped at the input tick. Anything that only moves on an authoritative frame — projectiles, effect rings — is advanced by the elapsed fraction of a tick, since drawing it at the last received position makes 20 Hz motion visibly step at frame rate. The visibility polygon culls each segment to the angular wedge its endpoints subtend and sweeps those wedges in ray order, which is an exact optimisation, not an approximation, and is tested as such.

Terrain, structures, gates, sensors and the hazard band are drawn everywhere and dimmed where they fall outside sight, so the arena stays readable and out of sight cover appears shadowed rather than absent. Actors, loot, shots and effects are withheld instead, and draw above the shade so anything in view reads at full brightness. Per entity visibility reuses the visibility polygon the fog is already drawn from — a log time query against its angle sorted vertices — so what is drawn and what is lit can never disagree, and no extra rays are cast.

## Replay playback timing

The render playhead is continuous. A rendered frame is somewhere inside an
authoritative tick, not on one, so the playhead retains its fraction at every
playback speed and only frame lookup floors to a tick. Rounding the stored playhead
loses elapsed time, and rejecting a fractional query freezes displayed playback.
Presentation alpha is zero wherever the shown frame is not the playhead's own tick —
leading gaps, omitted intervals and incomplete tails — because interpolating there
would invent motion the recording never contained. See
[26](26-recording-contract.md).

Coverage for this must assert an invariant that holds for whatever frames the
browser happens to render. A headless frame is longer than a playback tick at every
supported speed, so a test that assumes a rendered frame lands inside a chosen tick
fails against working code.
