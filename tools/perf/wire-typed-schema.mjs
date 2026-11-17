// #1130 field-typed comparison: one per-field type model for the v4 players+bodies slice, the protobuf-shaped
// native objects it implies, and the generic converter between projection objects and those native objects.
// Both backends (descriptor D and protobuf P) are generated from the native model and encode the same native
// objects, so they differ only in their wire formats. Browser-safe (no imports): field names come from
// wire-typed-fields.mjs (the projection owners), this file supplies their types (24.3) and refuses a field list
// it cannot type or a type with no declared field. It is not a privacy list: disclosure stays with the projection.
//
// Typed field types: 'uint' (uint32) 'sint' (int32) 'f32m' (Rapier float32 metres x 40, 24.3 proposal 1)
// 'f32' 'f64' 'exact' (any finite number, kept exact; content-derived values) 'bool' 'str' { enum: TABLE }
// a record name, { list: T }, { nullable: T }, { layer: T } (frame-layers / discovery envelope),
// { enumMap: { key: TABLE, value: T } }, { union: { variant: Record } } (discriminated by `kind`).

export const SCALE = 40;
export const SLICE_STATE = ['version', 'duration', 'cellChargeTicks', 'tick', 'phase', 'hazardX', 'slots', 'directed', 'contestantsActive',
  'physicsProfile', 'bodies', 'predictionMotor', 'predictionTethered', 'hookActive', 'self', 'players'];
export function sliceMessage(message) {
  const state = {};
  for (const key of SLICE_STATE) if (key in message.state) state[key] = message.state[key];
  return { type: message.type, state };
}

const PHASE = { enum: 'PHASES' }, STATUS = { enum: 'PLAYER_STATUSES' };
const STATE_TYPES = { version: 'str', duration: 'uint', cellChargeTicks: 'uint', tick: 'uint', phase: PHASE, hazardX: 'sint', slots: 'uint',
  directed: 'bool', contestantsActive: 'uint', physicsProfile: 'str', bodies: { layer: 'Body' }, predictionMotor: 'Motor',
  predictionTethered: 'bool', hookActive: 'bool', self: 'Own', players: { list: 'Observed' } };
const STATE_REQUIRED = ['version', 'duration', 'cellChargeTicks', 'tick', 'phase', 'hazardX', 'slots', 'directed', 'contestantsActive', 'players'];
const OWN_TYPES = { x: 'exact', y: 'exact', hp: 'exact', maxHp: 'exact', shield: 'exact', keys: 'uint', weapon: 'uint', kills: 'uint', level: 'uint',
  status: STATUS, cooldown: 'exact', attackCd: 'exact', railCd: 'uint', cloak: 'uint', revealed: 'uint', boost: 'uint', stun: 'uint', heading: 'f64',
  lastSeq: 'sint', inputStalled: 'uint', inputMargin: 'sint', inventory: { list: { nullable: 'Item' } }, selectedSlot: 'uint',
  reserves: { enumMap: { key: 'AMMO_FAMILIES', value: 'uint' } }, reload: { nullable: 'Reload' }, charging: { nullable: 'str' },
  respawnAt: { nullable: 'uint' }, cell: 'Item', nodeId: 'str', discovered: { layer: 'uint' }, playerIdx: 'uint', heard: { list: 'Heard' } };
const OBSERVED_TYPES = { playerIdx: 'uint', heading: 'f64', status: STATUS, hp: 'exact', maxHp: 'exact', shield: 'exact', weapon: 'uint',
  cloak: 'uint', revealed: 'uint', x: 'exact', y: 'exact' };
const ITEM_TYPES = { id: 'uint', x: 'exact', y: 'exact', kind: { enum: 'ITEM_KINDS' }, weaponType: { enum: 'WEAPONS' }, ammo: 'uint', charge: 'uint',
  count: 'uint', buildingId: 'str', droppedBy: 'str', pickupAfter: 'uint', nodeId: 'str', tier: 'uint', instanceId: 'uint', lineageId: 'uint',
  quality: 'uint', family: { enum: 'AMMO_FAMILIES' } };
const BODY_TYPES = { id: 'uint', kind: { enum: 'BODY_KINDS' }, shape: { union: { circle: 'ShapeCircle', box: 'ShapeBox', convex: 'ShapeConvex' } },
  x: 'f32m', y: 'f32m', angle: 'f32', vx: 'f32m', vy: 'f32m', omega: 'f32', sleeping: 'bool', generation: 'uint',
  owner: { union: { actor: 'OwnerActor', item: 'OwnerItem', prop: 'OwnerProp' } }, discontinuity: { enum: 'DISCONTINUITIES' } };
const OWNER_TYPES = { playerIdx: 'uint', itemId: 'uint', propId: 'uint' };
const SHAPE_TYPES = { radius: 'exact', hx: 'exact', hy: 'exact', vertices: { list: 'Vertex' } };

function typed(name, fields, types, optional = () => false) {
  const missing = fields.filter(f => !(f in types)), extra = Object.keys(types).filter(t => !fields.includes(t));
  if (missing.length || extra.length) throw new Error(`${name}: untyped fields [${missing}] or undeclared types [${extra}]`);
  return { fields: fields.map(f => ({ name: f, type: types[f], ...(optional(f) ? { optional: true } : {}) })) };
}
const pick = (types, keys) => Object.fromEntries(keys.map(k => [k, types[k]]));

/** The typed model: field names from the owners' lists, types from 24.3. */
export function typedModel(lists) {
  const observedRequired = lists.observed.filter(k => k !== 'x' && k !== 'y');
  const ownerName = { actor: 'OwnerActor', item: 'OwnerItem', prop: 'OwnerProp' }, shapeName = { circle: 'ShapeCircle', box: 'ShapeBox', convex: 'ShapeConvex' };
  for (const [kind, name] of Object.entries(ownerName)) if (!lists.owners[kind]) throw new Error(`owner kind ${kind} missing`);
  for (const [kind, name] of Object.entries(shapeName)) if (!lists.shapes[kind]) throw new Error(`shape kind ${kind} missing`);
  return {
    version: 1,
    enums: lists.enums,
    root: 'State',
    records: {
      State: typed('State', [...lists.frame, ...SLICE_STATE.filter(k => !lists.frame.includes(k))], STATE_TYPES, f => !STATE_REQUIRED.includes(f)),
      Motor: typed('Motor', ['acceleration', 'braking', 'maxSpeed', 'surfaces'], { acceleration: 'exact', braking: 'exact', maxSpeed: 'exact', surfaces: 'bool' }),
      // Own fields are copied only when present on the source player, so every one is optional.
      Own: typed('Own', lists.own, OWN_TYPES, () => true),
      Observed: typed('Observed', lists.observed, OBSERVED_TYPES, f => !observedRequired.includes(f)),
      Heard: typed('Heard', lists.heard, { x: 'exact', y: 'exact', tick: 'uint', until: 'uint' }),
      Item: typed('Item', lists.item, ITEM_TYPES, () => true),
      Reload: { fields: [{ name: 'slot', type: 'uint' }, { name: 'instanceId', type: 'uint' }, { name: 'until', type: 'uint' }] },
      Body: typed('Body', lists.body.order, BODY_TYPES, f => lists.body.optional.includes(f)),
      ...Object.fromEntries(Object.entries(ownerName).map(([kind, name]) => [name, typed(name, lists.owners[kind], pick(OWNER_TYPES, lists.owners[kind]))])),
      ...Object.fromEntries(Object.entries(shapeName).map(([kind, name]) => [name, typed(name, lists.shapes[kind], pick(SHAPE_TYPES, lists.shapes[kind]))])),
      Vertex: typed('Vertex', lists.vertex, { x: 'exact', y: 'exact' }),
    },
  };
}

// ---- Native model and converter ---------------------------------------------------------------------------
// Native types: 'uint32' 'sint32' 'float' 'double' 'bool' 'string' { enum: TABLE } or a record name; a field may be
// `repeated`, `required` (always present; positional in D, checked by the converter for P) or in a `oneof` group.
// `exact` marks a double that came from an 'exact' typed field (D may encode it in its per-value form).

const fail = why => { throw new TypeError(why); };
const bad = why => { throw new RangeError(why); };
const own = Object.prototype.hasOwnProperty;
const cap = s => s[0].toUpperCase() + s.slice(1);
const finite = v => { if (typeof v !== 'number' || !Number.isFinite(v)) fail('expected finite number'); return v === 0 ? 0 : v; };
const SCALARS = {
  uint: { type: 'uint32', to: v => (Number.isInteger(v) && v >= 0 && v < 2 ** 32 ? v : fail(`expected uint32, got ${v}`)), from: v => v },
  sint: { type: 'sint32', to: v => (Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31 ? v : fail(`expected int32, got ${v}`)), from: v => v },
  f32m: { type: 'float', to: v => { const m = Math.fround(finite(v) / SCALE); if (m * SCALE !== v) fail(`not float32 metres: ${v}`); return m; }, from: m => finite(m) * SCALE },
  f32: { type: 'float', to: v => (Math.fround(finite(v)) === v ? (v === 0 ? 0 : v) : fail(`not float32: ${v}`)), from: finite },
  f64: { type: 'double', to: finite, from: finite },
  exact: { type: 'double', exact: true, to: finite, from: finite },
  bool: { type: 'bool', to: v => (typeof v === 'boolean' ? v : fail('expected boolean')), from: v => v },
  // Lone surrogates are refused where they would enter (protobuf strings are UTF-8): one rule for both backends.
  str: { type: 'string', to: v => (typeof v === 'string' && v.isWellFormed() && v.length <= 4096 ? v : fail('string refused')), from: v => v },
};

/** Builds { records (native model), toNative(message), fromNative(native) } from the typed model. */
export function nativeModel(model) {
  const records = {}, plans = new Map();
  const enumPlan = table => {
    const values = model.enums[table]; if (!values) throw new Error(`unknown enum ${table}`);
    const index = new Map(values.map((v, i) => [v, i]));
    return { type: { enum: table }, to: v => (index.has(v) ? index.get(v) : fail(`${v} not in ${table}`)), from: i => (i >= 0 && i < values.length ? values[i] : bad(`bad ${table} index ${i}`)) };
  };
  // A value (list element or singular field): scalar, enum or record.
  const value = type => {
    if (typeof type === 'string') return SCALARS[type] ?? record(type);
    if (type.enum) return enumPlan(type.enum);
    if (type.nullable) { // inside a list: a slot record whose value is absent for null
      const inner = value(type.nullable), name = `Slot${cap(nameOf(type.nullable))}`;
      records[name] ??= { fields: [{ name: 'value', type: inner.type }] };
      return { type: name, to: v => (v === null ? {} : { value: inner.to(v) }), from: n => (own.call(n, 'value') ? inner.from(n.value) : null) };
    }
    throw new Error(`no value form for ${JSON.stringify(type)}`);
  };
  const nameOf = type => (typeof type === 'string' ? type : type.enum ?? JSON.stringify(type));
  const listWrapper = elem => {
    const name = `List${cap(nameOf(elem.type))}`;
    records[name] ??= { fields: [{ name: 'items', type: elem.type, repeated: true }] };
    return { type: name, to: v => { if (!Array.isArray(v)) fail('expected list'); return { items: v.map(elem.to) }; },
      from: n => (own.call(n, 'items') ? n.items.map(elem.from) : []) };
  };
  function record(name) {
    if (plans.has(name)) return plans.get(name);
    const def = model.records[name]; if (!def) throw new Error(`unknown record ${name}`);
    const plan = { type: name }; plans.set(name, plan);
    const fields = [], steps = [];
    for (const f of def.fields) steps.push(field(f, fields));
    records[name] = { fields };
    const known = new Set(def.fields.map(f => f.name));
    plan.to = v => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`expected ${name} record`);
      for (const k in v) if (v[k] !== undefined && !known.has(k)) fail(`field ${k} is not in ${name}`);
      const out = {};
      for (const s of steps) { const x = v[s.name]; if (x === undefined) { if (!s.optional) fail(`${name}.${s.name} missing`); } else s.to(x, out); }
      return out;
    };
    plan.from = n => {
      const out = {};
      for (const s of steps) { const x = s.from(n); if (x !== undefined) out[s.name] = x; else if (!s.optional) bad(`${name}.${s.name} missing`); }
      return out;
    };
    return plan;
  }
  // One typed field: pushes its native field(s) and returns { name, optional, to(value, out), from(native) }.
  function field({ name, type, optional = false }, fields) {
    const single = (plan, required = !optional) => {
      fields.push({ name, type: plan.type, ...(plan.exact ? { exact: true } : {}), ...(required ? { required: true } : {}) });
      return { name, optional, to: (v, out) => { out[name] = plan.to(v); }, from: n => (own.call(n, name) ? plan.from(n[name]) : undefined) };
    };
    if (typeof type === 'string' || type.enum) return single(value(type));
    if (type.list) {
      const elem = value(type.list);
      if (!optional) { // required list: repeated, absent means empty
        fields.push({ name, type: elem.type, repeated: true, ...(elem.exact ? { exact: true } : {}) });
        return { name, optional, to: (v, out) => { if (!Array.isArray(v)) fail('expected list'); if (v.length) out[name] = v.map(elem.to); },
          from: n => (own.call(n, name) ? n[name].map(elem.from) : []) };
      }
      return single(listWrapper(elem));
    }
    if (type.nullable) {
      const inner = value(type.nullable), nul = `${name}Null`;
      fields.push({ name, type: inner.type, oneof: `${name}OrNull` }, { name: nul, type: 'bool', oneof: `${name}OrNull` });
      return { name, optional, to: (v, out) => { if (v === null) out[nul] = true; else out[name] = inner.to(v); },
        from: n => (own.call(n, name) ? inner.from(n[name]) : own.call(n, nul) ? (n[nul] === true ? null : bad('bad null flag')) : undefined) };
    }
    if (type.layer) {
      const elem = value(type.layer), list = listWrapper(elem), ids = listWrapper(SCALARS.uint);
      const layerName = `Layer${cap(nameOf(type.layer))}`;
      records[layerName] ??= { fields: [{ name: 'plain', type: list.type }, { name: 'k', type: 'uint32' }, { name: 'all', type: list.type },
        { name: 'set', type: list.type }, { name: 'drop', type: ids.type }] };
      const plan = {
        type: layerName,
        to: v => {
          if (Array.isArray(v)) return { plain: list.to(v) };
          if (!v || typeof v !== 'object') fail('expected layer');
          for (const k in v) if (v[k] !== undefined && !['k', 'all', 'set', 'drop'].includes(k)) fail(`unknown layer key ${k}`);
          const out = { k: SCALARS.uint.to(v.k) };
          if (v.all !== undefined) out.all = list.to(v.all);
          if (v.set !== undefined) out.set = list.to(v.set);
          if (v.drop !== undefined) out.drop = ids.to(v.drop);
          return out;
        },
        from: n => {
          if (own.call(n, 'plain')) { if (own.call(n, 'k') || own.call(n, 'all') || own.call(n, 'set') || own.call(n, 'drop')) bad('mixed layer'); return list.from(n.plain); }
          if (!own.call(n, 'k')) bad('layer without version');
          const out = { k: n.k };
          if (own.call(n, 'all')) out.all = list.from(n.all);
          if (own.call(n, 'set')) out.set = list.from(n.set);
          if (own.call(n, 'drop')) out.drop = ids.from(n.drop);
          return out;
        },
      };
      return single(plan);
    }
    if (type.enumMap) {
      const key = enumPlan(type.enumMap.key), val = value(type.enumMap.value), entry = `Entry${cap(type.enumMap.key)}`;
      records[entry] ??= { fields: [{ name: 'key', type: key.type, required: true }, { name: 'value', type: val.type, required: true }] };
      const list = listWrapper({ type: entry, to: ([k, v]) => ({ key: key.to(k), value: val.to(v) }), from: e => [key.from(e.key), val.from(e.value)] });
      const plan = { type: list.type,
        to: v => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('expected map'); return list.to(Object.entries(v).filter(([, x]) => x !== undefined)); },
        from: n => { const out = {}; for (const [k, x] of list.from(n)) { if (own.call(out, k)) bad('duplicate map key'); out[k] = x; } return out; } };
      return single(plan);
    }
    if (type.union) {
      // A oneof with one member per variant. A variant of exactly one scalar field is flattened to that scalar.
      const variants = Object.entries(type.union).map(([kind, rec]) => {
        const def = model.records[rec], member = `${name}${cap(kind)}`;
        if (def.fields.length === 1 && typeof def.fields[0].type === 'string' && SCALARS[def.fields[0].type]) {
          const f = def.fields[0], s = SCALARS[f.type];
          fields.push({ name: member, type: s.type, oneof: name, ...(s.exact ? { exact: true } : {}) });
          return { kind, member, to: v => { for (const k in v) if (k !== 'kind' && k !== f.name && v[k] !== undefined) fail(`field ${k} is not in ${rec}`); return s.to(v[f.name]); },
            from: x => ({ kind, [f.name]: s.from(x) }) };
        }
        const plan = record(rec);
        fields.push({ name: member, type: rec, oneof: name });
        return { kind, member, to: v => { const { kind: _, ...rest } = v; return plan.to(rest); }, from: x => ({ kind, ...plan.from(x) }) };
      });
      const byKind = new Map(variants.map(v => [v.kind, v]));
      return { name, optional,
        to: (v, out) => { const variant = byKind.get(v?.kind) ?? fail(`unknown ${name} kind ${v?.kind}`); out[variant.member] = variant.to(v); },
        from: n => {
          let found;
          for (const variant of variants) if (own.call(n, variant.member)) { if (found) bad(`${name}: two variants`); found = variant.from(n[variant.member]); }
          return found;
        } };
    }
    throw new Error(`unknown type ${JSON.stringify(type)}`);
  }
  const root = record(model.root);
  return {
    records, root: model.root, enums: model.enums, version: model.version,
    toNative: message => { if (message?.type !== 'state') fail('state messages only'); return root.to(message.state); },
    fromNative: native => ({ type: 'state', state: root.from(native) }),
  };
}

/** The descriptor codec's schema for the native model. `exact`: 'num' (D's per-value form) or 'f64'. */
export function descriptorSchema(native, { exact = 'num' } = {}) {
  const D = { uint32: 'uint', sint32: 'sint', float: 'f32', double: 'f64', bool: 'bool', string: 'str' };
  const type = f => (f.exact && f.type === 'double' ? exact : typeof f.type === 'object' ? 'uint' : D[f.type] ?? f.type);
  const records = Object.fromEntries(Object.entries(native.records).map(([name, r]) => [name, { fields: r.fields.map(f => ({
    name: f.name, type: f.repeated ? { list: type(f) } : type(f), ...(f.required || (f.repeated && !f.oneof) ? {} : { optional: true }),
  })) }]));
  // A required repeated field may be absent (empty) in the native object: optional in D too, so both agree.
  for (const r of Object.values(records)) for (const f of r.fields) if (f.type.list) f.optional = true;
  return { version: native.version, messages: { state: { id: 1, record: native.root } }, records };
}

/**
 * The protobuf schema for the native model, as a protobufjs JSON descriptor (Edition 2023: explicit presence,
 * packed repeated scalars). Field numbers follow declaration order; enums index the owners' tables.
 */
export function protoDescriptor(native) {
  const P = { uint32: 'uint32', sint32: 'sint32', float: 'float', double: 'double', bool: 'bool', string: 'string' };
  const nested = {};
  for (const [table, values] of Object.entries(native.enums))
    nested[`E${table}`] = { edition: '2023', values: Object.fromEntries(values.map((v, i) => [`${table}_${String(v).toUpperCase()}`, i])) };
  for (const [name, r] of Object.entries(native.records)) {
    const fields = {}, oneofs = {};
    r.fields.forEach((f, i) => {
      fields[f.name] = { type: typeof f.type === 'object' ? `E${f.type.enum}` : P[f.type] ?? f.type, id: i + 1, ...(f.repeated ? { rule: 'repeated' } : {}) };
      if (f.oneof) (oneofs[f.oneof] ??= { oneof: [] }).oneof.push(f.name);
    });
    nested[name] = { edition: '2023', fields, ...(Object.keys(oneofs).length ? { oneofs } : {}) };
  }
  return { nested };
}
