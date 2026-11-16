// #1130: the slice's field lists, read from the projection owners rather than a second list (24.1).
// String-declared fields come from the exported declarations; constructed fields (discovery, heard
// cues, a gladiator-less seat, physics body/shape records) come from calling the owners on probes.
// Node only: it imports shared/. The browser receives the resulting plain lists.
import { OWN_FIELDS, ITEM_FIELDS, ownPlayerFields, physicsBodyFields } from '../../shared/simulation/projection-contract.ts';
import { OBSERVED, observed } from '../../shared/simulation/visibility.ts';

export function sliceFieldLists() {
  const own = OWN_FIELDS.split(' ');
  const probe = Object.fromEntries(own.map(k => [k, 0]));
  Object.assign(probe, { inventory: [], cell: null });
  const projected = ownPlayerFields(probe, { discovered: new Set([1]) }, [{ x: 0, y: 0, tick: 0, until: 1 }]);
  const ownConstructed = Object.keys(projected).filter(k => !own.includes(k));
  const observedKeys = Object.keys(observed({ ...Object.fromEntries(OBSERVED.map(k => [k, 0])), seat: 0 }));
  const shape = { circle: { kind: 'circle', radius: 1 }, box: { kind: 'box', hx: 1, hy: 1 }, convex: { kind: 'convex', vertices: [{ x: 0, y: 0 }] } };
  const base = { id: 'b', kind: 'actor', x: 0, y: 0, angle: 0, vx: 0, vy: 0, omega: 0, sleeping: false, generation: 1 };
  const required = Object.keys(physicsBodyFields({ ...base, shape: shape.circle }, false));
  const all = Object.keys(physicsBodyFields({ ...base, shape: shape.circle, actorId: 'a', itemId: 'i', discontinuity: 'placed' }, true));
  const shapes = Object.fromEntries(Object.entries(shape).map(([kind, s]) => [kind, Object.keys(physicsBodyFields({ ...base, shape: s }).shape)]));
  const vertex = Object.keys(physicsBodyFields({ ...base, shape: shape.convex }).shape.vertices[0]);
  return {
    own: [...own, ...ownConstructed], heard: Object.keys(projected.heard[0]), observed: observedKeys,
    item: ITEM_FIELDS.split(' '),
    body: { required, optional: all.filter(k => !required.includes(k)), order: all }, shapes, vertex,
  };
}
