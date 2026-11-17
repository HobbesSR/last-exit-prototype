import type { BodyId, PropId, TetherId } from '../types.ts';

/** Match-local presentation domains, independent of gameplay serials and backend generations/handles.
 * Weak lifetime keys distinguish removal/re-admission even when no capture observes the gap. */
export class PhysicsIdentities {
  private bodySerial = 0;
  private propSerial = 0;
  private tetherSerial = 0;
  private bodies = new WeakMap<object, BodyId>();
  private props = new Map<string, PropId>();
  private tethers = new WeakMap<object, TetherId>();

  body(lifetime: object): BodyId {
    let id = this.bodies.get(lifetime);
    if (id === undefined) { id = ++this.bodySerial as BodyId; this.bodies.set(lifetime, id); }
    return id;
  }
  prop(label: string): PropId {
    let id = this.props.get(label);
    if (id === undefined) { id = ++this.propSerial as PropId; this.props.set(label, id); }
    return id;
  }
  /** Reserve at hook launch, independently of later presentation captures. */
  newTether(): TetherId { return ++this.tetherSerial as TetherId; }
  /** Ordinary constraints use their admitted frozen spec. Hooks reserve explicitly at launch. */
  tether(lifetime: object): TetherId {
    let id = this.tethers.get(lifetime);
    if (id === undefined) { id = this.newTether(); this.tethers.set(lifetime, id); }
    return id;
  }
}
