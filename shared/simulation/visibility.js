import { lineClear, VISION } from '../movement.js';
import { POTENTIAL_RADIUS, roofConceals } from '../view.js';
import { distance } from './geometry.js';
import { start, stop } from '../profiler.js';
import { DURATION, CELL_CHARGE_TICKS } from './rules.js';
import { frameFields, ownPlayerFields, itemFields, gateFields, trapFields, projectileFields, effectFields, eventFields } from './projection-contract.js';
// The reach the server transmits within. Generous on purpose: it carries everything that could become
// visible before the next update — through cover clearing, a cloak dropping, a scan reveal, or simply
// movement — so the client never has to wait on the server to show something that just became
// observable. The client resolves what is actually seen. The trade is explicit: this radius is also
// what a modified client could see through walls.
export const POTENTIAL = POTENTIAL_RADIUS;
// What the server will send, as opposed to what the viewer can actually see.
export function couldSee(s, viewer, target) {
  if (!viewer || viewer.id === target.id || target.status !== 'active') return true;
  // A reveal makes a contestant visible to gladiators at any range, so it is never distance culled.
  if (viewer.role === 'gladiator' && target.revealed > 0) return true;
  return distance(viewer, target) < POTENTIAL;
}
// True line of sight. This stays authoritative and drives gameplay — bot targeting, ability reach,
// hit resolution — none of which may depend on anything a client says.
export function visibleTo(s, viewer, target) {
  if (!viewer || viewer.id === target.id || target.status !== 'active') return true;
  if (viewer.role === 'gladiator' && target.revealed > 0) return true;
  return !target.cloak && !roofConceals(s.map, viewer, target) && distance(viewer, target) < VISION && lineClear(s.map, viewer, target);
}
// What one client may learn about another player it can currently see. Everything omitted is either
// private (inventory, ability timers, whether a slot is a bot) or unread by the renderer, so it never
// leaves the server for anyone but the player it describes. Recordings keep the full state.
const OBSERVED = ['id', 'role', 'kit', 'name', 'x', 'y', 'heading', 'status', 'hp', 'maxHp', 'shield', 'weapon', 'cloak', 'revealed'];
const observed = p => Object.fromEntries(OBSERVED.map(key => [key, p[key]]));
export function playerView(s, frame, id) {
  start('sim.playerView');
  try { return buildPlayerView(s, frame, id); } finally { stop('sim.playerView'); }
}
// A viewer id that matches no player is a non-player client: it receives the directed view, which is
// unfogged by design. Callers decide who is allowed to ask for one.
function buildPlayerView(s, frame, id) {
  const viewer = frame.players.find(p => p.id === id);
  // Effects are sized, so a wide ring counts as reachable when its edge is, not just its centre.
  const inRange = p => !viewer || distance(viewer, p) < POTENTIAL + (p.radius ?? 0);
  const rest = frameFields(frame); // Replay bookkeeping and unlisted internal fields stay private.
  return { ...rest, duration: DURATION, directed: !viewer, contestantsActive: frame.players.filter(p => p.role === 'contestant' && p.status === 'active').length,
    players: frame.players.filter(p => couldSee(s, viewer, p)).map(p => p.id === id ? ownPlayerFields(p) : observed(p)),
    items: frame.items.filter(inRange).map(itemFields), gates: frame.gates?.map(gateFields),
    traps: (frame.traps || []).filter(inRange).map(trapFields), projectiles: frame.projectiles.filter(inRange).map(projectileFields),
    effects: frame.effects.filter(inRange).map(effectFields), events: frame.events?.map(eventFields) };
}
export function snapshot(s) {
  start('sim.snapshot');
  try { return structuredClone({ version: s.version, duration: DURATION, cellChargeTicks: CELL_CHARGE_TICKS, tick: s.tick, phase: s.phase, rng: s.rng, hazardX: s.hazardX, slots: s.slots, serial: s.serial, players: s.players, items: s.map.items, gates: s.map.gates, traps: s.map.traps, projectiles: s.projectiles, effects: s.effects, events: s.events }); }
  finally { stop('sim.snapshot'); }
}
