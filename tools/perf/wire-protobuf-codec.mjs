// #1130 follow-up candidate P: stock protobuf (protobufjs) on the same closed slice as D. Measurement code, not
// production. The protobuf schema is generated mechanically from D's descriptor schema (one schema source, two
// backends), and a generic adapter, compiled from the same schema, maps between the JSON-shaped projection and
// protobuf's data model. Browser-safe: the caller passes the protobufjs module (light build or full).
//
// Mapping (the data-model gap; every row is adapter work protobuf itself does not do):
//   'uint' uint64 (narrow32: oneof { uint32 _s | uint64 _l }) · 'bool' bool · 'str' string (lone surrogates refused on encode; protobufjs refuses invalid UTF-8)
//   'num'  numbers:'double' → double (-0 written as 0, as JSON)
//          numbers:'narrow' → oneof { sint64 _i | float _f | double _d }, chosen per value exactly as D chooses
//          numbers:'narrow32' → oneof { sint32 _i | sint64 _l | float _f | double _d }: 32-bit members because
//          protobufjs decodes 64-bit varints through a slower long path, at the cost of more field numbers
//   'id'   oneof { string _s | sint64 _n }          { enum } proto enum (index)      { const } no field; restored
//   { nullable: T } oneof { NullValue _null | T }    union → oneof of variant messages in the parent
//   { list: T } repeated (elements needing a oneof are wrapped in a message); { map: T } map<string, T>
//   { layer: T } message { oneof { plain | keyed { k, all, set, drop } } } with list wrappers carrying presence
//   An optional list or map field is wrapped in a message: protobuf cannot tell an absent list from an empty one.
// Decode returns plain objects (no prototype defaults); a missing required field refuses, as in D.
// Framing: [format, schema version, message id, varint body length] then the protobuf message. Protobuf has no end
// marker (a message cut at a field boundary, or with fields appended, is still valid), so the length is what refuses
// truncated and trailing bytes.

const FORMAT = 0xd3;
const fail = why => { throw new TypeError(why); };
const bad = why => { throw new RangeError(why); };
const own = Object.prototype.hasOwnProperty;

export function createProtobufCodec(protobuf, schema, options = {}) {
  const numbers = options.numbers ?? 'double', limits = { maxBytes: 1 << 20, maxString: 1 << 12, ...options.limits };
  if (protobuf.util.Long) { protobuf.util.Long = null; protobuf.configure(); } // 64-bit varints decode to JS numbers
  // Edition 2023: explicit presence (a zero is sent when set), packed repeated scalars, UTF-8 verified on decode.
  const EDITION = '2023', nested = { NullValue: { edition: EDITION, values: { NULL_VALUE: 0 } } };
  const plans = new Map(), compiling = new Set(), wrappers = new Map();
  let serial = 0;
  const fresh = base => `${base.replace(/[^A-Za-z0-9_]/g, '_')}_${serial++}`;

  const str = v => { if (typeof v !== 'string') fail('expected string'); if (v.length > limits.maxString || !v.isWellFormed()) fail('string refused (length or lone surrogate)'); return v; };
  const finite = v => { if (!Number.isFinite(v)) bad('non-finite number'); return v; };
  const same = v => v;
  const single = (type, enc = same, dec = same, extra = {}) => ({ kind: 'single', proto: { type, ...extra }, enc, dec });
  const split = numbers === 'narrow32';
  if (!['double', 'narrow', 'narrow32'].includes(numbers)) throw new Error(`unknown numbers mode ${numbers}`);
  const numPlan = () => numbers !== 'double'
    ? { kind: 'alts', choose: v => { if (typeof v !== 'number' || !Number.isFinite(v)) fail('expected finite number');
        const k = Number.isInteger(v) && Math.abs(v) <= 2 ** 50 ? (split && Math.abs(v) >= 2 ** 31 ? 1 : 0) : Math.fround(v) === v ? 2 : 3;
        return split ? k : k === 0 ? 0 : k - 1; },
      members: [{ suffix: 'i', proto: { type: split ? 'sint32' : 'sint64' }, enc: v => (v === 0 ? 0 : v), dec: same },
        ...(split ? [{ suffix: 'l', proto: { type: 'sint64' }, enc: same, dec: same }] : []),
        { suffix: 'f', proto: { type: 'float' }, enc: same, dec: finite }, { suffix: 'd', proto: { type: 'double' }, enc: same, dec: finite }] }
    : single('double', v => { if (typeof v !== 'number' || !Number.isFinite(v)) fail('expected finite number'); return v === 0 ? 0 : v; }, finite);
  const uint64 = () => single('uint64', v => { if (!Number.isSafeInteger(v) || v < 0) fail('expected unsigned safe integer'); return v; },
      v => { if (!Number.isSafeInteger(v)) bad('integer out of range'); return v; });
  const SCALARS = {
    uint: () => (split
      ? { kind: 'alts', choose: v => (!Number.isSafeInteger(v) || v < 0 ? fail('expected unsigned safe integer') : v < 2 ** 32 ? 0 : 1),
        members: [{ suffix: 's', proto: { type: 'uint32' }, enc: same, dec: same }, { suffix: 'l', ...uint64() }] }
      : uint64()),
    bool: () => single('bool', v => { if (typeof v !== 'boolean') fail('expected boolean'); return v; }),
    str: () => single('string', str),
    num: numPlan,
    id: () => ({ kind: 'alts', choose: v => typeof v === 'string' ? 0 : Number.isSafeInteger(v) ? 1 : fail('expected string or safe-integer id'),
      members: [{ suffix: 's', proto: { type: 'string' }, enc: str, dec: same },
        { suffix: 'n', proto: { type: 'sint64' }, enc: same, dec: v => { if (!Number.isSafeInteger(v)) bad('id out of range'); return v; } }] }),
  };

  // A plan that a repeated field, a map value or a nullable can hold as one proto field.
  const wrap = (key, plan) => {
    if (plan.kind === 'single' && !plan.proto.rule && !plan.proto.keyType) return plan;
    let w = wrappers.get(key);
    if (!w) {
      const name = fresh(`W_${key}`); wrappers.set(key, w = { name });
      const record = message(name, [{ name: 'v', plan }]);
      Object.assign(w, record);
    }
    return single(w.name, v => w.enc({ v }), m => w.dec(m).v);
  };

  function plan(type) {
    if (typeof type === 'string') return SCALARS[type]?.() ?? named(type);
    if (type.enum) {
      const values = type.enum, name = fresh('E');
      nested[name] = { edition: EDITION, values: Object.fromEntries(values.map((_, i) => [`${name}_${i}`, i])) };
      return single(name, v => { const i = values.indexOf(v); if (i < 0) fail(`value ${v} is not in the declared enum`); return i; },
        i => (i >= 0 && i < values.length ? values[i] : bad('bad enum value')));
    }
    if ('const' in type) return { kind: 'const', value: type.const };
    if (type.nullable) {
      const inner = plan(type.nullable), members = inner.kind === 'alts' ? inner.members : [{ suffix: 'v', ...wrap(JSON.stringify(type.nullable), inner) }];
      const choose = inner.kind === 'alts' ? inner.choose : () => 0;
      return { kind: 'alts', choose: v => (v === null ? 0 : 1 + choose(v)),
        members: [{ suffix: 'null', proto: { type: 'NullValue' }, enc: () => 0, dec: () => null }, ...members] };
    }
    if (type.list) {
      const elem = wrap(JSON.stringify(type.list), plan(type.list));
      return { kind: 'single', presenceless: true, empty: () => [], proto: { type: elem.proto.type, rule: 'repeated' },
        enc: v => { if (!Array.isArray(v)) fail('expected list'); const out = new Array(v.length); for (let i = 0; i < v.length; i++) out[i] = elem.enc(v[i]); return out; },
        dec: v => { const out = new Array(v.length); for (let i = 0; i < v.length; i++) out[i] = elem.dec(v[i]); return out; } };
    }
    if (type.map) {
      const value = wrap(JSON.stringify(type.map), plan(type.map));
      const put = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
      return { kind: 'single', presenceless: true, empty: () => ({}), proto: { type: value.proto.type, keyType: 'string' },
        enc: v => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('expected map'); const out = {};
          for (const k of Object.keys(v)) if (v[k] !== undefined) put(out, str(k), value.enc(v[k])); return out; },
        dec: v => { const out = {}; for (const k of Object.keys(v)) put(out, k, value.dec(v[k])); return out; } };
    }
    if (type.layer) {
      const key = JSON.stringify(type.layer), list = { list: type.layer };
      const items = message(fresh(`L_${key}`), [{ name: 'items', plan: plan(list) }]);
      const drop = message(fresh('L_id'), [{ name: 'items', plan: plan({ list: 'id' }) }]);
      const keyed = message(fresh(`K_${key}`), [{ name: 'k', plan: SCALARS.uint() },
        ...['all', 'set'].map(name => ({ name, optional: true, plan: single(items.name, v => items.enc({ items: v }), m => items.dec(m).items) })),
        { name: 'drop', optional: true, plan: single(drop.name, v => drop.enc({ items: v }), m => drop.dec(m).items) }]);
      const layer = message(fresh(`Layer_${key}`), [{ name: 'form', plan: { kind: 'alts', choose: v => (Array.isArray(v) ? 0 : 1), members: [
        { suffix: 'plain', proto: { type: items.name }, enc: v => items.enc({ items: v }), dec: m => items.dec(m).items },
        { suffix: 'keyed', proto: { type: keyed.name }, enc: v => keyed.enc(v), dec: m => keyed.dec(m) }] } }]);
      return single(layer.name, v => { if (!v || typeof v !== 'object') fail('expected layer'); return layer.enc({ form: v }); }, m => layer.dec(m).form);
    }
    throw new Error(`unknown type ${JSON.stringify(type)}`);
  }

  function named(name) {
    if (plans.has(name)) return plans.get(name);
    const def = schema.records[name];
    if (!def) throw new Error(`unknown record ${name}`);
    if (compiling.has(name)) throw new Error(`recursive schema at ${name}`);
    compiling.add(name);
    let result;
    if (def.union) {
      const variants = def.union.map(named), pick = def.pick;
      result = { kind: 'alts', choose: v => pick(v), members: variants.map((p, i) => ({ suffix: def.union[i], ...p })) };
    } else {
      const record = message(name, def.fields.map(f => ({ name: f.name, optional: f.optional, plan: plan(f.type) })));
      result = single(name, record.enc, record.dec);
    }
    compiling.delete(name);
    plans.set(name, result);
    return result;
  }

  // A protobuf message for a record: one field per single plan, one oneof per alts plan, nothing for a const.
  // Returns { name, enc(plain) => shaped object, dec(decoded message) => plain object }.
  function message(name, fields) {
    const json = { edition: EDITION, fields: {}, oneofs: {} }; let id = 1;
    const steps = fields.map(f => {
      let p = f.plan;
      if (p.kind === 'single' && p.presenceless && f.optional) p = wrap(`${name}.${f.name}`, p); // presence for optional lists/maps
      if (p.kind === 'const') return { ...f, p };
      if (p.kind === 'single') { json.fields[f.name] = { ...p.proto, id: id++ }; return { ...f, p, key: f.name }; }
      const keys = p.members.map(m => `${f.name}_${m.suffix}`);
      p.members.forEach((m, i) => { json.fields[keys[i]] = { ...m.proto, id: id++ }; });
      json.oneofs[f.name] = { oneof: keys };
      return { ...f, p, keys };
    });
    if (!Object.keys(json.oneofs).length) delete json.oneofs;
    nested[name] = json;
    const known = new Set(fields.map(f => f.name)), n = steps.length;
    return {
      name,
      enc(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`expected ${name} record`);
        const out = {}; let present = 0, seen = 0;
        for (const k in v) if (v[k] !== undefined) seen++;
        for (let i = 0; i < n; i++) {
          const s = steps[i], value = v[s.name];
          if (value === undefined) { if (!s.optional && s.p.kind !== 'const') fail(`${name}.${s.name}: required field missing`); continue; }
          present++;
          if (s.p.kind === 'const') { if (value !== s.p.value) fail(`expected ${s.p.value}`); }
          else if (s.key) out[s.key] = s.p.enc(value);
          else { const j = s.p.choose(value), m = s.p.members[j]; if (!m) fail(`${name}.${s.name}: no variant`); out[s.keys[j]] = m.enc(value); }
        }
        if (present !== seen) for (const k in v) if (v[k] !== undefined && !known.has(k)) fail(`field ${k} is not in ${name}`);
        return out;
      },
      dec(m) {
        const out = {};
        for (let i = 0; i < n; i++) {
          const s = steps[i];
          if (s.p.kind === 'const') { out[s.name] = s.p.value; continue; }
          if (s.key) {
            const value = m[s.key];
            // protobufjs gives repeated and map fields an own empty value; an absent message field is not own.
            if (own.call(m, s.key) && value !== null) out[s.name] = s.p.dec(value);
            else if (s.p.presenceless) out[s.name] = s.p.empty();
            else if (!s.optional) bad(`${name}.${s.name}: required field missing`);
            continue;
          }
          let found = false;
          for (let j = 0; j < s.keys.length; j++) if (own.call(m, s.keys[j]) && m[s.keys[j]] !== null) { out[s.name] = s.p.members[j].dec(m[s.keys[j]]); found = true; break; }
          if (!found && !s.optional) bad(`${name}.${s.name}: required field missing`);
        }
        return out;
      },
    };
  }

  const byId = new Map(), byType = new Map();
  for (const [type, m] of Object.entries(schema.messages)) {
    const record = schema.records[m.record]; if (!record?.fields) throw new Error(`unknown record ${m.record}`);
    const shape = message(`Message_${type}`, [{ name: 'type', plan: { kind: 'const', value: type } },
      ...record.fields.map(f => ({ name: f.name, optional: f.optional, plan: plan(f.type) }))]);
    const entry = { type, id: m.id, shape };
    byId.set(m.id, entry); byType.set(type, entry);
  }
  for (const name of Object.keys(schema.records)) named(name); // refuse unused-but-broken records too
  const descriptor = { nested };
  const root = protobuf.Root.fromJSON(descriptor);
  for (const entry of byId.values()) entry.Type = root.lookupType(`Message_${entry.type}`);

  const frame = (id, body) => {
    const n = body.length, size = n < 0x80 ? 1 : n < 0x4000 ? 2 : 3;
    if (n >= 0x200000) fail('message too large');
    const out = new Uint8Array(n + 3 + size); out[0] = FORMAT; out[1] = schema.version; out[2] = id;
    for (let i = 0, v = n; i < size; i++, v >>>= 7) out[3 + i] = (v & 0x7f) | (i < size - 1 ? 0x80 : 0);
    out.set(body, 3 + size); return out;
  };
  const read = bytes => {
    if (bytes.length > limits.maxBytes) bad('message too large');
    if (bytes.length < 4 || bytes[0] !== FORMAT) bad('unknown format');
    if (bytes[1] !== schema.version) bad('unsupported schema version');
    const entry = byId.get(bytes[2]); if (!entry) bad('unknown message type');
    let n = 0, at = 3;
    for (let shift = 0; ; shift += 7) { if (at >= bytes.length || shift > 14) bad('bad length'); const b = bytes[at++]; n |= (b & 0x7f) << shift; if (b < 0x80) break; }
    if (at + n !== bytes.length) bad(at + n > bytes.length ? 'truncated message' : 'trailing bytes');
    return { entry, decoded: entry.Type.decode(bytes.subarray(at)) };
  };
  return {
    name: options.name ?? `protobuf-${numbers}`,
    descriptor,
    encode(message) {
      const entry = byType.get(message?.type); if (!entry) fail(`unknown type ${message?.type}`);
      return frame(entry.id, entry.Type.encode(entry.shape.enc(message)).finish());
    },
    decode(bytes) { const { entry, decoded } = read(bytes); return entry.shape.dec(decoded); },
    // Library-only paths: what protobuf costs once projections are already shaped for it (no adapter).
    shape(message) { return byType.get(message.type).shape.enc(message); },
    encodeShaped(type, shaped) { const entry = byType.get(type); return frame(entry.id, entry.Type.encode(shaped).finish()); },
    decodeRaw(bytes) { return read(bytes).decoded; },
    // The generated encode/decode functions (protobufjs codegen), a proxy for static code size.
    generatedSource() { const out = []; root.nestedArray.forEach(function walk(t) { if (t.encode && t.fields) { t.setup(); out.push(String(t.encode), String(t.decode)); } }); return out.join('\n'); },
  };
}
