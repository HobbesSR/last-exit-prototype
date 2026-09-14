import { createGame, joinGame, setInput, step, snapshot, playerView } from '../shared/simulation.ts';
import { resetInput } from '../shared/simulation/input.ts';
import { viewLagFrom } from '../shared/simulation/rewind.ts';

const identity = p => p && ({ id: p.id, name: p.name, role: p.role, kit: p.kit });

// The application's only mutable access to simulation. Returned frames/commands are detached.
export function createMatch(seed) {
  const game = createGame(seed);
  return {
    get tick() { return game.tick; },
    get phase() { return game.phase; },
    get seed() { return game.seed; },
    // Compatibility escape hatch for existing scenario/benchmark tools, not application code.
    get diagnosticState() { return game; },
    roster: () => game.players.filter(p => !p.bot).map(identity),
    player: id => identity(game.players.find(p => p.id === id)),
    preferredRole(preference) {
      const open = role => game.players.some(p => p.bot && p.status === 'active' && p.role === role);
      if (['contestant', 'gladiator'].includes(preference) && open(preference)) return preference;
      const roles = ['contestant', 'gladiator'].filter(open);
      return roles.sort((a, b) => game.players.filter(p => p.role === a && !p.bot).length / (a === 'contestant' ? 8 : 2)
        - game.players.filter(p => p.role === b && !p.bot).length / (b === 'contestant' ? 8 : 2))[0];
    },
    join: (id, role, kit, name) => identity(joinGame(game, id, role, kit, name)),
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
