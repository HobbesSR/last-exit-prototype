import { mergeGateGeometry } from '../shared/relational-frame.ts';
import { SCHEMA, TICK_RECORDING_SCHEMA } from '../shared/recording.ts';
import { playerSlot, seatMetadata } from '../shared/simulation/relations.ts';
import { createGameRecord, createGame, disposePhysics, joinGame, playerView, setInput, snapshot, step, synchronizePhysics } from '../shared/simulation.ts';
import { inputLeadFrom, resetInput } from '../shared/simulation/input.ts';
import { changeSeat, setSanitizedInput, wholeMap } from '../shared/simulation/state.ts';
import { viewLagFrom } from '../shared/simulation/rewind.ts';
import { teleport } from '../shared/simulation/dev.ts';
import { clearRoute } from '../shared/simulation/geometry.ts';
import { generateLiveMap } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { describeContent } from '../shared/presentation.ts';
import { setImmediate as preparationPause } from 'node:timers/promises';
import { prepareMapPayload } from './map-payload.js';
import { publishItems, itemsJson, prepareGroundItems, shareItemPublication } from '../shared/simulation/ground-items.ts';
import { wireItemRecords } from '../shared/simulation/projection-contract.ts';
import { wireIds } from '../shared/simulation/wire-ids.ts';
import { predictionConstants } from '../shared/simulation/physics-presentation.ts';
import { publishGates, gatesJson } from '../shared/simulation/frame-gates.ts';
import { profiling, observe } from '../shared/profiler.ts';
import { createTickMatch } from '../shared/simulation/tick-match.ts';
import { TickMirror, stepMirror } from '../shared/simulation/tick-mirror.ts';
import { TickBoundary } from '../shared/simulation/tick-boundary.ts';
import { TickFrames } from '../shared/simulation/tick-frame.ts';
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
// recorded, logged or sent. Without one the outward IDs are the internal ones. `tick: 'new'` runs the match on the
// new tick's path (27.2 "The opt-in room tick (3d.4c)").
export async function createMatch(seed, size, map, content = defaultContent(), { wireKey = null, tick = 'old' } = {}) {
  const wire = wireIds(wireKey);
  const game = await createGame(seed, map ?? generateLiveMap(seed, content, size), content,
    () => preparationPause());
  try {
    const payloads = await prepareMapPayload(game.map, () => preparationPause());
    // Publish the initial list during private preparation, ahead of its first
    // outward frame, so building its cells leaves no loose-record migration.
    const beforeGround = profiling() ? performance.now() : undefined;
    await prepareGroundItems(publishItems(game), () => preparationPause());
    if (beforeGround !== undefined) observe('prepare.ground', performance.now() - beforeGround);
    return tick === 'new' ? newTickMatchOf(game, payloads, wire) : matchOf(game, payloads, wire);
  } catch (error) { disposePhysics(game); throw error; }
}

function matchOf(game, payloads, wire) {
  // Outward IDs for live payload items; recordings keep internal IDs (26).
  const outward = items => { const mapped = wireItemRecords(items, wire); if (mapped !== items) shareItemPublication(items, mapped); return mapped; };
  const recordedInput = (id, accepted) => accepted ? { type: 'input', id, input: structuredClone(accepted), seq: accepted.seq } : null;
  let disposedFrame;
  return {
    get version() { return game.version; },
    get tick() { return game.tick; },
    get phase() { return game.phase; },
    recordingSchema: SCHEMA,
    get seed() { return game.seed; },
    /** Which content set this match was pinned to, for the recording header to name. */
    get contentId() { return game.content.id; },
    /** How this match's content is labelled for display (22.7): data only, never authority. */
    presentation: describeContent(game.content),
    ...seatsOf(game, () => synchronizePhysics(game)),
    // Compatibility escape hatch for existing scenario/benchmark tools, not application code.
    get diagnosticState() { return game; },
    acceptInput(id, command) {
      // The recording carries the input exactly as it was queued, not whichever one a tick has most
      // recently spent: those are no longer the same thing.
      return recordedInput(id, setInput(game, id, command));
    },
    acceptSanitizedInput: (id, command) => recordedInput(id, setSanitizedInput(game, id, command)),
    /**
     * Tell the simulation how far behind this player's view runs, and how far ahead its input may be
     * stamped, from a round trip the server measured itself. The conversions belong to the
     * simulation, which owns how much rewind and lead it will grant; the application only reports
     * what it observed. Returns the observations to record, or null for no such player.
     */
    setViewLag(id, roundTripMs) {
      const p = connectionPlayer(game, id);
      if (!p) return null;
      const lag = p.viewLagTicks ?? 0, lead = p.inputLeadTicks ?? 0;
      const ticks = viewLagFrom(roundTripMs);
      // Absent rather than zero when there is nothing to compensate, so a player with no measured
      // latency carries no trace of the mechanism into snapshots or recordings.
      if (ticks > 0) p.viewLagTicks = ticks; else delete p.viewLagTicks;
      // The same measurement bounds how far ahead its input stamps may run (#1096).
      if (roundTripMs != null) p.inputLeadTicks = inputLeadFrom(roundTripMs); else delete p.inputLeadTicks;
      // Each change is an observation the recording keeps as a command (schema 21, 26), as the new
      // tick takes it from its inbound queue (27.2 Boundary). An unchanged measurement records nothing.
      const observed = [];
      if ((p.viewLagTicks ?? 0) !== lag) observed.push({ type: 'viewLag', id, ticks: p.viewLagTicks ?? 0 });
      if ((p.inputLeadTicks ?? 0) !== lead) observed.push({ type: 'inputLead', id, ticks: p.inputLeadTicks ?? 0 });
      return observed;
    },
    /** A dev teleport (24), as the command the recording keeps, or null when refused. */
    teleport(id, x, y) {
      const at = teleport(game, id, x, y);
      if (at) synchronizePhysics(game);
      return at && { type: 'teleport', id, ...at };
    },
    /** The start of play, after the lobby's seats are taken and before the first frame is recorded: nothing to do here. */
    start() {},
    advance() { if (disposedFrame) throw new Error('match disposed'); step(game); return snapshot(game); },
    snapshot: () => disposedFrame ? structuredClone(disposedFrame) : snapshot(game),
    dispose() { if (!disposedFrame) { disposedFrame = snapshot(game); disposePhysics(game); payloads = undefined; } },
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

/**
 * The match on the new tick's path (27.2 "The room-facing match (3d.3)"), with the room-facing interface of `matchOf`,
 * `start()` sets up the core from the game `createGame` built, after the lobby's seats are taken and before the
 * room records or publishes the first frame, which is then the core's tick 0 (review 1049). Until then the seats and a
 * measured lag are the old match's, which the setup reads; after it, a measurement is an observation for the next tick.
 *
 * The opt-in room records this path as schema 22:
 * - `acceptInput`, `setViewLag` and `teleport` queue what arrives at the receive boundary and record nothing. They return
 *   the admitted input, the observation rows (an array, possibly empty) and the queued teleport row, or null when
 *   refused. A teleport's outcome is the next frame's (review 1041).
 * - `spent()` is the last tick's inbound queue as recorded commands (26 "Schema 22"), which the room records with that
 *   tick's frame, beside its own commands (start, the roster, abandonment).
 * - Frames come from the mirror (`TickFrames`), with no old world state, RNG or scatter serial.
 */
function newTickMatchOf(game, payloads, wire) {
  const base = matchOf(game, payloads, wire);
  // The old match's own operations, kept before they are replaced: before the first tick they are this one's.
  const old = { join: base.join, resume: base.resume, leave: base.leave, setViewLag: base.setViewLag, snapshot: base.snapshot, dispose: base.dispose };
  let live, spent = [], discontinuities = [], disposedFrame;
  const started = () => live ??= (() => {
    const match = createTickMatch(game);
    try {
      const mirror = new TickMirror(game, match);
      return { match, mirror, boundary: new TickBoundary(game, match, wire), frames: new TickFrames(mirror) };
    } catch (error) { match.dispose(); throw error; }
  })();
  const frame = () => disposedFrame ? structuredClone(disposedFrame) : live ? live.frames.frame() : old.snapshot();
  return Object.assign(base, {
    recordingSchema: TICK_RECORDING_SCHEMA,
    join(id, role, kit, name) {
      if (!live) return old.join(id, role, kit, name);
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
      if (!live) return old.resume(id);
      const p = connectionPlayer(game, id);
      if (!p || !live.boundary.seat(id, 'join')) return null;
      clearRoute(p);
      return identity(p);
    },
    leave(id) { return live ? !!live.boundary.seat(id, 'leave') : old.leave(id); },
    // Detached, as the interface promises: the admitted input stays in the receive buffer untouched.
    acceptInput(id, input) { const admitted = started().boundary.input(id, input); return admitted && structuredClone(admitted); },
    acceptSanitizedInput(id, input) {
      const admitted = started().boundary.sanitizedInput(id, input);
      return admitted && structuredClone(admitted);
    },
    start() { started(); },
    // Before the start the player's own fields hold the measurement, which the core's setup reads.
    setViewLag(id, roundTripMs) { return live ? live.boundary.roundTrip(id, roundTripMs) : old.setViewLag(id, roundTripMs); },
    teleport(id, x, y) { return started().boundary.teleport(id, [x, y]); },
    advance() {
      if (disposedFrame) throw new Error('match disposed');
      const { match, mirror, boundary, frames } = started();
      const t = stepMirror(mirror, boundary);
      spent = t ? recordedInbound(match.ids, t.inbound) : [];
      discontinuities = t?.discontinuities ?? [];
      return frames.frame();
    },
    teleportSucceeded: request => discontinuities.some(marker => marker.kind === 'devWarped' && marker.request === request),
    /** The last tick's inbound queue as the commands its frame records: a detached copy. */
    spent: () => structuredClone(spent),
    snapshot: frame,
    dispose() {
      if (disposedFrame) return;
      disposedFrame = frame();
      live?.match.dispose();
      old.dispose();
    },
  });
}
