# P0 lab contract (not a production API)

All values are world units, seconds, radians and mass units. Tick is .05 s;
the runner calls `step(.05/substeps)` 2/4/8 times and inspects every substep.
No Node imports in adapters: the same module runs in Chrome.

`createWorld(scene, options={})` returns a world (Rapier may be async).
Scene: `{bodies:[], joints:[]}`. Body: `{id, kind:'actor'|'prop'|'loot'|'static',
x,y, shape:'circle'|'box', radius?,hx?,hy?, angle?,vx?,vy?,omega?,mass?,
friction?,restitution?,drag?, motor?:{x,y,accel}, sleeping?}`.
Defaults: circle radius 8; mass 1; zero velocities/angle/drag/friction/restitution;
drag is constant speed deceleration in world units/s², applied before motor.
actor locks rotation. Static boxes use centre and half extents. Loot contacts
statics only. Actor/prop contact each other and statics. IDs unique strings.
Joint: `{id,kind:'spring'|'rope',a,b,length,stiffness?,damping?,maxForce?,backend?}`;
centre anchors initially, default stiffness 20, damping 4, maxForce 10000.
Ropes use predictive velocity impulses, bounded by maxForce * dt; spring
stiffness/damping do not apply to rope. Springs use explicit Hooke/damping forces.
`backend:'native'` selects a Rapier centre-anchor spring instead. It is uncapped:
omitting maxForce (or passing Infinity) is required, and a finite cap is rejected.
This evaluates stability for later jelly/squish (#455), not a force-limited hook.
Default game-owned springs/ropes retain their old policy. Native joint handles
are private and included in exact lab checkpoint continuation.
Options/settings are exposed as `world.settings`; report any unsupported feature.

The #451 suite uses 40 units/metre and a 24-unit speculative contact distance
(`normalizedPredictionDistance:0.6`), with otherwise unchanged Rapier settings.
`admitMotion` is a **lab initial-velocity admission check**, not a production
speed limiter: cap = `0.8*min(minimumRadius,12)/substepSeconds`. Boxes use their
smaller half extent. Above-cap witnesses are refused before any step; they
require a swept query or explicit teleport contract. P1 must validate the entire
substep's movement after motors, forces, impulses and constraints; this helper
does not establish that integration. Angular sweep remains independently tested.

Methods (synchronous after initialization):
- `step(dt)` applies bounded velocity-target motor acceleration and linear floor
  drag, springs/ropes, then contact; does not overwrite external velocity.
- `states()` returns ID-sorted copies of body descriptors plus current
  `{x,y,vx,vy,angle,omega,sleeping}` (statics included).
- `addBody(body)`, `removeBody(id)` (also removes attached joints),
  `addJoint(joint)`, `removeJoint(id)`.
- `motor(id, {x,y,accel})`; `impulse(id,{x,y})` in mass*worldUnits/s.
- `checkpoint()`; `restore(checkpoint)` replace same world's state including
  motor metadata. Checkpoints opaque, used only within same adapter/runtime.
- `cast({x,y,dx,dy,radius,exclude?})`: earliest swept-circle hit across a
  displacement; return `{id,toi}` in [0,1] or null, statics and props/actors,
  loot excluded, stable ID on equal time. Report approximations explicitly.
- `dispose()` idempotent; methods after disposal throw; `counts()` returns
  `{bodies,joints}` (zero after disposal).

Unsupported cases must be visible in settings/report, never silently skipped.
Fixtures intentionally include invalid coincident placement as a stress probe;
report initial overlaps separately from penetration arising from legal starts.
