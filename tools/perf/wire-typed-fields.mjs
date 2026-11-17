// #1130 field-typed comparison: the v4 slice's field lists and enum tables, read from their owners rather than
// a second list (24.1, 24.4). String-declared fields come from the exported declarations; constructed fields
// (playerIdx, discovery, heard cues, observed records, physics bodies, owners and shapes) come from calling the
// owners on probes. Node only: it imports shared/. The browser receives the resulting plain lists.
import { FRAME_FIELDS, OWN_FIELDS, ITEM_FIELDS, ownPlayerFields, physicsBodyFields } from '../../shared/simulation/projection-contract.ts';
import { observed } from '../../shared/simulation/visibility.ts';
import * as tables from '../../shared/enum-tables.ts';

export function typedFieldLists() {
  const own = OWN_FIELDS.split(' ');
  const probe = Object.fromEntries(own.map(k => [k, 0]));
  Object.assign(probe, { inventory: [], cell: null });
  const projected = ownPlayerFields(probe, { discovered: new Set([1]) }, [{ x: 0, y: 0, tick: 0, until: 1 }], 0);
  const ownConstructed = Object.keys(projected).filter(k => !own.includes(k));
  const shape = { circle: { kind: 'circle', radius: 1 }, box: { kind: 'box', hx: 1, hy: 1 }, convex: { kind: 'convex', vertices: [{ x: 0, y: 0 }] } };
  const owner = { actor: { kind: 'actor', playerIdx: 0 }, item: { kind: 'item', itemId: 1 }, prop: { kind: 'prop', propId: 0 } };
  const base = { id: 1, kind: 'actor', x: 0, y: 0, angle: 0, vx: 0, vy: 0, omega: 0, sleeping: false, generation: 1, owner: owner.actor };
  const body = b => physicsBodyFields(b, true);
  const order = Object.keys(physicsBodyFields({ ...base, shape: shape.circle, discontinuity: 'placed' }, true));
  const required = Object.keys(physicsBodyFields({ ...base, shape: shape.circle }, false));
  return {
    frame: FRAME_FIELDS.split(' '),
    own: [...own, ...ownConstructed], heard: Object.keys(projected.heard[0]),
    observed: Object.keys(observed({ ...probe, status: 'active' }, 0, true)),
    item: ITEM_FIELDS.split(' '),
    // `shape` is omitted when the target keyframe already holds it (24.4), so it is optional too.
    body: { order, optional: [...order.filter(k => !required.includes(k)), 'shape'] },
    owners: Object.fromEntries(Object.entries(owner).map(([kind, o]) => [kind, Object.keys(body({ ...base, shape: shape.circle, owner: o }).owner).filter(k => k !== 'kind')])),
    shapes: Object.fromEntries(Object.entries(shape).map(([kind, s]) => [kind, Object.keys(body({ ...base, shape: s }).shape).filter(k => k !== 'kind')])),
    vertex: Object.keys(body({ ...base, shape: shape.convex }).shape.vertices[0]),
    enums: {
      PHASES: [...tables.PHASES], ROLES: [...tables.ROLES], KITS: [...tables.KITS], WEAPONS: [...tables.WEAPONS],
      AMMO_FAMILIES: [...tables.AMMO_FAMILIES], ITEM_KINDS: [...tables.ITEM_KINDS], BODY_KINDS: [...tables.BODY_KINDS],
      // No runtime table owns PlayerStatus (shared/types.ts declares the union only), so this schema declares it.
      PLAYER_STATUSES: ['active', 'eliminated', 'respawning', 'escaped', 'stranded', 'transit'],
      DISCONTINUITIES: ['placed'],
    },
  };
}
