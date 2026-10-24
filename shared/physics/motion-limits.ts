// Engine-free motion bounds shared by the adapter and live projection.
export const PHYSICS_SUBSTEP_SECONDS = 0.0125;
export const physicsSpeedLimit = (minimumRadius: number): number =>
  0.8 * Math.min(minimumRadius, 12) / PHYSICS_SUBSTEP_SECONDS;
// The global ceiling is an integer in world units; remove arithmetic roundoff
// from the wire value while retaining the adapter's per-shape arithmetic.
export const MAX_PHYSICS_SPEED = Math.round(physicsSpeedLimit(12));
