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

Everyone but the viewer is drawn from a receive buffer rather than from the newest frame. `public/snapshot-buffer.js` keeps recent authoritative frames and reads them back at a playhead held two ticks behind the newest arrival, interpolating position and heading between the two frames that bracket it. Frames do not arrive evenly — the loop wakes on a coarser granularity than a tick, a catch-up batch collapses several ticks into one payload, and the network adds its own jitter — so a renderer that eases toward the newest position turns every one of those into a velocity spike, and does it at a rate that changes with frame rate. Paying a fixed 100 ms instead buys motion as smooth as the path the simulation actually took. The viewer's own player does not pay it, because that one is predicted forward from unacknowledged input instead.

Drift between the playhead and its target is taken out by dilating time by at most ±15%, never by moving the playhead, because moving it is the discontinuity the buffer exists to remove. A gap larger than ten ticks is not drift but a different position entirely — a join, a resumed tab, a replay closing back to a live match — so it cuts, and drops the history before it rather than interpolating across it. Running past the newest frame holds the last state rather than extrapolating: inventing motion there is what produces a rubber-band when the real state arrives. Discrete state — health, status, cloak — is read from the later of the two frames, so gameplay feedback is not held back by the presentation delay; only position and facing interpolate.

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

The playhead advances against the **wall clock**, anchored at the last jump, not by
accumulating the per-frame delta. Phaser smooths and clamps the delta it reports, so
accumulating it runs a replay slow in exact proportion to how long the client's
frames are: measured here, a viewer rendering at about four frames a second received
roughly six percent of the speed they selected, and the speed control silently
became a fiction. Anchoring also keeps rounding from accumulating across the
thousands of frames a ten-minute match lasts. Every jump — opening a replay,
seeking, resuming, changing speed — must re-anchor, or the elapsed time since the
last anchor is re-scaled by the new rate and the playhead leaps.

Coverage for this must assert an invariant that holds for whatever frames the
browser happens to render. A headless frame is longer than a playback tick at every
supported speed, so a test that assumes a rendered frame lands inside a chosen tick
fails against working code. Elapsed time, by contrast, *is* assertable now that
playback follows it, and must be timed inside the page: driving the clock from the
test counts the driver's own round trips as playback time.

## Replay camera

A directed view — a replay, or a spectator with no player of their own — frames the
whole arena. The arena is 24000 by 12000 units, two orders of magnitude wider than a
player's view, so at that zoom an unscaled contestant covers about three pixels and
the roster is unreadable. Markers are therefore enlarged by the ratio the camera is
zoomed out by, which holds their apparent size steady rather than letting it shrink
with the camera, and never reduces them below life size. Names hold a fixed pixel
height instead of riding that scale, and are authored above their drawn size so the
glyphs are always downscaled. A directed view has no fog to separate the roster by,
so role reads from a ring around each marker instead.

A replay can also be given a subject, chosen from the recorded roster or by clicking
a marker. The camera then follows that player at the zoom they played at, markers
return to life size, and off screen geometry is culled the way it is in a live view.
The subject comes from the recording's roster rather than the displayed frame, so a
player can be chosen before they appear and stays selectable after elimination; when
the current frame does not contain them the camera holds their last position.
Changing subject cuts rather than pans, because gliding across the arena would lose
the subject for seconds. Following does not restore that player's fog: a replay is a
directed view of a completed match, and what the recording holds is already public.
