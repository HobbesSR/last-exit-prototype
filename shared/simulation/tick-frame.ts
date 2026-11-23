import { templatesOf } from './boundary.ts';
import { frameOf } from './visibility.ts';
import { authoredProps } from './world-physics.ts';
import { bodyKey, bodyOrder } from './tick-codec.ts';
import type { FramePresentation } from './visibility.ts';
import type { BodyShape, NumericHookFlight, NumericPhysicsBody, NumericPhysicsTether, PhysicsBodyOwner } from '../physics/types.ts';
import type { BodyRef, PoseEntry } from './tick-codec.ts';
import type { BodyLife, TickMirror } from './tick-mirror.ts';
import type { BodyId, ItemId, PlayerIdx, PropId, Snapshot, TetherId } from '../types.ts';

// The new tick's frame (docs/27.2 "Frames (3d.3)"): the `Snapshot` the recording writer stores and `playerView` projects,
// built from the mirror instead of the old physics world. The game's records come from the mirror as they are; the
// physics presentation comes from the core's poses and hooks, which the mirror keeps beside the game.
//
// - **Body identity and generations** are the mirror's (`BodyLives`, which `TickMirror.apply` keeps): a new ID per
//   lifetime, a generation within it renewed by a warp, and `placed` on the tick a body enters the world.
// - **Shapes** are the specs the loader uploads: the actor templates, the loot template and the authored props, copied
//   once and frozen, so no frame can change another's or what the loader uploads.
// - **Tethers** are the hooks pulling, from caster (`a`) to target (`b`); **flights** are the hooks flying. A tether's ID
//   is the hook's ID, which the core allocates from 1 and keeps for the hook's life (review 1047).
// - **No private `physics` block.** The old frame carried the old world's state beside its presentation. A frame here
//   carries only the presentation; `playerView` reads tether state from it (`tetherState`).

type Shape = Readonly<BodyShape>;

/** A detached, frozen copy of a shape, its vertices included. */
function frozenShape(shape: BodyShape): Shape {
  return Object.freeze(shape.kind === 'convex'
    ? { kind: 'convex', vertices: Object.freeze(shape.vertices.map(v => Object.freeze({ x: v.x, y: v.y }))) } as BodyShape
    : { ...shape });
}

/** The frames of one match on the new path. Construct it on the mirror before the first step. */
export class TickFrames {
  readonly mirror: TickMirror;
  readonly #shapes: { actor: Record<'contestant' | 'gladiator', Shape>; loot: Shape; props: Shape[] };

  constructor(mirror: TickMirror) {
    this.mirror = mirror;
    const s = mirror.s, t = templatesOf(s);
    this.#shapes = { actor: { contestant: frozenShape(t.actor.contestant.shape), gladiator: frozenShape(t.actor.gladiator.shape) },
      loot: frozenShape(t.loot.shape), props: authoredProps(s).map(p => frozenShape(p.spec.shape)) };
  }

  /**
   * The frame of the mirror's last tick: what `snapshot` gives on the old path, less the old tick's RNG and scatter
   * serial, which the new tick does not keep (review 1047). Old frames keep both for the frozen fixture.
   */
  frame(): Snapshot {
    const frame = frameOf(this.mirror.s, this.presentation()) as Snapshot & { scatterSerial?: number };
    delete frame.rng; delete frame.scatterSerial;
    return frame;
  }

  /** The physics presentation of the mirror's last tick, in body order. */
  presentation(): FramePresentation {
    const s = this.mirror.s, ids = this.mirror.ctx.ids;
    const roster = new Map(s.players.map((p, i) => [ids.actorOfPlayer.get(p.id)!, i as PlayerIdx] as const));
    const bodies: NumericPhysicsBody[] = [], actorBody = new Map<number, BodyId>();
    for (const pose of [...this.mirror.poses.values()].sort((a, b) => bodyOrder(a.body, b.body))) {
      const key = bodyKey(pose.body), life = this.mirror.lives.get(key);
      if (!life) throw new RangeError(`tick-frame: ${key} has a pose and no lifetime`);
      const described = this.#describe(pose.body, roster);
      if (!described) continue;
      if (pose.body.kind === 'actor') actorBody.set(pose.body.id, life.id);
      bodies.push(bodyOf(life, described, pose, this.mirror.lives.placed(key)));
    }
    const tethers: NumericPhysicsTether[] = [], hookFlights: NumericHookFlight[] = [];
    for (const [id, hook] of [...this.mirror.hooks].sort((a, b) => a[0] - b[0])) {
      const a = actorBody.get(hook.owner), tether = id as TetherId;
      if (a === undefined) continue;
      if (hook.phase.kind === 'pulling') {
        const b = actorBody.get(hook.phase.target);
        if (b !== undefined) tethers.push({ id: tether, a, b });
      } else hookFlights.push({ id: tether, a, casterIdx: roster.get(hook.owner)!, x: hook.phase.position[0], y: hook.phase.position[1] });
    }
    return { physicsProfile: s.version, bodies, tethers, hookFlights };
  }

  /** A body's kind, shape and owner, or null for one the frame does not draw. */
  #describe(body: BodyRef, roster: ReadonlyMap<number, PlayerIdx>): Described | null {
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

type Described = { kind: 'actor' | 'prop'; shape: Shape; owner: PhysicsBodyOwner };

/** A presentation body, in the old capture's field order, so a frame's JSON reads as the old one did. */
function bodyOf(life: BodyLife, d: Described, pose: PoseEntry, placed: boolean): NumericPhysicsBody {
  return { id: life.id, kind: d.kind, shape: d.shape as BodyShape, x: pose.at[0], y: pose.at[1], angle: pose.angle, vx: pose.velocity[0], vy: pose.velocity[1],
    omega: pose.spin, sleeping: pose.sleeping, generation: life.generation, owner: d.owner, ...(placed ? { discontinuity: 'placed' as const } : {}) };
}
