import { canOccupy, movementSpeed } from '../movement.ts';
import { queueInput, queueSanitizedInput, consumeInput, resetInput } from './input.ts';
import type { SanitizedInput } from './input.ts';
import { makePlayer } from './state.ts';
import { HZ, MAX_PLAYER_NAME } from './rules.ts';
import { observed } from './visibility.ts';
import { ownPlayerFields, physicsBodyFields } from './projection-contract.ts';
import { defaultContent } from './content.ts';
import { characterMotor } from './actor-physics.ts';
import { buildPhysicsGeometry } from './physics-geometry.ts';
import { PhysicsIdentities } from './physics-identities.ts';
import { PHYSICS_VERSION } from './physics-runtime.ts';
import { predictionConstants } from './physics-presentation.ts';
import { wireIds, type WireIdKey, type WireIds } from './wire-ids.ts';
import { initPhysics, isPhysicsInitialized, PhysicsWorld } from '../physics/world.ts';
import type { PhysicsBodyView } from '../physics/types.ts';
import type { GameMap, Kit, Player, PlayerId, PlayerIdx, PlayerInput, Role, Tick } from '../types.ts';

/**
 * Where people wait before a match starts (#236, 22.5): a small simulation of its own that the room runs
 * until the start. Movement only, stepped on a Rapier world using default actor physics (#975). Nobody
 * can be harmed and there are no bots. It shares no state, IDs or randomness with the match and is never
 * recorded, so the match, its recording and the fixture are the same with or without it. At the start
 * everyone moves to the match's own spawns.
 */

const ACTOR_PHYSICS = defaultContent().actorPhysics;
const actorRadius = (role: Role): number => ACTOR_PHYSICS.geometry[role].bodyRadius;
/** The yard's prediction constants, sent with its map as a match's are (24.3 proposal 3). */
export const waitingConstants = () => predictionConstants(PHYSICS_VERSION, ACTOR_PHYSICS);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A waiting area: a map with no exit, entry or objectives, since nothing happens there but walking. */
export type WaitingMap = Omit<GameMap, 'exit' | 'entry'>;

export interface Waiting {
  tick: Tick;
  map: WaitingMap;
  /** People only, in arrival order. */
  players: Player[];
  /** Each waiting player's slot (`playerIdx`): fixed for as long as they stay, with gaps where people left. */
  slots: Map<PlayerId, PlayerIdx>;
  /** The roster `waitingSeats` last built, kept until someone arrives, changes or leaves, so an unchanged yard
   * hands out the same array and its serialized seats message is reused (server/room-views.js). */
  roster: WaitingSeat[] | null;
  /** How many have arrived so far, which picks the next arrival point. */
  arrivals: number;
  world: PhysicsWorld | null;
  identities: PhysicsIdentities;
  /** The yard's outward body IDs (#1164): its own key, drawn by the room like a match's. */
  wire: WireIds;
  discontinuities: Set<string>;
  ready: Promise<void>;
  disposed: boolean;
  dispose(): void;
}

export function createWaiting(map: WaitingMap, { wireKey = null }: { wireKey?: WireIdKey | null } = {}): Waiting {
  const w: Waiting = {
    tick: 0,
    map,
    players: [],
    slots: new Map(),
    roster: null,
    arrivals: 0,
    world: null,
    identities: new PhysicsIdentities(),
    wire: wireIds(wireKey),
    discontinuities: new Set(),
    ready: null!,
    disposed: false,
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.world?.dispose();
      this.world = null;
      this.players = [];
      this.slots.clear();
      this.roster = null;
      this.discontinuities.clear();
    }
  };

  const initWorld = () => {
    if (w.disposed) return;
    const world = PhysicsWorld.createSync();
    w.world = world;
    const geometry = buildPhysicsGeometry(map).sort((a, b) => compare(a.id, b.id));
    for (const body of geometry) world.queueAddBody({ ...body, mapGeometry: true });
    world.commitMutations();
    for (const p of w.players) syncActorBody(w, p);
  };

  if (isPhysicsInitialized()) {
    initWorld();
    w.ready = Promise.resolve();
  } else {
    w.ready = initPhysics().then(initWorld);
  }

  return w;
}

function syncActorBody(w: Waiting, p: Player, oldRole?: Role): void {
  if (!w.world || w.disposed) return;
  const bodyId = `actor:${p.id}`;
  const radius = actorRadius(p.role);
  if (w.world.getTransform(bodyId)) {
    if (oldRole === p.role) {
      w.world.setTransform(bodyId, { x: p.x, y: p.y, angle: 0 });
      w.discontinuities.add(bodyId);
      return;
    }
    w.world.queueRemoveBody(bodyId);
  }
  w.world.queueAddBody({
    id: bodyId,
    kind: 'actor',
    shape: { kind: 'circle', radius },
    x: p.x,
    y: p.y,
    mass: 1,
    friction: 0,
    restitution: 0,
    maxSpeed: ACTOR_PHYSICS.maxSpeed
  });
  w.world.commitMutations();
  w.discontinuities.add(bodyId);
}

/**
 * Bring someone into the waiting area on a new connection: a join, or a resume, which may replace a
 * connection still attached. Their input starts afresh, since the new connection numbers its inputs
 * from zero. Someone already there keeps where they stand.
 */
export function enterWaiting(w: Waiting, id: PlayerId, role: Role, kit: Kit, name: string): Player {
  return place(w, id, role, kit, name, false);
}

/**
 * Show a change of role or kit (#235) on someone already waiting, over the same connection, so their
 * input queue and its sequence numbers carry on and prediction is undisturbed.
 */
export function changeWaiting(w: Waiting, id: PlayerId, role: Role, kit: Kit): Player | null {
  const old = w.players.find(p => p.id === id);
  return old ? place(w, id, role, kit, old.name, true) : null;
}

// Someone already there keeps where they stand, unless a bigger body no longer fits there.
function place(w: Waiting, id: PlayerId, role: Role, kit: Kit, name: string, continuing: boolean): Player {
  const old = w.players.find(p => p.id === id);
  const oldRole = old?.role;
  const p = makePlayer(id, name.slice(0, MAX_PLAYER_NAME), role, kit, 0);
  p.bot = false; resetInput(p);
  const arrival = () => w.map.spawns[w.arrivals++ % w.map.spawns.length]!;
  const larger = !!old && actorRadius(role) > actorRadius(old.role);
  const at = old && (!larger || canOccupy(w.map, old.x, old.y, actorRadius(role))) ? old : arrival();
  p.x = at.x; p.y = at.y;
  if (old) {
    p.heading = old.heading;
    if (continuing) Object.assign(p, { input: old.input, lastSeq: old.lastSeq, receivedSeq: old.receivedSeq, inputQueue: old.inputQueue, inputTick: old.inputTick, inputStalled: old.inputStalled });
    // Timing metadata only when present, so an unstamped waiting player carries no trace of it.
    if (continuing) for (const key of ['inputMargin', 'inputMarginNext', 'inputLeadTicks'] as const) if (old[key] !== undefined) p[key] = old[key];
    w.players[w.players.indexOf(old)] = p;
  } else {
    w.players.push(p);
    let slot = 0;
    const taken = new Set(w.slots.values());
    while (taken.has(slot as PlayerIdx)) slot++;
    w.slots.set(id, slot as PlayerIdx);
  }
  w.roster = null;
  syncActorBody(w, p, oldRole);
  return p;
}

export function leaveWaiting(w: Waiting, id: PlayerId): void {
  w.players = w.players.filter(p => p.id !== id);
  w.slots.delete(id);
  w.roster = null;
  const bodyId = `actor:${id}`;
  w.discontinuities.delete(bodyId);
  if (w.world && !w.disposed && w.world.getTransform(bodyId)) {
    w.world.queueRemoveBody(bodyId);
    w.world.commitMutations();
  }
}

const slotOf = (w: Waiting, id: PlayerId): PlayerIdx => w.slots.get(id)!;

type WaitingSeat = { playerIdx: PlayerIdx; id: PlayerId; name: string; role: Role; kit: Kit; seat?: number };
/** The yard's roster for the wire: one entry per person at their own slot, ascending, gaps where people left. */
export function waitingSeats(w: Waiting): WaitingSeat[] {
  return w.roster ??= w.players.map(p => ({ playerIdx: slotOf(w, p.id), id: p.id, name: p.name, role: p.role, kit: p.kit,
    ...(p.seat !== undefined ? { seat: p.seat } : {}) })).sort((a, b) => a.playerIdx - b.playerIdx);
}

/** Queue one input from someone waiting; false when it is refused. Only movement and aim are read. */
export function waitingInput(w: Waiting, id: PlayerId, input: PlayerInput | null | undefined): boolean {
  const p = w.players.find(p => p.id === id);
  return !!p && !!queueInput(p, input, w.tick);
}

/** Queue an input already validated and sanitized at the protocol boundary. */
export function waitingSanitizedInput(w: Waiting, id: PlayerId, input: SanitizedInput): boolean {
  const p = w.players.find(p => p.id === id);
  return !!p && !!queueSanitizedInput(p, input, w.tick);
}

/** One tick: everyone spends one input, as in a match, and walks. Nothing else happens. */
export function stepWaiting(w: Waiting): void {
  w.tick++;
  if (!w.world || w.disposed) {
    for (const p of w.players) {
      const input = consumeInput(p, w.tick);
      p.heading = input.aim || 0;
    }
    return;
  }
  for (const p of w.players) {
    const input = consumeInput(p, w.tick);
    p.heading = input.aim || 0;
    const speed = movementSpeed(p, input, HZ);
    const motor = characterMotor(ACTOR_PHYSICS, w.map.motorSurfaces, p, input.x ?? 0, input.y ?? 0, speed);
    w.world.setMotor(`actor:${p.id}`, motor);
  }
  const result = w.world.step();
  w.world.drainContacts();
  for (const p of w.players) {
    const at = w.world.getTransform(`actor:${p.id}`);
    if (at) {
      p.x = at.x;
      p.y = at.y;
      p.movedThisTick = result.distance[`actor:${p.id}`] ?? 0;
    }
  }
  w.discontinuities.clear();
}

/**
 * What one person waiting is sent: everyone there, since the yard is small and the lobby already lists
 * them, in the frame shape a match's player view has, with bodies for client Rapier prediction (#975); its
 * physics profile and prediction motor come once, with the yard's map (`waitingConstants`). Others are described by the same fields a match shows of a player
 * in sight.
 */
export function waitingView(w: Waiting, id: PlayerId) {
  const viewer = w.players.find(p => p.id === id);
  const actors = new Map(w.players.map(p => [`actor:${p.id}`, slotOf(w, p.id)]));
  const bodies: PhysicsBodyView[] = (w.world && !w.disposed ? w.world.snapshot({ includeStatic: false }).bodies : [])
    .filter(b => b.spec.kind === 'actor' && actors.has(b.spec.id))
    .map(b => physicsBodyFields({
      id: w.identities.body(w.world!.bodyLifetime(b.spec.id)!),
      kind: 'actor',
      shape: b.spec.shape,
      ...b.transform,
      generation: b.generation,
      owner: { kind: 'actor', playerIdx: actors.get(b.spec.id)! },
      ...(w.discontinuities.has(b.spec.id) ? { discontinuity: 'placed' as const } : {})
    }, b.spec.id === `actor:${id}`, w.wire));

  // A player with a body carries its pose there only (24.4): records are built without it, as in a match.
  const bodyPlayers = new Set(bodies.map(body => body.owner.kind === 'actor' ? body.owner.playerIdx : undefined));
  const posed = (playerIdx: PlayerIdx) => !bodyPlayers.has(playerIdx);
  return {
    tick: w.tick,
    phase: 'waiting' as const,
    bodies,
    ...(viewer ? { self: ownPlayerFields(viewer, undefined, undefined, slotOf(w, id), w.wire, posed(slotOf(w, id))) } : {}),
    players: w.players.flatMap(p => p.id === id ? [] : [observed(p, slotOf(w, p.id), posed(slotOf(w, p.id)))]),
    items: [],
    gates: [],
    traps: [],
    projectiles: [],
    effects: [],
    events: []
  };
}
