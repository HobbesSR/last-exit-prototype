import { hydrateFrame, mergeGateGeometry } from '../shared/relational-frame.ts';
import { TICK_RECORDING_SCHEMA } from '../shared/recording.ts';
import { playerSlot, seatMetadata } from '../shared/simulation/relations.ts';
import { createGameRecord, createGame, disposePhysics, joinGame, playerView, snapshot, synchronizePhysics } from '../shared/simulation.ts';
import { inputLeadFrom, MAX_INPUT_LEAD_TICKS, resetInput } from '../shared/simulation/input.ts';
import { changeSeat, wholeMap } from '../shared/simulation/state.ts';
import { MAX_REWIND_TICKS, viewLagFrom } from '../shared/simulation/rewind.ts';
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
import { stepTick } from '../shared/simulation/tick-step.ts';
import { createTickSession } from '../shared/simulation/tick.ts';
import { inboundOfRecorded, recordedInbound } from '../shared/simulation/tick-record.ts';
import { seatChanged } from '../shared/simulation/tick-boundary.ts';
import { encodeInbound } from '../shared/simulation/tick-codec.ts';

// Only connection-facing operations resolve session labels; simulation relations use dense slots.
const connectionPlayer = (game, id) => {
  const idx = playerSlot(game, id);
  return idx === undefined ? undefined : game.players[idx];
};
const identity = p => p && ({ id: p.id, name: p.name, role: p.role, kit: p.kit });
export const BOT_PLANNER_VERSION = 1;

// Who holds which place, over any game's roster: the match's own, or a lobby's before its map exists. Who controls a
// place is the game player's `bot`, which joins, resumes and leaves change at once (the receive boundary's, #1346).
// Whether it is active is `statuses()`, per slot: the game's players' until the match starts, then the core's, from the
// frame store's records (docs/27.2 "The room-facing match").
// A place is open while a bot holds it, for a joining player to take over. Counting and admission use this one rule.
function openSlots(game, statuses, role) {
  const status = statuses();
  return game.players.flatMap((p, slot) => p.bot && p.role === role && status[slot] === 'active' ? [slot] : []);
}
function seatsOf(game, reconcile = () => {}, statuses = () => game.players.map(p => p.status)) {
  const capacity = role => role === 'gladiator' ? game.content.roster.gladiators.length : game.content.roster.contestants.length;
  const openPlaces = role => openSlots(game, statuses, role).length;
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
export async function createMatch(seed, size, map, content = defaultContent(), { wireKey = null, archivedGraph } = {}) {
  const wire = wireIds(wireKey);
  map ??= generateLiveMap(seed, content, size);
  // Match setup replaces authored loot labels and splits weapon magazines before publication.
  const setupItems = structuredClone(map.items);
  const navigation = await prepareRuntimeNavigation(map, archivedGraph);
  let game;
  try {
    game = await createGame(seed, map, content, () => preparationPause());
    const payloads = await prepareMapPayload(game.map, () => preparationPause());
    // Publish the initial list during private preparation, ahead of its first
    // outward frame, so building its cells leaves no loose-record migration.
    const beforeGround = profiling() ? performance.now() : undefined;
    await prepareGroundItems(publishItems(game), () => preparationPause());
    if (beforeGround !== undefined) observe('prepare.ground', performance.now() - beforeGround);
    return matchOf(game, payloads, wire, navigation, setupItems);
  } catch (error) {
    try { if (game) disposePhysics(game); } finally { navigation.release(); }
    throw error;
  }
}

function matchOf(game, payloads, wire, navigation, setupItems) {
  // Outward IDs for live payload items; recordings keep internal IDs (26).
  const outward = items => { const mapped = wireItemRecords(items, wire); if (mapped !== items) shareItemPublication(items, mapped); return mapped; };
  let live, spent = [], botWords = new Float64Array(), discontinuities = [], disposedFrame;
  // After the start the game holds the roster and the receive boundary's state, never the match's status (27.2 "Test API").
  const statuses = () => (disposedFrame?.players ?? live?.frames.players() ?? game.players).map(p => p.status);
  const seats = seatsOf(game, () => synchronizePhysics(game), statuses);
  const started = () => {
    if (disposedFrame) throw new Error('match disposed');
    if (!live) {
      live = createTickSession(game, wire, navigation.pointer);
      navigation.release();
    }
    return live;
  };
  // A live join binds a bot's seat to the new player's label, which the next tick's join observation then carries.
  // The place is chosen as open places are counted (`openSlots`), so availability and admission are one selection
  // (review 1108). A recorded join's controller change is the game's at once, so two joins in one tick take two places.
  const relabel = (id, role, kit, name) => {
    const [slot] = openSlots(game, statuses, role);
    const p = slot === undefined ? null : joinGame(game, id, role, kit, name, slot);
    if (!p) return null;
    const ids = live.match.ids;
    const previous = ids.playerOfActor.get(ids.actorAtSlot[slot]);
    ids.bindPlayer(slot, id);
    live.frames.relabel(previous, id);
    return p;
  };
  /** One tick through the session; `rows` are a replay's recorded inbound queue in place of the boundary's buffer. */
  const step = rows => {
    const session = started(), { match, frames } = session;
    const t = stepTick({ s: game, ...session }, rows);
    spent = t ? recordedInbound(match.ids, t.inbound) : [];
    botWords = encodeInbound(t ? t.inbound.filter(row => row.type === 'command' && row.command.source === 'bot') : []);
    discontinuities = t?.discontinuities ?? [];
    return t && frames.frame();
  };
  /** A frame's gates over the map's geometry, and its items each at its place (a body's pose where it has one). */
  const dynamicOf = frame => ({ gates: mergeGateGeometry({ gates: publishGates(game) }, frame.gates), items: hydrateFrame(frame).items });
  const capture = (privateRoutes = false) => {
    if (disposedFrame) {
      const frame = structuredClone(disposedFrame);
      if (!privateRoutes) for (const player of frame.players) delete player.route;
      return frame;
    }
    if (!live) return snapshot(game);
    return privateRoutes ? live.frames.privateFrame() : live.frames.frame();
  };
  return {
    get version() { return game.version; },
    get tick() { return game.tick; },
    get phase() { return game.phase; },
    get seed() { return game.seed; },
    get contentId() { return game.content.id; },
    presentation: describeContent(game.content),
    ...seats,
    recordingSchema: TICK_RECORDING_SCHEMA,
    botPlannerVersion: BOT_PLANNER_VERSION,
    recordingSetup: () => structuredClone({ items: setupItems, portalGraph: navigation.portalGraph }),
    // Scenario and benchmark tools may arrange initial state before start.
    get diagnosticState() { return game; },
    join(id, role, kit, name) {
      if (!live) return seats.join(id, role, kit, name);
      const p = relabel(id, role, kit, name);
      if (!p) return null;
      live.boundary.seat(id, 'join', p.role === 'gladiator' ? p.kit : undefined, true);
      return identity(p);
    },
    resume(id) {
      if (!live) return seats.resume(id);
      const p = connectionPlayer(game, id);
      // The join clears the core route when the next tick processes it.
      if (!p || !live.boundary.seat(id, 'join')) return null;
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
    start({ measurements } = {}) {
      if (measurements) {
        if (live || disposedFrame) throw new Error('Opening measurements require an unstarted match');
        for (const { id, viewLagTicks, inputLeadTicks } of measurements) {
          const p = connectionPlayer(game, id);
          if (!p) throw new RangeError(`Unknown replay opening seat: ${id}`);
          if (viewLagTicks !== undefined) {
            if (!Number.isInteger(viewLagTicks) || viewLagTicks < 1 || viewLagTicks > MAX_REWIND_TICKS) {
              throw new RangeError(`Invalid replay opening view lag for ${id}`);
            }
            p.viewLagTicks = viewLagTicks;
          }
          if (inputLeadTicks !== undefined) {
            if (!Number.isInteger(inputLeadTicks) || inputLeadTicks < 1 || inputLeadTicks > MAX_INPUT_LEAD_TICKS) {
              throw new RangeError(`Invalid replay opening input lead for ${id}`);
            }
            p.inputLeadTicks = inputLeadTicks;
          }
        }
      }
      started();
    },
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
    advance() { return step() ?? live.frames.frame(); },
    /**
     * Resimulate one recorded committed tick (#1284, docs/26 "Schema 25"): the frame's room roster commands as the live
     * room applied them between ticks, then its spent `command` and `observation` rows in recorded order. The core
     * regenerates its carry and the first-class bots' commands, which `spent` and `botCommands` then report. A seat
     * relabel carries the lexical rank computed just after binding, as the live join does. False once the match is over.
     * `labels: false` leaves the ranks out, as a witness that a recording depends on them (`tools/bot-label-witness.mjs`).
     */
    replay(commands, { labels: ranked = true } = {}) {
      const { match } = started(), labels = new Map(), rows = [];
      for (const command of commands) {
        if (command.type === 'command' || command.type === 'observation') rows.push(command);
        else if (command.type === 'join') {
          const p = relabel(command.id, command.role, command.kit, command.name);
          if (!p) throw new RangeError(`Replay join found no seat for ${command.id}`);
          labels.set(command.id, seatChanged(match.ids, p, 'join', undefined, true).observation.botLabel);
        } else if (command.type === 'resume' || command.type === 'leave') {
          const p = connectionPlayer(game, command.id);
          if (!p) throw new RangeError(`Replay ${command.type} names no seat for ${command.id}`);
          seatChanged(match.ids, p, command.type === 'resume' ? 'join' : 'leave');
        } else if (command.type !== 'carried') throw new RangeError(`Replay cannot apply a ${command.type} command after the start`);
      }
      const inbound = inboundOfRecorded(match.ids, rows, ranked ? labels : new Map());
      return step(inbound) !== null;
    },
    teleportSucceeded: request => discontinuities.some(marker => marker.kind === 'devWarped' && marker.request === request),
    spent: () => structuredClone(spent),
    botCommands: () => botWords.slice(),
    frame: () => capture(),
    snapshot: () => capture(true),
    dispose() {
      if (disposedFrame) return;
      try { disposedFrame = capture(true); }
      finally {
        try { live?.match.dispose(); }
        finally {
          try { disposePhysics(game); }
          finally { navigation.release(); payloads = undefined; }
        }
      }
    },
    project: (frame, id) => playerView(game, frame, id, wire),
    /** What a client predicts with that never changes in this match (24.3 proposal 3): sent with the map. */
    constants: () => predictionConstants(game.version, game.content.actorPhysics),
    map: () => structuredClone(wholeMap(game, live ? dynamicOf(capture()) : { gates: mergeGateGeometry({ gates: publishGates(game) }), items: publishItems(game) })),
    /** Detached immutable payload data; ordinary map queries above remain writable copies. */
    payloadMap(kind, frame) {
      if (!payloads) throw new Error('match disposed');
      // The map whole, in its own field order, so the payload's JSON is what it was when the map held its stores (#1211).
      // A spectator's map takes its gates and items from the delayed frame it is shown, whose item poses its bodies carry.
      // Once started, a player's takes them from `frame`, by default the current one, with every item at its place: the
      // game's are its setup's (docs/27.2 "Test API"). The recording's is the opening state (26).
      const shown = kind === 'live' && live ? dynamicOf(frame ?? live.frames.frame()) : undefined;
      const source = wholeMap(game, { gates: shown?.gates ?? mergeGateGeometry({ gates: publishGates(game) }, kind === 'spectator' ? frame.gates : undefined),
        items: kind === 'recording' ? publishItems(game) : outward(shown?.items ?? (kind === 'spectator' ? frame.items : publishItems(game))),
        ...(kind !== 'recording' ? { traps: [] } : {}) });
      return payloads.read(source, { publicMap: kind !== 'recording', itemsJson, gatesJson });
    },
    end({ strand = false } = {}) {
      live?.frames.end({ strand });
      game.phase = 'finished';
      if (strand && !live) for (const p of game.players) if (p.role === 'contestant' && p.status === 'active') p.status = 'stranded';
    },
    result: () => ({ ticks: game.tick, escaped: statuses().filter(status => status === 'escaped').length })
  };
}
