// #1130: the closed players+bodies slice, its descriptor schema and msgpackr's provisioned structures.
// Browser-safe (no imports). Field *names* come from wire-slice-fields.mjs (the projection owners);
// this file supplies only their wire *types*, and refuses a field list it cannot type or a type with
// no declared field. It is not a privacy list: disclosure stays with the projection.

/** The slice of a production state message: envelope header, players and the bodies layer. */
export const SLICE_STATE = ['version', 'tick', 'phase', 'directed', 'contestantsActive', 'physicsProfile', 'players', 'bodies', 'predictionMotor', 'predictionTethered', 'hookActive'];
export function sliceMessage(message) {
  const state = {};
  for (const key of SLICE_STATE) if (key in message.state) state[key] = message.state[key];
  return { type: message.type, state };
}

const TURN = 65536 / (2 * Math.PI);
/** 24.1's candidate quanta for this slice's fields (a size probe only). */
export const QUANTA = {
  Own: { x: 256, y: 256, heading: TURN }, Observed: { x: 256, y: 256, heading: TURN },
  Body: { x: 256, y: 256, vx: 256, vy: 256, angle: TURN, omega: 4096 },
};

// Wire types per field. Every number is 'num' (integer, exact float32 or float64, chosen per value).
const ITEM_TYPES = { id: 'id', x: 'num', y: 'num', kind: 'str', weaponType: 'str', ammo: 'num', charge: 'num', count: 'num',
  buildingId: 'str', droppedBy: 'str', pickupAfter: 'num', nodeId: 'str', tier: 'num', instanceId: 'id', lineageId: 'id', quality: 'num', family: 'str' };
const OWN_TYPES = { id: 'str', name: 'str', role: 'str', kit: 'str', seat: 'uint', x: 'num', y: 'num', hp: 'num', maxHp: 'num', shield: 'num',
  keys: 'num', weapon: 'uint', kills: 'num', level: 'num', status: 'str', cooldown: 'num', attackCd: 'num', railCd: 'num', cloak: 'num',
  revealed: 'num', boost: 'num', stun: 'num', heading: 'num', lastSeq: 'num', inputStalled: 'num',
  inventory: { list: { nullable: 'Item' } }, selectedSlot: 'uint', reserves: { map: 'num' }, reload: { nullable: 'Reload' },
  charging: { nullable: 'str' }, respawnAt: { nullable: 'num' }, cell: 'Item', nodeId: 'str', discovered: { layer: 'uint' }, heard: { list: 'Heard' } };
const OBSERVED_TYPES = Object.fromEntries(['id', 'role', 'kit', 'name', 'x', 'y', 'heading', 'status', 'hp', 'maxHp', 'shield', 'weapon', 'cloak', 'revealed', 'seat'].map(k => [k, OWN_TYPES[k]]));
const BODY_TYPES = { id: 'id', kind: { enum: ['actor', 'prop'] }, shape: 'Shape', x: 'num', y: 'num', angle: 'num', vx: 'num', vy: 'num', omega: 'num',
  sleeping: 'bool', generation: 'uint', actorId: 'str', itemId: 'id', discontinuity: { enum: ['placed'] } };
const SHAPE_TYPES = { circle: { kind: { const: 'circle' }, radius: 'num' }, box: { kind: { const: 'box' }, hx: 'num', hy: 'num' },
  convex: { kind: { const: 'convex' }, vertices: { list: 'Vertex' } } };

function typed(name, fields, types, optional = () => false) {
  const missing = fields.filter(f => !(f in types)), extra = Object.keys(types).filter(t => !fields.includes(t));
  if (missing.length || extra.length) throw new Error(`${name}: untyped fields [${missing}] or undeclared types [${extra}]`);
  return { fields: fields.map(f => ({ name: f, type: types[f], ...(optional(f) ? { optional: true } : {}) })) };
}

/** The descriptor schema for the slice and the two specimens, from the derived field lists. */
export function sliceSchema(lists) {
  const observedSet = new Set(lists.observed), observedRequired = lists.observed.filter(k => k !== 'seat');
  const shapeKinds = Object.keys(lists.shapes);
  return {
    version: 1,
    messages: { state: { id: 1, record: 'StateMessage' }, ping: { id: 2, record: 'Ping' }, input: { id: 3, record: 'Input' } },
    records: {
      StateMessage: { fields: [{ name: 'state', type: 'State' }] },
      State: typed('State', SLICE_STATE, { version: 'str', tick: 'uint', phase: 'str', directed: 'bool', contestantsActive: 'uint', physicsProfile: 'str',
        players: { list: 'Player' }, bodies: { layer: 'Body' }, predictionMotor: 'Motor', predictionTethered: 'bool', hookActive: 'bool' },
        f => !['version', 'tick', 'phase', 'players'].includes(f)),
      Motor: { fields: [{ name: 'acceleration', type: 'num' }, { name: 'braking', type: 'num' }, { name: 'maxSpeed', type: 'num' }, { name: 'surfaces', type: 'bool' }] },
      // A record whose keys are all observed fields is an observed record; anything else is the viewer's own.
      // An own record with exactly the observed fields would decode identically either way.
      Player: { union: ['Observed', 'Own'], pick: p => observedRequired.every(k => p[k] !== undefined)
        && Object.keys(p).every(k => observedSet.has(k) || p[k] === undefined) ? 0 : 1 },
      Observed: typed('Observed', lists.observed, OBSERVED_TYPES, f => f === 'seat'),
      // Own fields are copied only when present on the source player, so every one is optional on the wire.
      Own: typed('Own', lists.own, OWN_TYPES, () => true),
      Heard: typed('Heard', lists.heard, { x: 'num', y: 'num', tick: 'num', until: 'num' }),
      Item: typed('Item', lists.item, ITEM_TYPES, () => true),
      Reload: { fields: [{ name: 'slot', type: 'uint' }, { name: 'instanceId', type: 'id' }, { name: 'until', type: 'num' }] },
      Body: typed('Body', lists.body.order, BODY_TYPES, f => lists.body.optional.includes(f)),
      Shape: { union: shapeKinds.map(k => `Shape_${k}`), pick: s => shapeKinds.indexOf(s.kind) },
      ...Object.fromEntries(shapeKinds.map(k => [`Shape_${k}`, typed(`Shape_${k}`, lists.shapes[k], SHAPE_TYPES[k])])),
      Vertex: typed('Vertex', lists.vertex, { x: 'num', y: 'num' }),
      Ping: { fields: [{ name: 'token', type: 'str' }, { name: 'rtt', type: { nullable: 'num' } }] },
      Input: { fields: [{ name: 'seq', type: 'num' }, ...['x', 'y', 'aim'].map(name => ({ name, type: 'num', optional: true })),
        ...['attack', 'skill', 'interact', 'drop', 'sneak', 'reload'].map(name => ({ name, type: 'bool', optional: true })),
        { name: 'slot', type: 'uint', optional: true }, { name: 'moveSlot', type: 'SlotMove', optional: true },
        { name: 'dropAmmo', type: 'DropAmmo', optional: true }, { name: 'transit', type: 'str', optional: true }] },
      SlotMove: { fields: [{ name: 'from', type: 'uint' }, { name: 'to', type: 'uint' }] },
      DropAmmo: { fields: [{ name: 'family', type: 'str' }, { name: 'count', type: 'num' }] },
    },
  };
}

/**
 * msgpackr shared structures derived from the same lists, not learned from a corpus: the record
 * shapes the projection owners build in a fixed key order (observed players, physics bodies and
 * shapes, prediction motor, heard cues). Own players and items keep source key order, so they
 * are left to self-contained inline definitions.
 */
export function provisionedStructures(lists) {
  const out = [];
  out.push(lists.observed.filter(k => k !== 'seat'), lists.observed);
  const { required, optional } = lists.body, full = ['vx', 'vy', 'omega', 'sleeping'].filter(k => optional.includes(k));
  const tails = optional.filter(k => !full.includes(k)); // actorId, itemId, discontinuity, in owner order
  for (const withFull of [false, true]) for (let mask = 0; mask < 2 ** tails.length; mask++) {
    const head = withFull ? [...required.slice(0, required.indexOf('generation')), ...full, 'generation'] : required;
    out.push([...head, ...tails.filter((_, i) => mask & (1 << i))]);
  }
  for (const keys of Object.values(lists.shapes)) out.push(keys);
  out.push(lists.vertex, ['acceleration', 'braking', 'maxSpeed', 'surfaces'], lists.heard);
  return out;
}
