import { createGame, joinGame, setInput, step, snapshot, playerView } from '../shared/simulation.js';

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
      p.bot = false; p.input = {}; p.lastSeq = -1; p.path = [];
      return identity(p);
    },
    leave(id) {
      const p = game.players.find(p => p.id === id);
      if (!p) return false;
      p.bot = true; p.input = {}; return true;
    },
    acceptInput(id, command) {
      if (!setInput(game, id, command)) return null;
      return { type: 'input', id, input: structuredClone(game.players.find(p => p.id === id).input), seq: command.seq };
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
