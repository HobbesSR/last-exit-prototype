// #1130 candidate D: a static descriptor/DataView codec for a closed schema. Measurement code, not a
// production generator: the schema is compiled once into one writer/reader closure pair per type, the
// shape generated code would have. Runs unchanged in Node and Chrome (no Node APIs). Stateless: every
// message decodes alone with a fresh decoder; the only tables are the schema, which ships with the client.
//
// Types (a schema names record types and refers to them by name):
//   'uint'  unsigned safe-integer varint                   'bool'  one byte
//   'num'   any finite number: integer varint, else exact float32, else float64 (-0 written as 0, as JSON)
//   'str'   string; UTF-8 when well formed, else UTF-16 code units (lone surrogates survive)
//   'id'    string or number, tagged (ID types survive)    '<Name>' a named record or union
//   { list: T }  { nullable: T }  { map: T } (string keys)  { layer: T } (plain list or {k, all?, set?, drop?})
//   { enum: [values] } one byte index; unknown values refuse    { const: v } no bytes (a union variant's tag)
// A record is { fields: [{ name, type, optional? }] }. Optional fields share one presence bitmask; an
// undefined value is absent, as in JSON. Unknown keys refuse to encode: the schema is closed.
// A union is { union: [Name...], pick(value) => index }. Recursive schemas are refused, so nesting depth
// is bounded by the schema. Quantized fields: options.quantize[Name][field] = scale, written as a signed
// varint of round(value*scale) (a measurement probe of 24.1's candidates).

const FORMAT = 0xd1;
const textEncoder = new TextEncoder(), textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = why => { throw new TypeError(why); };
const codes = [];
const bad = why => { throw new RangeError(why); };

export class Writer {
  constructor(size = 1024) { this.bytes = new Uint8Array(size); this.view = new DataView(this.bytes.buffer); this.at = 0; }
  reserve(n) {
    if (this.at + n <= this.bytes.length) return;
    let size = this.bytes.length * 2; while (size < this.at + n) size *= 2;
    const next = new Uint8Array(size); next.set(this.bytes.subarray(0, this.at));
    this.bytes = next; this.view = new DataView(next.buffer);
  }
  byte(v) { this.reserve(1); this.bytes[this.at++] = v; }
  // Unsigned varint up to 2^53 (7 bits per byte); arithmetic, not bit ops, past 31 bits.
  uint(v) {
    this.reserve(8);
    const b = this.bytes;
    if (v < 0x80) { b[this.at++] = v; return; }
    while (v >= 0x80) { b[this.at++] = (v % 0x80) | 0x80; v = Math.floor(v / 0x80); }
    b[this.at++] = v;
  }
  sint(v) { this.uint(v < 0 ? -v * 2 - 1 : v * 2); }
  f64(v) { this.reserve(8); this.view.setFloat64(this.at, v === 0 ? 0 : v, true); this.at += 8; }
  f32(v) { this.reserve(4); this.view.setFloat32(this.at, v, true); this.at += 4; }
  u16(v) { this.reserve(2); this.view.setUint16(this.at, v, true); this.at += 2; }
  str(s, max) {
    const n = s.length;
    // Short ASCII (the common case: ids, names, enum-like strings): one length byte, one byte per char.
    if (n < 64) {
      this.reserve(n + 1);
      const b = this.bytes, start = this.at;
      let i = 0;
      for (; i < n; i++) { const c = s.charCodeAt(i); if (c >= 0x80) break; b[start + 1 + i] = c; }
      if (i === n) { b[start] = n * 2; this.at = start + 1 + n; return; }
    }
    if (s.isWellFormed()) {
      this.reserve(n * 3 + 8);
      const start = this.at, prefix = varintSize(n * 2);
      const { written } = textEncoder.encodeInto(s, this.bytes.subarray(start + prefix));
      if (written > max) fail('string too long');
      const actual = varintSize(written * 2);
      if (actual !== prefix) this.bytes.copyWithin(start + actual, start + prefix, start + prefix + written);
      this.uint(written * 2); this.at += written;
    } else {
      if (n * 2 > max) fail('string too long');
      this.uint(n * 2 + 1); this.reserve(n * 2);
      for (let i = 0; i < n; i++) { this.view.setUint16(this.at, s.charCodeAt(i), true); this.at += 2; }
    }
  }
  finish() { return this.bytes.slice(0, this.at); }
}
const varintSize = v => { let n = 1; while (v >= 0x80) { v = Math.floor(v / 0x80); n++; } return n; };

export class Reader {
  constructor(bytes, limits) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.at = 0; this.end = bytes.length; this.limits = limits; }
  byte() { if (this.at >= this.end) bad('truncated message'); return this.bytes[this.at++]; }
  uint() {
    const b = this.bytes;
    if (this.at < this.end && b[this.at] < 0x80) return b[this.at++];
    let v = 0, scale = 1;
    for (let i = 0; i < 8; i++) {
      const x = this.byte(); v += (x & 0x7f) * scale;
      if (x < 0x80) { if (!Number.isSafeInteger(v)) bad('varint out of range'); return v; }
      scale *= 0x80;
    }
    return bad('varint too long');
  }
  sint() { const v = this.uint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
  f64() { if (this.at + 8 > this.end) bad('truncated message'); const v = this.view.getFloat64(this.at, true); this.at += 8; if (!Number.isFinite(v)) bad('non-finite number'); return v; }
  f32() { if (this.at + 4 > this.end) bad('truncated message'); const v = this.view.getFloat32(this.at, true); this.at += 4; if (!Number.isFinite(v)) bad('non-finite number'); return v; }
  u16() { if (this.at + 2 > this.end) bad('truncated message'); const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
  // A collection length must fit in the bytes left (every element takes at least one byte) and the cap.
  count() {
    const n = this.uint();
    if (n > this.end - this.at || n > this.limits.maxCollection) bad('collection length out of bounds');
    return n;
  }
  str() {
    const h = this.uint(), utf16 = h % 2 === 1, units = (h - (utf16 ? 1 : 0)) / 2, size = utf16 ? units * 2 : units;
    if (size > this.limits.maxString) bad('string too long');
    if (this.at + size > this.end) bad('truncated message');
    const b = this.bytes, start = this.at;
    if (utf16) {
      let s = '';
      for (let i = 0; i < units; i++) s += String.fromCharCode(this.view.getUint16(start + i * 2, true));
      this.at += size;
      if (s.isWellFormed()) bad('non-canonical string');
      return s;
    }
    if (size < 32) {
      // One string per value: character codes collected into a reused array, not concatenated.
      let i = 0; codes.length = size;
      for (; i < size; i++) { const c = b[start + i]; if (c >= 0x80) break; codes[i] = c; }
      if (i === size) { this.at += size; return String.fromCharCode.apply(null, codes); }
    }
    const s = size ? textDecoder.decode(b.subarray(start, start + size)) : ''; this.at += size; return s;
  }
}

/**
 * schema = { version, records: { Name: record | union }, messages: { type: { id, record: Name } } }.
 * Returns { encode(message) => Uint8Array, decode(bytes) => message, writeValue, header, Writer }.
 */
export function createDescriptorCodec(schema, options = {}) {
  const limits = { maxBytes: 1 << 20, maxCollection: 1 << 16, maxString: 1 << 12, ...options.limits };
  const quantize = options.quantize ?? {}, MAX = limits.maxString;
  const named = new Map(), compiling = new Set();

  const scalars = {
    uint: { w: (w, v) => { if (!Number.isSafeInteger(v) || v < 0) fail('expected unsigned safe integer'); w.uint(v); }, r: r => r.uint() },
    num: {
      // Low bit 0: an integer (zigzag) in the remaining bits. 1: a float64 follows. 3: a float32 that
      // widens back to exactly this value (Rapier state is float32), so the narrowing is lossless.
      w: (w, v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) fail('expected finite number');
        if (Number.isInteger(v) && v <= 2 ** 50 && v >= -(2 ** 50)) return w.uint((v < 0 ? -v * 2 - 1 : v * 2) * 2);
        if (Math.fround(v) === v) { w.byte(3); return w.f32(v); }
        w.byte(1); w.f64(v);
      },
      r: r => {
        const h = r.uint();
        if (h % 2 === 0) { const z = h / 2; return z % 2 ? -(z + 1) / 2 : z / 2; }
        if (h === 1) return r.f64();
        if (h === 3) { const v = r.f32(); if (Number.isInteger(v) && Math.abs(v) <= 2 ** 50) bad('non-canonical number'); return v; }
        return bad('bad number tag');
      },
    },
    bool: { w: (w, v) => { if (typeof v !== 'boolean') fail('expected boolean'); w.byte(v ? 1 : 0); }, r: r => { const b = r.byte(); if (b > 1) bad('bad boolean'); return b === 1; } },
    str: { w: (w, v) => { if (typeof v !== 'string') fail('expected string'); w.str(v, MAX); }, r: r => r.str() },
    // Tag 0 string, 1 non-negative integer, 2 negative integer (magnitude). Sign-magnitude, not zigzag,
    // so the whole safe-integer range round-trips: zigzag doubles a magnitude past 2^53.
    id: {
      w: (w, v) => {
        if (typeof v === 'string') { w.byte(0); return w.str(v, MAX); }
        if (!Number.isSafeInteger(v)) fail('expected string or safe-integer id');
        if (v >= 0) { w.byte(1); return w.uint(v); }
        w.byte(2); w.uint(-v);
      },
      r: r => {
        const t = r.byte();
        if (t === 0) return r.str();
        if (t === 1) return r.uint();
        if (t === 2) { const m = r.uint(); if (m === 0) bad('non-canonical id'); return -m; }
        return bad('bad id tag');
      },
    },
  };
  // Zigzag doubles the magnitude, so a quantized value must stay below 2^52 to remain a safe integer.
  const quantized = scale => ({
    w: (w, v) => { if (typeof v !== 'number') fail('quantized field must be a number'); const q = Math.round(v * scale); if (!Number.isSafeInteger(q) || Math.abs(q) >= 2 ** 52) fail('quantization overflow'); w.sint(q === 0 ? 0 : q); },
    r: r => r.sint() / scale,
  });

  function compile(type) {
    if (typeof type === 'string') return scalars[type] ?? compileNamed(type);
    if (type.enum) { const values = type.enum; return { w: (w, v) => { const i = values.indexOf(v); if (i < 0) fail(`value ${v} is not in the declared enum`); w.byte(i); }, r: r => { const i = r.byte(); if (i >= values.length) bad('bad enum value'); return values[i]; } }; }
    if ('const' in type) { const c = type.const; return { w: (w, v) => { if (v !== c) fail(`expected ${c}`); }, r: () => c }; }
    if (type.nullable) { const t = compile(type.nullable); return { w: (w, v) => { if (v === null) return w.byte(0); w.byte(1); t.w(w, v); }, r: r => { const tag = r.byte(); if (tag === 0) return null; if (tag !== 1) bad('bad nullable tag'); return t.r(r); } }; }
    if (type.list) {
      const t = compile(type.list);
      return { w: (w, v) => { if (!Array.isArray(v)) fail('expected list'); w.uint(v.length); for (let i = 0; i < v.length; i++) t.w(w, v[i]); },
        r: r => { const n = r.count(), out = new Array(n); for (let i = 0; i < n; i++) out[i] = t.r(r); return out; } };
    }
    if (type.map) {
      const t = compile(type.map);
      return {
        w: (w, v) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('expected map'); const keys = Object.keys(v).filter(k => v[k] !== undefined); w.uint(keys.length); for (const k of keys) { w.str(k, MAX); t.w(w, v[k]); } },
        r: r => {
          const n = r.count(), out = {};
          for (let i = 0; i < n; i++) {
            const k = r.str(); if (Object.hasOwn(out, k)) bad('duplicate map key');
            // __proto__ and friends become plain own properties, as JSON.parse makes them.
            Object.defineProperty(out, k, { value: t.r(r), enumerable: true, writable: true, configurable: true });
          }
          return out;
        },
      };
    }
    if (type.layer) {
      const list = compile({ list: type.layer }), ids = compile({ list: 'id' });
      return {
        w: (w, v) => {
          if (Array.isArray(v)) { w.byte(0); return list.w(w, v); }
          if (!v || typeof v !== 'object') fail('expected layer');
          for (const k in v) if (k !== 'k' && k !== 'all' && k !== 'set' && k !== 'drop' && v[k] !== undefined) fail(`unknown layer key ${k}`);
          w.byte(1 | (v.all !== undefined ? 2 : 0) | (v.set !== undefined ? 4 : 0) | (v.drop !== undefined ? 8 : 0));
          scalars.uint.w(w, v.k);
          if (v.all !== undefined) list.w(w, v.all);
          if (v.set !== undefined) list.w(w, v.set);
          if (v.drop !== undefined) ids.w(w, v.drop);
        },
        r: r => {
          const tag = r.byte();
          if (tag === 0) return list.r(r);
          if (!(tag & 1) || tag > 15) bad('bad layer tag');
          const out = { k: r.uint() };
          if (tag & 2) out.all = list.r(r);
          if (tag & 4) out.set = list.r(r);
          if (tag & 8) out.drop = ids.r(r);
          return out;
        },
      };
    }
    throw new Error(`unknown type ${JSON.stringify(type)}`);
  }

  function compileNamed(name) {
    if (named.has(name)) return named.get(name);
    const def = schema.records[name];
    if (!def) throw new Error(`unknown record ${name}`);
    if (compiling.has(name)) throw new Error(`recursive schema at ${name}`);
    compiling.add(name);
    // Forward slot: filled below, so references compiled later share the same object.
    const slot = { w: null, r: null }; named.set(name, slot);
    if (def.union) {
      const variants = def.union.map(compileNamed), pick = def.pick;
      slot.w = (w, v) => { const i = pick(v); w.byte(i); variants[i].w(w, v); };
      slot.r = r => { const i = r.byte(); if (i >= variants.length) bad('bad union tag'); return variants[i].r(r); };
    } else {
      const fields = def.fields, scales = quantize[name] ?? {};
      if (new Set(fields.map(f => f.name)).size !== fields.length) throw new Error(`${name}: duplicate field`);
      const count = fields.filter(f => f.optional).length;
      if (count > 52) throw new Error(`${name}: too many optional fields`);
      const known = new Set(fields.map(f => f.name)), names = fields.map(f => f.name);
      // A const field (a message's type) need not be present to encode, and always decodes.
      const consts = fields.map(f => typeof f.type === 'object' && 'const' in f.type);
      const codecs = fields.map(f => scales[f.name] !== undefined ? quantized(scales[f.name]) : compile(f.type));
      // Presence: two varint words of up to 26 bits each (the second only for more than 26 optionals).
      let k = 0; const lo = [], hi = [];
      for (const f of fields) { lo.push(f.optional && k < 26 ? 1 << k : 0); hi.push(f.optional && k >= 26 ? 1 << (k - 26) : 0); if (f.optional) k++; }
      const two = count > 26, limitLo = 2 ** Math.min(count, 26), limitHi = 2 ** Math.max(0, count - 26);
      slot.w = (w, v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`expected ${name} record`);
        let a = 0, b = 0, present = 0, seen = 0;
        for (const key in v) if (v[key] !== undefined) seen++;
        for (let i = 0; i < names.length; i++) if (v[names[i]] !== undefined) { present++; a |= lo[i]; b |= hi[i]; }
          else if (!lo[i] && !hi[i] && !consts[i]) fail(`${name}.${names[i]}: required field missing`);
        if (present !== seen) for (const key in v) if (v[key] !== undefined && !known.has(key)) fail(`field ${key} is not in ${name}`);
        if (count) w.uint(a);
        if (two) w.uint(b);
        for (let i = 0; i < names.length; i++) { const value = v[names[i]]; if (value !== undefined) codecs[i].w(w, value); }
      };
      slot.r = r => {
        const a = count ? r.uint() : 0, b = two ? r.uint() : 0;
        if (a >= limitLo || b >= limitHi) bad('bad presence mask');
        const out = {};
        for (let i = 0; i < names.length; i++) if ((!lo[i] && !hi[i]) || a & lo[i] || b & hi[i]) out[names[i]] = codecs[i].r(r);
        return out;
      };
    }
    compiling.delete(name);
    return slot;
  }

  const byId = new Map(), byType = new Map();
  for (const [type, m] of Object.entries(schema.messages)) {
    if (byId.has(m.id)) throw new Error(`duplicate message id ${m.id}`);
    // The message record plus its type as a zero-byte const field, so neither side copies the message.
    const record = schema.records[m.record]; if (!record?.fields) throw new Error(`unknown record ${m.record}`);
    schema = { ...schema, records: { ...schema.records, [`$${type}`]: { fields: [{ name: 'type', type: { const: type } }, ...record.fields] } } };
    const entry = { type, id: m.id, codec: compileNamed(`$${type}`) };
    byId.set(m.id, entry); byType.set(type, entry);
  }
  for (const name of Object.keys(schema.records)) compileNamed(name); // refuse unused-but-broken records too
  const writer = new Writer(1 << 16), adhoc = new Map();
  const codecFor = type => { const key = typeof type === 'string' ? type : JSON.stringify(type); let c = adhoc.get(key); if (!c) adhoc.set(key, c = compile(type)); return c; };

  return {
    name: options.name ?? 'descriptor',
    encode(message) {
      const m = byType.get(message?.type); if (!m) fail(`unknown type ${message?.type}`);
      writer.at = 0; writer.byte(FORMAT); writer.uint(schema.version); writer.uint(m.id);
      m.codec.w(writer, message);
      return writer.finish();
    },
    decode(bytes) {
      if (bytes.length > limits.maxBytes) bad('message too large');
      const r = new Reader(bytes, limits);
      if (r.byte() !== FORMAT) bad('unknown format');
      if (r.uint() !== schema.version) bad('unsupported schema version');
      const m = byId.get(r.uint()); if (!m) bad('unknown message type');
      const message = m.codec.r(r);
      if (r.at !== bytes.length) bad('trailing bytes');
      return message;
    },
    // Low-level access for the capped-packing probe.
    writeValue(w, type, v) { codecFor(type).w(w, v); },
    readValue(r, type) { return codecFor(type).r(r); },
    reader(bytes) { return new Reader(bytes, limits); },
    header(w, type) { w.byte(FORMAT); w.uint(schema.version); w.uint(byType.get(type).id); },
    readHeader(r) { if (r.byte() !== FORMAT || r.uint() !== schema.version) bad('bad header'); return byId.get(r.uint())?.type; },
    Writer,
  };
}
