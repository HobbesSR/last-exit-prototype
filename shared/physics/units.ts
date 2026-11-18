/**
 * World units per engine metre: the one scale between game units and the physics engine's metres (29.1).
 * The adapter (world.ts) converts with it, and the live wire schema (wire-schema.ts) names it so body
 * poses travel as float32 metres (24.1). Engine-free, so neither reader loads Rapier for it (#1187).
 */
export const UNITS_PER_METRE = 40;
