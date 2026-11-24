import { mergeGateGeometry } from '../shared/relational-frame.ts';
import { TICK_RECORDING_SCHEMA } from '../shared/recording.ts';
import { playerSlot, seatMetadata } from '../shared/simulation/relations.ts';
import { createGameRecord, createGame, disposePhysics, joinGame, playerView, snapshot, synchronizePhysics } from '../shared/simulation.ts';
import { inputLeadFrom, resetInput } from '../shared/simulation/input.ts';
import { changeSeat, wholeMap } from '../shared/simulation/state.ts';
import { viewLagFrom } from '../shared/simulation/rewind.ts';
import { clearRoute } from '../shared/simulation/geometry.ts';
import { generateLiveMap } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { describeContent } from '../shared/presentation.ts';
import { setImmediate as preparationPause } from 'node:timers/promises';
import { prepareMapPayload } from './map-payload.js';
import { prepareRuntimeNavigation } from './runtime-map.js';
import { publishItems, itemsJson, prepareGroundItems, shareItemPublication } from '../shared/simulation/ground-items.ts';
import { wireItemRecords } from '../shared/simulation/projection-contract.ts';
import { wireIds } from '../shared/simulation/wire-ids.ts';
import { predictionConstants } from '../shared/simulation/physics-presentation.ts';
import { publishGates, gatesJson } from '../shared/simulation/frame-gates.ts';
import { profiling, observe } from '../shared/profiler.ts';
import { stepMirror } from '../shared/simulation/tick-mirror.ts';
import { createTickSession } from '../shared/simulation/tick.ts';
import { recordedInbound } from '../shared/simulation/tick-record.ts';

// Only connection-facing operations resolve session labels; simulation relations use dense slots.
const connectionPlayer = (game, id) => {
  const idx = playerSlot(game, id);
  return idx === undefined ? undefined : game.players[idx];
};
const identity = p => p && ({ id: p.id, name: p.name, role: p.role, kit: p.kit });

// Who holds which place, over any game's roster: the match's own, or a lobby's before its map exists.
function seatsOf(game, reconcile = () => {}) {
  const capacity = role => role === 'gladiator' ? game.content.roster.gladiators.length : game.content.roster.contestants.length;
  // A place is open while a bot holds it, for a joining player to take over.
  const openPlaces = role => game.players.filter(p => p.bot && p.status === 'active' && p.role === role).length;
  const seats = {
    /** Whether this match's content offers a kit, rather than whatever the process happens to ship. */
    hasKit: kit => Object.hasOwn(game.content.kits, kit),
    /** How many of a role a match holds, counted from the roster rather than repeated as a number. */
    capacity,
    roster: () => game.players.filter(p => !p.bot).map(identity),
    seatMetadata: frame => seatMetadata(frame ?? game),
    player: id => identity(connectionPlayer(game, id)),
    openPlaces,
    preferredRole(preference) {
      const open = role => openPlaces(role) > 0;
      if (['contestant', 'gladiator'].includes(preference) && open(preference)) return preference;
      const roles = ['contestant', 'gladiator'].filter(open);
      const share = role => game.players.filter(p => p.role === role && !p.bot).length / capacity(role);
      return roles.sort((a, b) => share(a) - share(b))[0];
    },
    join(id, role, kit, name) { const player = joinGame(game, id, role, kit, name); reconcile(); return identity(player); },
    /** A joined player's change of role or kit before the start (#235), or null when that role is full. */
    choose(id, role, kit) { const player = changeSeat(game, id, role, kit); reconcile(); return identity(player); },
    resume(id) {
      const p = connectionPlayer(game, id);
      if (!p) return null;
      p.bot = false; resetInput(p); delete p.viewLagTicks; clearRoute(p);
      return identity(p);
    },
    leave(id) {
      const p = connectionPlayer(game, id);
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

// A map with no places on it. A lobby's game exists only for its roster, which createGameRecord builds from
// content alone; positions come from the map and are never read before the real match takes over.
// A fresh one per lobby: a game takes its map's live stores off it (#1211).
const nowhere = () => ({ spawns: [], stations: [], items: [], exit: { x: 0, y: 0 } });

/**
 * The seats of a room whose map is still being generated (#258): the same roster the match will have,
 * from the same content, with no simulation behind it. The room hands its commands to the match's `seat`.
 */
export function createLobby(content = defaultContent()) {
  // Described once, from the content the match will be pinned to, for every welcome and the recording (22.7).
  return { content, presentation: describeContent(content), ...seatsOf(createGameRecord(0, nowhere(), content)) };
}

// The application's only mutable access to simulation. Returned frames/commands are detached.
// `map` is the same seed and size already generated elsewhere (the room service's worker, #253).
// `wireKey` keys the match's outward IDs (#1164, 24.4): drawn by the server's composition root, never
// recorded, logged or sent. Without one the outward IDs are the internal ones.
export async function createMatch(seed, size, map, content = defaultContent(), { wireKey = null } = {}) {
  const wire = wireIds(wireKey);
  map ??= generateLiveMap(seed, content, size);
  const uploadingNavigation = prepareRuntimeNavigation(map);
  const navigation = uploadingNavigation && await uploadingNavigation;
  let game;
  try {
    game = await createGame(seed, map, content, () => preparationPause());
    const payloads = await prepareMapPayload(game.map, () => preparationPause());
    // Publish the initial list during private preparation, ahead of its first
    // outward frame, so building its cells leaves no loose-record migration.
    const beforeGround = profiling() ? performance.now() : undefined;
    await prepareGroundItems(publishItems(game), () => preparationPause());
    if (beforeGround !== undefined) observe('prepare.ground', performance.now() - beforeGround);
    return matchOf(game, payloads, wire, navigation);
  } catch (error) {
    try { if (game) disposePhysics(game); } finally { navigation?.release(); }
    throw error;
  }
}

function matchOf(game, payloads, wire, navigation) {
  // Outward IDs for live payload items; recordings keep internal IDs (26).
  const outward = items => { const mapped = wireItemRecords(items, wire); if (mapped !== items) shareItemPublication(items, mapped); return mapped; };
  const seats = seatsOf(game, () => synchronizePhysics(game));
  let live, spent = [], discontinuities = [], disposedFrame;
  const started = () => {
    if (disposedFrame) throw new Error('match disposed');
    return live ??= createTickSession(game, wire, navigation?.pointer);
  };
  const frame = () => disposedFrame ? structuredClone(disposedFrame) : live ? live.frames.frame() : snapshot(game);
  return {
    get version() { return game.version; },
    get tick() { return game.tick; },
    get phase() { return game.phase; },
    get seed() { return game.seed; },
    get contentId() { return game.content.id; },
    presentation: describeContent(game.content),
    ...seats,
    recordingSchema: TICK_RECORDING_SCHEMA,
    // Scenario and benchmark tools may arrange initial state before start.
    get diagnosticState() { return game; },
    join(id, role, kit, name) {
      if (!live) return seats.join(id, role, kit, name);
      const p = joinGame(game, id, role, kit, name);
      if (!p) return null;
      const slot = playerSlot(game, id), ids = live.match.ids;
      const previous = ids.playerOfActor.get(ids.actorAtSlot[slot]);
      ids.bindPlayer(slot, id);
      live.mirror.relabel(previous, id);
      live.boundary.seat(id, 'join', p.role === 'gladiator' ? p.kit : undefined);
      return identity(p);
    },
    resume(id) {
      if (!live) return seats.resume(id);
      const p = connectionPlayer(game, id);
      if (!p || !live.boundary.seat(id, 'join')) return null;
      clearRoute(p);
      return identity(p);
    },
    leave(id) { return live ? !!live.boundary.seat(id, 'leave') : seats.leave(id); },
    acceptInput(id, input) {
      const admitted = started().boundary.input(id, input);
      return admitted && structuredClone(admitted);
    },
    acceptSanitizedInput(id, input) {
      const admitted = started().boundary.sanitizedInput(id, input);
      return admitted && structuredClone(admitted);
    },
    start() { started(); },
    setViewLag(id, roundTripMs) {
      if (live) return live.boundary.roundTrip(id, roundTripMs);
      const p = connectionPlayer(game, id);
      if (!p) return null;
      // Measurements during setup seed the authority when it starts.
      const lag = viewLagFrom(roundTripMs);
      if (lag > 0) p.viewLagTicks = lag; else delete p.viewLagTicks;
      if (roundTripMs != null) p.inputLeadTicks = inputLeadFrom(roundTripMs); else delete p.inputLeadTicks;
      return [];
    },
    teleport(id, x, y) { return started().boundary.teleport(id, [x, y]); },
    advance() {
      const { match, mirror, boundary, frames } = started();
      const t = stepMirror(mirror, boundary);
      spent = t ? recordedInbound(match.ids, t.inbound) : [];
      discontinuities = t?.discontinuities ?? [];
      return frames.frame();
    },
    teleportSucceeded: request => discontinuities.some(marker => marker.kind === 'devWarped' && marker.request === request),
    spent: () => structuredClone(spent),
    snapshot: frame,
    dispose() {
      if (disposedFrame) return;
      try { disposedFrame = frame(); }
      finally {
        try { live?.match.dispose(); }
        finally {
          try { disposePhysics(game); }
          finally { navigation?.release(); payloads = undefined; }
        }
      }
    },
    project: (frame, id) => playerView(game, frame, id, wire),
    /** What a client predicts with that never changes in this match (24.3 proposal 3): sent with the map. */
    constants: () => predictionConstants(game.version, game.content.actorPhysics),
    map: () => structuredClone(wholeMap(game, { gates: mergeGateGeometry({ gates: publishGates(game) }), items: publishItems(game) })),
    /** Detached immutable payload data; ordinary map queries above remain writable copies. */
    payloadMap(kind, frame) {
      if (!payloads) throw new Error('match disposed');
      // The map whole, in its own field order, so the payload's JSON is what it was when the map held its stores (#1211).
      const source = wholeMap(game, { gates: mergeGateGeometry({ gates: publishGates(game) }, kind === 'spectator' ? frame.gates : undefined),
        items: kind === 'recording' ? publishItems(game) : outward(kind === 'spectator' ? frame.items : publishItems(game)),
        ...(kind !== 'recording' ? { traps: [] } : {}) });
      return payloads.read(source, { publicMap: kind !== 'recording', itemsJson, gatesJson });
    },
    end({ strand = false } = {}) {
      game.phase = 'finished';
      if (strand) for (const p of game.players) if (p.role === 'contestant' && p.status === 'active') p.status = 'stranded';
    },
    result: () => ({ ticks: game.tick, escaped: game.players.filter(p => p.status === 'escaped').length })
  };
}
