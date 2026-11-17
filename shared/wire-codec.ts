// The descriptor codec (D) for outbound live messages (#1131; backend selected on #1130, 24.1, 42.54). A closed
// schema of named records is compiled once into one writer/reader pair per type. Stateless: every message
// decodes alone; the only table is the schema, which ships with the client. Runs unchanged in Node and Chrome.
//
// Field types (a schema names records and refers to them by name):
//   'uint'   unsigned safe integer, varint          'bool'  one byte
//   'sint'   signed safe integer, zigzag varint     'str'   UTF-8 when well formed, else UTF-16 code units
//   'f32'    an exact float32 (refuses any other)   'f64'   float64
//   'f32m'   float32 metres: v / METRE, exact on the round trip (Rapier poses, 24.3 proposal 1)
//   'exact'  any finite number, kept exact: an integer varint, else float32, else float32 metres, else float64
//   { enum: [values] }  one byte index            { list: T }   { nullable: T }
//   { layer: T }        a plain list, or a keyframe envelope { k, all?, set?, drop? } (frame-layers, discovery)
//   { enumMap: [keys, T] }  an object keyed by an enum's values
//   { union: field, variants: { tag: Record } }  a record picked by its `field`; the variant omits that field
// A record is { fields: [{ name, type, optional? }] }. Optional fields share one presence mask; undefined is
// absent, as in JSON, and `null` is only ever a declared { nullable } value. Unknown keys refuse to encode.
// Recursive schemas are refused, so nesting depth is bounded by the schema.
//
// Decoding refuses, before allocating, any length beyond the bytes left or the declared caps, and refuses
// unknown formats, versions, messages, tags and enum values, non-finite or non-canonical numbers, missing
// required fields and trailing or truncated bytes (24.1 "Schema and boundary").

/** A value on either side of the codec. The schema, not TypeScript, is what closes its shape. */
type Value = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type FieldType =
  | 'uint' | 'sint' | 'f32' | 'f64' | 'f32m' | 'exact' | 'bool' | 'str' | string
  | { enum: readonly string[] } | { list: FieldType } | { nullable: FieldType } | { layer: FieldType }
  | { enumMap: readonly [readonly string[], FieldType] }
  | { union: string; variants: Readonly<Record<string, string>> };
export interface FieldDef { name: string; type: FieldType; optional?: boolean }
export interface RecordDef { fields: readonly FieldDef[] }
export interface Schema {
  /** Written in every message header; a reader refuses any other. */
  version: number;
  records: Readonly<Record<string, RecordDef>>;
  /** Each message type's id and the record holding its fields other than `type`. */
  messages: Readonly<Record<string, { id: number; record: string }>>;
}
export interface Limits { maxBytes: number; maxCollection: number; maxString: number }

/** The first byte of every message in this format. */
export const FORMAT = 0xd1;
/** World units per Rapier metre (shared/physics/world.ts SCALE): body poses are float32 metres times this. */
export const METRE = 40;
export const DEFAULT_LIMITS: Limits = Object.freeze({ maxBytes: 1 << 22, maxCollection: 1 << 16, maxString: 1 << 12 });

const textEncoder = new TextEncoder(), textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** An encode refusal: the value does not fit the schema (a server-side contract failure). */
const fail = (why: string): never => { throw new TypeError(why); };
/** A decode refusal: the bytes are not a message of this schema. */
const bad = (why: string): never => { throw new RangeError(why); };
// String.prototype.isWellFormed is ES2024; this is the same test.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormed = (s: string) => !LONE_SURROGATE.test(s);
const varintSize = (v: number) => { let n = 1; while (v >= 0x80) { v = Math.floor(v / 0x80); n++; } return n; };

class Writer {
  bytes: Uint8Array; view: DataView; at = 0;
  constructor(size: number) { this.bytes = new Uint8Array(size); this.view = new DataView(this.bytes.buffer); }
  reserve(n: number) {
    if (this.at + n <= this.bytes.length) return;
    let size = this.bytes.length * 2; while (size < this.at + n) size *= 2;
    const next = new Uint8Array(size); next.set(this.bytes.subarray(0, this.at));
    this.bytes = next; this.view = new DataView(next.buffer);
  }
  byte(v: number) { this.reserve(1); this.bytes[this.at++] = v; }
  // Unsigned varint up to 2^53, 7 bits per byte; arithmetic rather than bit operations past 31 bits.
  uint(v: number) {
    this.reserve(8);
    const b = this.bytes;
    while (v >= 0x80) { b[this.at++] = (v % 0x80) | 0x80; v = Math.floor(v / 0x80); }
    b[this.at++] = v;
  }
  f64(v: number) { this.reserve(8); this.view.setFloat64(this.at, v === 0 ? 0 : v, true); this.at += 8; }
  f32(v: number) { this.reserve(4); this.view.setFloat32(this.at, v, true); this.at += 4; }
  // Header: twice the byte length for UTF-8, twice the code-unit count plus one for UTF-16 (lone surrogates).
  str(s: string, max: number) {
    const n = s.length;
    if (n < 64) { // short ASCII, the common case
      this.reserve(n + 1);
      const b = this.bytes, start = this.at;
      let i = 0;
      for (; i < n; i++) { const c = s.charCodeAt(i); if (c >= 0x80) break; b[start + 1 + i] = c; }
      if (i === n) { b[start] = n * 2; this.at = start + 1 + n; return; }
    }
    if (wellFormed(s)) {
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
}

class Reader {
  bytes: Uint8Array; limits: Limits; view: DataView; at = 0; end: number;
  constructor(bytes: Uint8Array, limits: Limits) {
    this.bytes = bytes; this.limits = limits;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.end = bytes.length;
  }
  byte() { if (this.at >= this.end) bad('truncated message'); return this.bytes[this.at++]!; }
  uint() {
    let v = 0, scale = 1;
    for (let i = 0; i < 8; i++) {
      const x = this.byte(); v += (x & 0x7f) * scale;
      if (x < 0x80) {
        if (!Number.isSafeInteger(v)) bad('varint out of range');
        if (x === 0 && i > 0) bad('non-canonical varint');
        return v;
      }
      scale *= 0x80;
    }
    return bad('varint too long');
  }
  f64() { if (this.at + 8 > this.end) bad('truncated message'); const v = this.view.getFloat64(this.at, true); this.at += 8; if (!Number.isFinite(v)) bad('non-finite number'); return v; }
  f32() { if (this.at + 4 > this.end) bad('truncated message'); const v = this.view.getFloat32(this.at, true); this.at += 4; if (!Number.isFinite(v)) bad('non-finite number'); return v === 0 ? 0 : v; }
  // Every element takes at least one byte, so a count beyond the bytes left is refused before allocating.
  count() {
    const n = this.uint();
    if (n > this.end - this.at || n > this.limits.maxCollection) bad('collection length out of bounds');
    return n;
  }
  str() {
    const h = this.uint(), utf16 = h % 2 === 1, units = (h - (utf16 ? 1 : 0)) / 2, size = utf16 ? units * 2 : units;
    if (size > this.limits.maxString) bad('string too long');
    if (this.at + size > this.end) bad('truncated message');
    const start = this.at;
    this.at += size;
    if (utf16) {
      let s = '';
      for (let i = 0; i < units; i++) s += String.fromCharCode(this.view.getUint16(start + i * 2, true));
      if (wellFormed(s)) bad('non-canonical string');
      return s;
    }
    if (!size) return '';
    try { return textDecoder.decode(this.bytes.subarray(start, start + size)); } catch { return bad('invalid UTF-8'); }
  }
}

interface Codec { w: (w: Writer, v: Value) => void; r: (r: Reader) => Value }
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const signedUint = (v: number) => (v < 0 ? -v * 2 - 1 : v * 2);
const unsigned = (z: number) => (z % 2 ? -(z + 1) / 2 : z / 2);

const SCALARS: Record<string, (limits: Limits) => Codec> = {
  uint: () => ({ w: (w, v) => { if (!Number.isSafeInteger(v) || v < 0) fail(`expected unsigned integer, got ${v}`); w.uint(v); }, r: r => r.uint() }),
  sint: () => ({
    w: (w, v) => { if (!Number.isSafeInteger(v) || Math.abs(v) >= 2 ** 52) fail(`expected signed integer, got ${v}`); w.uint(signedUint(v === 0 ? 0 : v)); },
    r: r => unsigned(r.uint()),
  }),
  f32: () => ({ w: (w, v) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.fround(v) !== v) fail(`expected float32, got ${v}`); w.f32(v); }, r: r => r.f32() }),
  f64: () => ({ w: (w, v) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(`expected finite number, got ${v}`); w.f64(v); }, r: r => r.f64() }),
  f32m: () => ({
    w: (w, v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`expected finite number, got ${v}`);
      const m = Math.fround(v / METRE); if (m * METRE !== v) fail(`not float32 metres: ${v}`);
      w.f32(m);
    },
    r: r => { const v = r.f32() * METRE; return v === 0 ? 0 : v; },
  }),
  // Header low bit 0: an integer, zigzag in the remaining bits. Otherwise 1: float64, 3: float32, 5: float32
  // metres. The encoder takes the first form that holds the value exactly; the reader refuses a later form
  // for a value an earlier one holds, so each value has one encoding.
  exact: () => ({
    w: (w, v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`expected finite number, got ${v}`);
      if (Number.isInteger(v) && Math.abs(v) <= 2 ** 50) return w.uint(signedUint(v === 0 ? 0 : v) * 2);
      if (Math.fround(v) === v) { w.byte(3); return w.f32(v); }
      const m = Math.fround(v / METRE);
      if (m * METRE === v) { w.byte(5); return w.f32(m); }
      w.byte(1); w.f64(v);
    },
    r: r => {
      const h = r.uint();
      if (h % 2 === 0) return unsigned(h / 2);
      const early = (v: number) => Number.isInteger(v) && Math.abs(v) <= 2 ** 50;
      if (h === 3) { const v = r.f32(); if (early(v)) bad('non-canonical number'); return v; }
      if (h === 5) { const v = r.f32() * METRE; if (early(v) || Math.fround(v) === v) bad('non-canonical number'); return v; }
      if (h === 1) { const v = r.f64(); if (early(v) || Math.fround(v) === v || Math.fround(v / METRE) * METRE === v) bad('non-canonical number'); return v; }
      return bad('bad number tag');
    },
  }),
  bool: () => ({ w: (w, v) => { if (typeof v !== 'boolean') fail('expected boolean'); w.byte(v ? 1 : 0); }, r: r => { const b = r.byte(); if (b > 1) bad('bad boolean'); return b === 1; } }),
  str: limits => ({ w: (w, v) => { if (typeof v !== 'string') fail('expected string'); w.str(v, limits.maxString); }, r: r => r.str() }),
};

const enumCodec = (values: readonly string[]): Codec => {
  if (values.length > 256) throw new Error('an enum is at most 256 values');
  const index = new Map(values.map((v, i) => [v, i]));
  return {
    w: (w, v) => { const i = index.get(v); if (i === undefined) fail(`${v} is not in the declared enum`); w.byte(i!); },
    r: r => { const i = r.byte(); if (i >= values.length) bad('bad enum value'); return values[i]; },
  };
};

export interface DescriptorCodec {
  encode(message: { type: string }): Uint8Array;
  decode(bytes: Uint8Array): Value;
  readonly version: number;
}

/** Compiles a schema. Throws at once for an unknown type, a recursive record or a duplicate field or id. */
export function createDescriptorCodec(schema: Schema, limitOverrides: Partial<Limits> = {}): DescriptorCodec {
  const limits: Limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const named = new Map<string, Codec>(), compiling = new Set<string>();

  function compile(type: FieldType): Codec {
    if (typeof type === 'string') return SCALARS[type]?.(limits) ?? compileRecord(type);
    if ('enum' in type) return enumCodec(type.enum);
    if ('nullable' in type) {
      const t = compile(type.nullable);
      return { w: (w, v) => { if (v === null) return w.byte(0); w.byte(1); t.w(w, v); },
        r: r => { const tag = r.byte(); if (tag === 0) return null; if (tag !== 1) bad('bad nullable tag'); return t.r(r); } };
    }
    if ('list' in type) {
      const t = compile(type.list);
      return { w: (w, v) => { if (!Array.isArray(v)) fail('expected list'); w.uint(v.length); for (let i = 0; i < v.length; i++) t.w(w, v[i]); },
        r: r => { const n = r.count(), out = new Array(n); for (let i = 0; i < n; i++) out[i] = t.r(r); return out; } };
    }
    if ('layer' in type) return layerCodec(compile({ list: type.layer }), compile({ list: 'uint' }));
    if ('enumMap' in type) {
      const [keys, valueType] = type.enumMap, key = enumCodec(keys), value = compile(valueType);
      return {
        w: (w, v) => {
          if (!isRecord(v)) fail('expected map');
          const present = Object.keys(v).filter(k => v[k] !== undefined);
          w.uint(present.length);
          for (const k of present) { key.w(w, k); value.w(w, v[k]); }
        },
        r: r => {
          const n = r.count(), out: Record<string, Value> = {};
          for (let i = 0; i < n; i++) { const k = key.r(r); if (Object.hasOwn(out, k)) bad('duplicate map key'); out[k] = value.r(r); }
          return out;
        },
      };
    }
    if ('union' in type) {
      const field = type.union, tags = Object.keys(type.variants), variants = tags.map(tag => compileRecord(type.variants[tag]!, field));
      if (tags.length > 256) throw new Error('a union is at most 256 variants');
      const index = new Map(tags.map((t, i) => [t, i]));
      return {
        w: (w, v) => { const i = isRecord(v) ? index.get(v[field] as string) : undefined; if (i === undefined) fail(`unknown ${field} ${isRecord(v) ? v[field] : v}`); w.byte(i!); variants[i!]!.w(w, v); },
        r: r => { const i = r.byte(); if (i >= tags.length) bad('bad union tag'); const out = variants[i]!.r(r); out[field] = tags[i]; return out; },
      };
    }
    throw new Error(`unknown type ${JSON.stringify(type)}`);
  }

  function layerCodec(list: Codec, ids: Codec): Codec {
    return {
      w: (w, v) => {
        if (Array.isArray(v)) { w.byte(0); return list.w(w, v); }
        if (!isRecord(v)) fail('expected layer');
        for (const k in v) if (k !== 'k' && k !== 'all' && k !== 'set' && k !== 'drop' && v[k] !== undefined) fail(`unknown layer key ${k}`);
        w.byte(1 | (v.all !== undefined ? 2 : 0) | (v.set !== undefined ? 4 : 0) | (v.drop !== undefined ? 8 : 0));
        SCALARS.uint!(limits).w(w, v.k);
        if (v.all !== undefined) list.w(w, v.all);
        if (v.set !== undefined) list.w(w, v.set);
        if (v.drop !== undefined) ids.w(w, v.drop);
      },
      r: r => {
        const tag = r.byte();
        if (tag === 0) return list.r(r);
        if (!(tag & 1) || tag > 15) bad('bad layer tag');
        const out: Record<string, Value> = { k: r.uint() };
        if (tag & 2) out.all = list.r(r);
        if (tag & 4) out.set = list.r(r);
        if (tag & 8) out.drop = ids.r(r);
        return out;
      },
    };
  }

  // A record, or a union variant's record with its discriminant `field` set by the union instead.
  function compileRecord(name: string, discriminant?: string): Codec {
    const key = discriminant ? `${name}|${discriminant}` : name;
    const known = named.get(key); if (known) return known;
    const def = schema.records[name];
    if (!def) throw new Error(`unknown record ${name}`);
    if (compiling.has(name)) throw new Error(`recursive schema at ${name}`);
    compiling.add(name);
    const fields = def.fields, names = fields.map(f => f.name);
    if (new Set(names).size !== names.length) throw new Error(`${name}: duplicate field`);
    if (discriminant && names.includes(discriminant)) throw new Error(`${name}: declares its union's ${discriminant}`);
    const optional = fields.filter(f => f.optional).length;
    if (optional > 52) throw new Error(`${name}: more than 52 optional fields`);
    const codecs = fields.map(f => compile(f.type));
    // Presence: up to two varint words of 26 bits each (the second only past 26 optional fields).
    const lo: number[] = [], hi: number[] = [];
    let bit = 0;
    // Each word stays below 2^26, so bit operations are exact on it.
    for (const f of fields) { lo.push(f.optional && bit < 26 ? 1 << bit : 0); hi.push(f.optional && bit >= 26 ? 1 << (bit - 26) : 0); if (f.optional) bit++; }
    const two = optional > 26, limitLo = 1 << Math.min(optional, 26), limitHi = 1 << Math.max(0, optional - 26);
    const allowed = new Set(discriminant ? [...names, discriminant] : names);
    const codec: Codec = {
      w: (w, v) => {
        if (!isRecord(v)) fail(`expected ${name} record`);
        let a = 0, b = 0, present = 0, seen = 0;
        for (const k in v) if (v[k] !== undefined) seen++;
        if (discriminant && v[discriminant] !== undefined) present++;
        for (let i = 0; i < names.length; i++) {
          if (v[names[i]!] !== undefined) { present++; a |= lo[i]!; b |= hi[i]!; }
          else if (!lo[i] && !hi[i]) fail(`${name}.${names[i]}: required field missing`);
        }
        if (present !== seen) for (const k in v) if (v[k] !== undefined && !allowed.has(k)) fail(`field ${k} is not in ${name}`);
        if (optional) w.uint(a);
        if (two) w.uint(b);
        for (let i = 0; i < names.length; i++) { const value = v[names[i]!]; if (value !== undefined) codecs[i]!.w(w, value); }
      },
      r: r => {
        const a = optional ? r.uint() : 0, b = two ? r.uint() : 0;
        if (a >= limitLo || b >= limitHi) bad('bad presence mask');
        const out: Record<string, Value> = {};
        for (let i = 0; i < names.length; i++) {
          const required = !lo[i] && !hi[i];
          if (required || a & lo[i]! || b & hi[i]!) out[names[i]!] = codecs[i]!.r(r);
        }
        return out;
      },
    };
    compiling.delete(name);
    named.set(key, codec);
    return codec;
  }

  const byId = new Map<number, { type: string; codec: Codec }>(), byType = new Map<string, { id: number; codec: Codec }>();
  for (const [type, m] of Object.entries(schema.messages)) {
    if (byId.has(m.id)) throw new Error(`duplicate message id ${m.id}`);
    const codec = compileRecord(m.record, 'type');
    byId.set(m.id, { type, codec }); byType.set(type, { id: m.id, codec });
  }
  for (const name of Object.keys(schema.records)) if (![...named.keys()].some(k => k === name || k.startsWith(`${name}|`))) compileRecord(name);
  const writer = new Writer(1 << 16);

  return {
    version: schema.version,
    encode(message) {
      const m = byType.get(message?.type); if (!m) return fail(`unknown message type ${message?.type}`);
      writer.at = 0; writer.byte(FORMAT); writer.uint(schema.version); writer.uint(m.id);
      m.codec.w(writer, message);
      return writer.bytes.slice(0, writer.at);
    },
    decode(bytes) {
      if (bytes.length > limits.maxBytes) bad('message too large');
      const r = new Reader(bytes, limits);
      if (r.byte() !== FORMAT) bad('unknown format');
      if (r.uint() !== schema.version) bad('unsupported schema version');
      const m = byId.get(r.uint()); if (!m) return bad('unknown message type');
      const message = m.codec.r(r);
      if (r.at !== bytes.length) bad('trailing bytes');
      // The type is the message's discriminant: written as its id, set here first as JSON would carry it.
      return { type: m.type, ...message };
    },
  };
}
