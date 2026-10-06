import { createGame, joinGame, setInput, step, snapshot, playerView } from '../shared/simulation.ts';
import { resetInput } from '../shared/simulation/input.ts';
import { changeSeat } from '../shared/simulation/state.ts';
import { viewLagFrom } from '../shared/simulation/rewind.ts';
import { teleport } from '../shared/simulation/dev.ts';
import { generateLiveMap } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';

const identity = p => p && ({ id: p.id, name: p.name, role: p.role, kit: p.kit });

// Who holds which place, over any game's roster: the match's own, or a lobby's before its map exists.
function seatsOf(game) {
  const capacity = role => role === 'gladiator' ? game.content.roster.gladiators.length : game.content.roster.contestants.length;
  // A place is open while a bot holds it, for a joining player to take over.
  const openPlaces = role => game.players.filter(p => p.bot && p.status === 'active' && p.role === role).length;
  const seats = {
    /** Whether this match's content offers a kit, rather than whatever the process happens to ship. */
    hasKit: kit => Object.hasOwn(game.content.kits, kit),
    /** How many of a role a match holds, counted from the roster rather than repeated as a number. */
    capacity,
    roster: () => game.players.filter(p => !p.bot).map(identity),
    player: id => identity(game.players.find(p => p.id === id)),
    openPlaces,
    preferredRole(preference) {
      const open = role => openPlaces(role) > 0;
      if (['contestant', 'gladiator'].includes(preference) && open(preference)) return preference;
      const roles = ['contestant', 'gladiator'].filter(open);
      const share = role => game.players.filter(p => p.role === role && !p.bot).length / capacity(role);
      return roles.sort((a, b) => share(a) - share(b))[0];
    },
    join: (id, role, kit, name) => identity(joinGame(game, id, role, kit, name)),
    /** A joined player's change of role or kit before the start (#235), or null when that role is full. */
    choose: (id, role, kit) => identity(changeSeat(game, id, role, kit)),
    resume(id) {
      const p = game.players.find(p => p.id === id);
      if (!p) return null;
      p.bot = false; resetInput(p); delete p.viewLagTicks; p.path = [];
      return identity(p);
    },
    leave(id) {
      const p = game.players.find(p => p.id === id);
      if (!p) return false;
      // The queue goes with the player. A bot never spends it, so leaving it in place would ride
      // along in every snapshot and recorded frame until the slot was resumed.
      // A bot sees the world directly and is compensated for nothing.
      p.bot = true; resetInput(p); delete p.viewLagTicks; return true;
    },
    /**
     * Take the seats a lobby gave out before this match existed, by replaying its recorded roster
     * commands in order: joining takes no randomness, so the result is what live joins would have left.
     */
    seat(commands) {
      for (const c of commands) {
        if (c.type === 'join') seats.join(c.id, c.role, c.kit, c.name);
        else if (c.type === 'resume') seats.resume(c.id);
        else if (c.type === 'choose') seats.choose(c.id, c.role, c.kit);
        else if (c.type === 'leave') seats.leave(c.id);
      }
    }
  };
  return seats;
}

// A map with no places on it. A lobby's game exists only for its roster, which createGame builds from
// content alone; positions come from the map and are never read before the real match takes over.
const NOWHERE = { spawns: [], stations: [], exit: { x: 0, y: 0 } };

/**
 * The seats of a room whose map is still being generated (#258): the same roster the match will have,
 * from the same content, with no simulation behind it. The room hands its commands to the match's `seat`.
 */
export function createLobby(content = defaultContent()) {
  return { content, ...seatsOf(createGame(0, NOWHERE, content)) };
}

// The application's only mutable access to simulation. Returned frames/commands are detached.
// `map` is the same seed and size already generated elsewhere (the room service's worker, #253).
export function createMatch(seed, size, map, content = defaultContent()) {
  const game = createGame(seed, map ?? generateLiveMap(seed, content, size), content);
  return {
    get tick() { return game.tick; },
    get phase() { return game.phase; },
    get seed() { return game.seed; },
    /** Which content set this match was pinned to, for the recording header to name. */
    get contentId() { return game.content.id; },
    ...seatsOf(game),
    // Compatibility escape hatch for existing scenario/benchmark tools, not application code.
    get diagnosticState() { return game; },
    acceptInput(id, command) {
      // The recording carries the input exactly as it was queued, not whichever one a tick has most
      // recently spent: those are no longer the same thing.
      const accepted = setInput(game, id, command);
      if (!accepted) return null;
      return { type: 'input', id, input: structuredClone(accepted), seq: command.seq };
    },
    /**
     * Tell the simulation how far behind this player's view runs, from a round trip the server
     * measured itself. The conversion belongs to the simulation, which owns how much rewind it will
     * grant; the application only reports what it observed.
     */
    setViewLag(id, roundTripMs) {
      const p = game.players.find(p => p.id === id);
      if (!p) return false;
      const ticks = viewLagFrom(roundTripMs);
      // Absent rather than zero when there is nothing to compensate, so a player with no measured
      // latency carries no trace of the mechanism into snapshots or recordings.
      if (ticks > 0) p.viewLagTicks = ticks; else delete p.viewLagTicks;
      return true;
    },
    /** A dev teleport (24), as the command the recording keeps, or null when refused. */
    teleport(id, x, y) {
      const at = teleport(game, id, x, y);
      return at && { type: 'teleport', id, ...at };
    },
    advance() { step(game); return snapshot(game); },
    snapshot: () => snapshot(game),
    project: (frame, id) => playerView(game, frame, id),
    map: () => structuredClone(game.map),
    liveMap: () => structuredClone({ ...game.map, traps: [] }),
    spectatorMap: frame => structuredClone({ ...game.map, gates: frame.gates, items: frame.items, traps: [] }),
    end({ strand = false } = {}) {
      game.phase = 'finished';
      if (strand) for (const p of game.players) if (p.role === 'contestant' && p.status === 'active') p.status = 'stranded';
    },
    result: () => ({ ticks: game.tick, escaped: game.players.filter(p => p.status === 'escaped').length })
  };
}
