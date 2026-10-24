import { canOccupy, moveBody } from '../shared/movement.ts';
import { GATE_REACH } from '../shared/simulation/rules.ts';

/**
 * The developer labs' walker: held keys to a move, stepped every 50 ms, and E toggling the
 * nearest gate. Each page keeps its own lifecycle (which keys it listens to, when keys clear).
 * Imports are relative, so Node tests load it too; from `/lab-walk.js` they reach `/shared`.
 */
export const MOVEMENT_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];

/** The move the held `keys` ask for, each axis -1, 0 or 1. */
export function keyIntent(keys) {
  return { x: (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0),
    y: (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) };
}

/**
 * Steps a walker every 50 ms while `keys` ask for a move. `walking()` gives `{ map, body, radius }`
 * or null when nothing walks; `moved()` runs after each step.
 */
export function walkWithKeys(keys, walking, moved) {
  return setInterval(() => {
    const walk = walking(), input = keyIntent(keys);
    if (!walk || (!input.x && !input.y)) return;
    moveBody(walk.map, walk.body, input, walk.radius, walk.body.role === 'gladiator' ? 8 : 9);
    moved();
  }, 50);
}

/**
 * Opens or closes the gate nearest `body` within reach, refusing to close one on it. Returns
 * the status to show, or null when no gate is in reach.
 */
export function toggleNearbyGate(map, body, radius) {
  const distance = gate => Math.hypot(gate.x - body.x, gate.y - body.y);
  const gate = map.gates.filter(g => distance(g) < GATE_REACH).sort((a, b) => distance(a) - distance(b))[0];
  if (!gate) return null;
  if (gate.open) {
    const closed = { ...map, gates: map.gates.map(g => g === gate ? { ...g, open: false } : g) };
    if (!canOccupy(closed, body.x, body.y, radius)) return 'Cannot close a gate on the walker.';
  }
  gate.open = !gate.open;
  return `${gate.open ? 'Opened' : 'Closed'} nearby gate.`;
}
