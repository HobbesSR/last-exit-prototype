import { viewSourceOf } from '../../shared/simulation/view-source.ts';
import { createGame, disposePhysics, setInput, stateOf, step } from '../../shared/simulation.ts';
import { createDiscovery, discoveryGrid } from '../../shared/discovery.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { openField } from './arena.js';
import { identifyItems } from './item-identity.js';

// The scenario layer over test arenas (31 "Test arenas", #697): put chosen actors on an arena, give them
// chosen knowledge, script events per tick, and run.

/**
 * The content and map for `actors` (`{ role, kit?, x, y }`, in any order): the roster holds one place per
 * actor and the map spawns each where it says. Returns them with a `place` that finds each actor's player.
 */
function cast(map, content, actors) {
  const contestants = actors.filter(a => a.role === 'contestant'), gladiators = actors.filter(a => a.role === 'gladiator');
  const roster = { contestants: contestants.map((_, i) => `C${i}`), gladiators: gladiators.map((a, i) => ({ name: `G${i}`, kit: a.kit ?? 'warden' })) };
  map.spawns = contestants.map(({ x, y }) => ({ x, y }));
  map.hunterSpawns = gladiators.map(({ x, y }) => ({ x, y }));
  // A roster place's id is its role's initial and its index in the role (state.ts).
  const id = a => a.role === 'contestant' ? `c${contestants.indexOf(a)}` : `g${gladiators.indexOf(a)}`;
  return { content: { ...content, roster }, place: s => actors.map(a => s.players.find(p => p.id === id(a))) };
}

function settle(s, actors, players) {
  actors.forEach((a, i) => { players[i].bot = a.bot ?? true; if (a.knows) know(s, players[i], a.knows); });
  return { s, players };
}

/**
 * `p`'s record as of the last completed tick (docs/27.2 "Test API"). A started game's players are the roster and the
 * arrangement, not the match: read what the match did here, by roster place, and arrange mid-match through commands.
 */
export const now = (s, p) => stateOf(s).players[s.players.indexOf(p)];
/** The discovery cells `p` has discovered: the knowledge cache's once started (27.2 "Projection and knowledge"), else as arranged. */
export const discoveredBy = (s, p) => { const v = viewSourceOf(s); return v.knowledge.discovered(v.slotOf(p.id)) ?? new Set(); };
/** The cues `p` hears that last past the game's tick, read as `discoveredBy` reads. */
export const hears = (s, p) => { const v = viewSourceOf(s); return v.knowledge.heard(v.slotOf(p.id), s.tick); };

/** A physics game on `map` with exactly `actors`, each a bot unless `bot: false`; the shipped content unless given. Dispose of it with `disposePhysics`. */
export async function stagePhysics(map, { seed = 4217, content = defaultContent(), actors }) {
  const { content: cast_, place } = cast(map, content, actors), s = await createGame(seed, map, cast_);
  return settle(s, actors, place(s));
}

/**
 * Replace what `p` knows for planning: `'everything'` surveys every discovery cell; otherwise `surveyed` (cell
 * indices) and remembered `gates` (id → `{ open, locked }`), nothing else, so by default nothing at all. Sight is
 * not staged: no cell is `discovered` or `seen`, and no item remembered, until the game's own sampling adds them.
 * Arrange it before the start: the core's setup takes `p.knows` (27.2 "Test API"). `p.discovery` is the retained
 * TypeScript planner's copy, for its unit tests until #1358 retires them.
 */
export function know(s, p, knows = {}) {
  const { surveyed = new Set(), gates = new Map() } = knows === 'everything' ? { surveyed: everywhere(s.map) } : knows;
  p.knows = { surveyed, gates };
  p.discovery = { ...createDiscovery(), surveyed, gates };
}

/** Every discovery cell of `map`. */
export function everywhere(map) {
  const { cols, rows } = discoveryGrid(map);
  return new Set(Array.from({ length: cols * rows }, (_, i) => i));
}

/**
 * Step `s` up to `ticks` times. Before each tick, every event whose `every` (default 1, every tick) divides the
 * ticks since `from` (default 0) acts, while `s.tick < until` if given. Returns the tick on which `done(s)` first held after a
 * step, or null; `trace(s)`, when given, is called after every step.
 */
export function run(s, { ticks, events = [], done, trace }) {
  for (let i = 0; i < ticks; i++) {
    for (const { every = 1, from = 0, until = Infinity, act } of events)
      if (s.tick >= from && s.tick < until && (s.tick - from) % every === 0) act(s);
    step(s);
    trace?.(s);
    if (done?.(s)) return s.tick;
  }
  return null;
}

/**
 * A gunfight at distance `distance` (#697, 42.22): on open ground, one gladiator bot and a scripted
 * contestant `distance` east of it firing `weapon` every `every` ticks until tick `until`. The exit is
 * behind the gladiator, so patrol leads away from the fight. Transit stations stand at `stations`, x offsets
 * from the gladiator along its row. Returns the tick the gladiator came within 400 of the shooter, or null
 * within `ticks`.
 */
export async function gunfight(distance, { content, weapon = 'pistol', every = 20, until, ticks = 3000, scatter, stations = [] } = {}) {
  const { map } = openField(distance + 1200, { scatter, exit: { x: 96, y: 576 },
    stations: stations.map((dx, i) => ({ id: `st${i}`, nodeId: `n${i}`, x: 600 + dx, y: 576 })) });
  const y = map.height / 2, at = { x: 600 + distance, y };
  const { s, players: [g, shooter] } = await stagePhysics(map, { content,
    actors: [{ role: 'gladiator', x: 600, y }, { role: 'contestant', bot: false, ...at }] });
  shooter.inventory[0] = { kind: 'weapon', weaponType: weapon, ammo: s.content.weapons[weapon].ammo,
    instanceId: 'gunfight-weapon', lineageId: 'gunfight-weapon' };
  identifyItems(s);
  try {
    return run(s, { ticks, events: [{ every, until, act: s => setInput(s, shooter.id, { seq: s.tick + 1, attack: true, aim: 0 }) }],
      done: () => { const here = now(s, g); return Math.hypot(here.x - at.x, here.y - at.y) < 400; } });
  } finally { disposePhysics(s); }
}
