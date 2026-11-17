// #1130 field-typed comparison: stock protobuf over the native model (wire-typed-schema.mjs). No adapter: the
// native objects are already protobuf-shaped, and the shared converter owns projection <-> native and validation
// (required fields, one oneof member, enum ranges). This file adds only framing: format, schema version, message id
// and the body length, which protobuf needs to refuse a message cut at a field boundary (42.51).
// `types` is anything exposing the root message type with protobufjs' encode(obj).finish() / decode(bytes):
// a pbjs static module (deployable, no runtime codegen) or a reflection root (Node, same generated functions).
const FORMAT = 0xd4;
const fail = why => { throw new TypeError(why); };
const bad = why => { throw new RangeError(why); };

export function createTypedProtobufCodec(types, { version, root = 'State', name = 'protobuf', maxBytes = 1 << 20 } = {}) {
  const Type = types[root] ?? fail(`no ${root} type`), ID = 1;
  return {
    name,
    encode(native) {
      const body = Type.encode(native).finish(), n = body.length, size = n < 0x80 ? 1 : n < 0x4000 ? 2 : 3;
      if (n >= 0x200000) fail('message too large');
      const out = new Uint8Array(n + 3 + size); out[0] = FORMAT; out[1] = version; out[2] = ID;
      for (let i = 0, v = n; i < size; i++, v >>>= 7) out[3 + i] = (v & 0x7f) | (i < size - 1 ? 0x80 : 0);
      out.set(body, 3 + size);
      return out;
    },
    decode(bytes) {
      if (bytes.length > maxBytes) bad('message too large');
      if (bytes.length < 4 || bytes[0] !== FORMAT) bad('unknown format');
      if (bytes[1] !== version) bad('unsupported schema version');
      if (bytes[2] !== ID) bad('unknown message type');
      let n = 0, at = 3;
      for (let shift = 0; ; shift += 7) { if (at >= bytes.length || shift > 14) bad('bad length'); const b = bytes[at++]; n |= (b & 0x7f) << shift; if (b < 0x80) break; }
      if (at + n !== bytes.length) bad(at + n > bytes.length ? 'truncated message' : 'trailing bytes');
      return Type.decode(bytes.subarray(at));
    },
  };
}

