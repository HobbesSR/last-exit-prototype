import { sightOf } from './sight-runtime.ts';
import type { Game, Gate } from '../types.ts';

// A game's door state is the core's (#1214 stage 6a; 27, "The state flip"). The gate set the core's queries read
// (`shared/sight-core.ts`) holds each door's `open` and `locked` from `createGame` on, and the core's rules write it
// there: phase 6's interactions and the body sync's refused close. The gate records are its mirror. They keep their
// identity and their keys' order, so frames, snapshots and the wire read them as before (`frame-gates.ts`), and the
// change lists' facts are the only writes to them (`writeDoor`). Their door fields are pinned read-only, so a write
// from anywhere else throws at its site rather than leaving the mirror and the core apart.

/** The fields of a gate record that are door state, in the order `interact` writes them. */
const DOOR_FIELDS = ['open', 'locked'] as const;

/** Make the game's gate set the doors' owner, then pin the records' door fields. `createGame` calls it once. */
export function ownDoors(s: Game): void {
  sightOf(s).ownGates(s.map);
  for (const gate of s.gates) for (const key of DOOR_FIELDS) {
    // Kept configurable, so the mirror can write it; an absent `locked` stays absent until a fact creates it.
    if (Object.hasOwn(gate, key)) Object.defineProperty(gate, key, { writable: false });
  }
}

/**
 * The mirror's write of one door field, from a fact the core reported. An existing key keeps its place; an absent one
 * is added last, as an assignment would add it, so a record's key order is what the TypeScript rules left.
 */
export function writeDoor<K extends typeof DOOR_FIELDS[number]>(gate: Gate, key: K, value: Gate[K]): void {
  Object.defineProperty(gate, key, { value, writable: false, enumerable: true, configurable: true });
}

/**
 * A between-tick command (27, D5): set a door's state in the core, then in the mirror, as an interaction writes it
 * (`open`, then `locked`). Tests, tools and labs arrange doors through it; play never calls it. Like a write to the
 * record before stage 6a, it leaves the gate's body to the next synchronization.
 */
export function setDoor(s: Game, index: number, state: { open?: boolean; locked?: boolean }): void {
  const gate = s.gates[index];
  if (!gate) throw new RangeError(`no gate ${index}`);
  const open = state.open ?? gate.open, locked = 'locked' in state ? state.locked : gate.locked;
  sightOf(s).writeGate(s.map, index, open, locked == null ? 0 : locked ? 1 : 2);
  if (state.open !== undefined) writeDoor(gate, 'open', state.open);
  if (state.locked !== undefined) writeDoor(gate, 'locked', state.locked);
}
