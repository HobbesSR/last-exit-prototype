import { templatesOf } from './boundary.ts';
import { frameOf } from './visibility.ts';
import { authoredProps } from './world-physics.ts';
import { bodyKey, bodyOrder } from './tick-codec.ts';
import type { FramePresentation } from './visibility.ts';
import type { BodyShape, NumericHookFlight, NumericPhysicsBody, NumericPhysicsTether, PhysicsBodyOwner } from '../physics/types.ts';
import type { BodyRef, DecodedTick, PoseEntry } from './tick-codec.ts';
import type { TickMirror } from './tick-mirror.ts';
import type { BodyId, ItemId, PlayerIdx, PropId, Snapshot, TetherId } from '../types.ts';

// The new tick's frame (docs/27.2 "Frames (3d.3)"): the `Snapshot` the recording writer stores and `playerView` projects,
// built from the mirror instead of the old physics world. The game's records come from the mirror as they are; the
// physics presentation comes from the core's poses and hooks, which the mirror keeps beside the game.
//
// - **Body identity.** A presentation body ID names one lifetime of one body, as the old world's identities did: a body
//   gets a new ID when it enters the world, and keeps it until it leaves. IDs start at 1 in body order.
// - **Generations.** One counter for the match. A placement or a warp takes the next value, so a viewer never interpolates
//   across either, as the old teleport renewed its body's generation. A placement also marks the body `placed`.
// - **Shapes** are the specs the loader uploads: the actor templates, the loot template and the authored props.
// - **Tethers** are the hooks pulling, from caster (`a`) to target (`b`); **flights** are the hooks flying. A tether's ID
//   is the hook's ID plus one, which the core keeps for the hook's life.
// - **No private `physics` block.** The old frame carried the old world's state beside its presentation. A frame here
//   carries only the presentation; `playerView` reads tether state from it (`tetherState`).

interface Life { id: BodyId; generation: number }

/** The frames of one match on the new path. Construct it on the mirror before the first step. */
export class TickFrames {
  readonly mirror: TickMirror;
  #serial = 0;
  #generation = 0;
  /** The current lifetime of each body in the world, keyed `kind:id`. */
  readonly #lives = new Map<string, Life>();
  /** The bodies placed in the last tick taken. */
  #placed = new Set<string>();
  readonly #shapes: { actor: Record<'contestant' | 'gladiator', BodyShape>; loot: BodyShape; props: BodyShape[] };

  constructor(mirror: TickMirror) {
    this.mirror = mirror;
    const s = mirror.s, t = templatesOf(s);
    this.#shapes = { actor: { contestant: t.actor.contestant.shape, gladiator: t.actor.gladiator.shape }, loot: t.loot.shape,
      props: authoredProps(s).map(p => p.spec.shape) };
    for (const pose of [...mirror.poses.values()].sort((a, b) => bodyOrder(a.body, b.body))) this.#begin(bodyKey(pose.body));
  }

  #begin(key: string): void { this.#lives.set(key, { id: ++this.#serial as BodyId, generation: ++this.#generation }); }

  /**
   * Take a completed tick's markers, after the mirror has applied it. Removals end lifetimes first, so a body that left
   * and entered again in one tick starts a new one, as the mirror keeps its new pose.
   */
  advance(t: DecodedTick): void {
    this.#placed = new Set();
    for (const marker of t.discontinuities) if (marker.kind === 'removed') this.#lives.delete(bodyKey(marker.body));
    for (const marker of t.discontinuities) {
      const key = bodyKey(marker.body);
      if (marker.kind === 'placed') { this.#begin(key); this.#placed.add(key); }
      else if (marker.kind === 'warped') {
        const life = this.#lives.get(key);
        if (life) life.generation = ++this.#generation; else this.#begin(key);
      }
    }
  }

  /** The frame of the mirror's last tick: what `snapshot` gives on the old path. */
  frame(): Snapshot { return frameOf(this.mirror.s, this.presentation()); }

  /** The physics presentation of the mirror's last tick, in body order. */
  presentation(): FramePresentation {
    const s = this.mirror.s, ids = this.mirror.ctx.ids;
    const roster = new Map(s.players.map((p, i) => [ids.actorOfPlayer.get(p.id)!, i as PlayerIdx] as const));
    const bodies: NumericPhysicsBody[] = [], actorBody = new Map<number, BodyId>();
    for (const pose of [...this.mirror.poses.values()].sort((a, b) => bodyOrder(a.body, b.body))) {
      const key = bodyKey(pose.body), life = this.#lives.get(key);
      if (!life) throw new RangeError(`tick-frame: ${key} has a pose and no lifetime`);
      const described = this.#describe(pose.body, roster);
      if (!described) continue;
      if (pose.body.kind === 'actor') actorBody.set(pose.body.id, life.id);
      bodies.push(bodyOf(life, described, pose, this.#placed.has(key)));
    }
    const tethers: NumericPhysicsTether[] = [], hookFlights: NumericHookFlight[] = [];
    for (const [id, hook] of [...this.mirror.hooks].sort((a, b) => a[0] - b[0])) {
      const a = actorBody.get(hook.owner), tether = id + 1 as TetherId;
      if (a === undefined) continue;
      if (hook.phase.kind === 'pulling') {
        const b = actorBody.get(hook.phase.target);
        if (b !== undefined) tethers.push({ id: tether, a, b });
      } else hookFlights.push({ id: tether, a, casterIdx: roster.get(hook.owner)!, x: hook.phase.position[0], y: hook.phase.position[1] });
    }
    return { physicsProfile: s.version, bodies, tethers, hookFlights };
  }

  /** A body's kind, shape and owner, or null for one the frame does not draw. */
  #describe(body: BodyRef, roster: ReadonlyMap<number, PlayerIdx>): { kind: 'actor' | 'prop'; shape: BodyShape; owner: PhysicsBodyOwner } | null {
    switch (body.kind) {
      case 'actor': {
        const playerIdx = roster.get(body.id);
        if (playerIdx === undefined) return null;
        return { kind: 'actor', shape: this.#shapes.actor[this.mirror.s.players[playerIdx]!.role], owner: { kind: 'actor', playerIdx } };
      }
      case 'item': return { kind: 'prop', shape: this.#shapes.loot, owner: { kind: 'item', itemId: body.id as ItemId } };
      case 'prop': {
        const shape = this.#shapes.props[body.id];
        if (!shape) throw new RangeError(`tick-frame: prop ${body.id} is not authored`);
        return { kind: 'prop', shape, owner: { kind: 'prop', propId: body.id + 1 as PropId } };
      }
      default: return null;
    }
  }
}

/** A presentation body, in the old capture's field order, so a frame's JSON reads as the old one did. */
function bodyOf(life: Life, d: { kind: 'actor' | 'prop'; shape: BodyShape; owner: PhysicsBodyOwner }, pose: PoseEntry, placed: boolean): NumericPhysicsBody {
  return { id: life.id, kind: d.kind, shape: d.shape, x: pose.at[0], y: pose.at[1], angle: pose.angle, vx: pose.velocity[0], vy: pose.velocity[1],
    omega: pose.spin, sleeping: pose.sleeping, generation: life.generation, owner: d.owner, ...(placed ? { discontinuity: 'placed' as const } : {}) };
}
