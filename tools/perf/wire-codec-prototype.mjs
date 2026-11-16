// Benchmark-only Node codec. Its corpus-derived dictionary is not a protocol schema.
const NULL = 0, FALSE = 1, TRUE = 2, INTEGER = 3, FLOAT = 4, STRING = 5, ARRAY = 6, OBJECT = 7;

export function collectKeys(value, keys) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const entry of value) collectKeys(entry, keys); return; }
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue;
    keys.add(key);
    collectKeys(value[key], keys);
  }
}

export function createCodec(keys) {
  const indices = new Map(keys.map((key, index) => [key, index]));
  if (indices.size !== keys.length || keys.some(key => typeof key !== 'string')) throw new TypeError('Invalid dictionary');
  function encode(value) {
    const parts = [];
    const byte = n => parts.push(Buffer.from([n]));
    const uint = n => {
      n = BigInt(n);
      do { const next = Number(n % 128n); n /= 128n; byte(next + (n ? 128 : 0)); } while (n);
    };
    const put = v => {
      if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return byte(NULL);
      if (v === false) return byte(FALSE);
      if (v === true) return byte(TRUE);
      if (typeof v === 'number') {
        if (Number.isSafeInteger(v)) {
          byte(INTEGER); const n = BigInt(v); uint(n < 0n ? -2n * n - 1n : 2n * n); return;
        }
        byte(FLOAT); const b = Buffer.allocUnsafe(8); b.writeDoubleLE(v); parts.push(b); return;
      }
      if (typeof v === 'string') {
        const b = Buffer.from(v, 'utf8'); byte(STRING); uint(b.length); parts.push(b); return;
      }
      if (Array.isArray(v)) {
        byte(ARRAY); uint(v.length); for (const entry of v) put(entry === undefined ? null : entry); return;
      }
      if (typeof v === 'object') {
        const names = Object.keys(v).filter(key => v[key] !== undefined);
        byte(OBJECT); uint(names.length);
        for (const key of names) {
          const index = indices.get(key);
          if (index === undefined) throw new TypeError(`Unknown key: ${key}`);
          uint(index); put(v[key]);
        }
        return;
      }
      throw new TypeError(`Unsupported value: ${typeof v}`);
    };
    put(value);
    return Buffer.concat(parts);
  }
  function decode(bytes) {
    const b = Buffer.from(bytes); let offset = 0;
    const byte = () => { if (offset >= b.length) throw new RangeError('Truncated input'); return b[offset++]; };
    const uint = () => {
      let n = 0n, factor = 1n;
      for (let i = 0; i < 8; i++) {
        const v = byte(); n += BigInt(v % 128) * factor;
        if (v < 128) return n;
        factor *= 128n;
      }
      throw new RangeError('Invalid varuint');
    };
    const length = () => { const n = uint(); if (n > BigInt(b.length)) throw new RangeError('Invalid length'); return Number(n); };
    const get = () => {
      switch (byte()) {
        case NULL: return null;
        case FALSE: return false;
        case TRUE: return true;
        case INTEGER: {
          const u = uint(), n = u % 2n ? -(u + 1n) / 2n : u / 2n;
          if (n < BigInt(Number.MIN_SAFE_INTEGER) || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Integer out of range');
          return Number(n);
        }
        case FLOAT: {
          if (offset + 8 > b.length) throw new RangeError('Truncated float');
          const n = b.readDoubleLE(offset); offset += 8;
          if (!Number.isFinite(n)) throw new RangeError('Invalid float');
          return n;
        }
        case STRING: {
          const n = length(); if (offset + n > b.length) throw new RangeError('Truncated string');
          const value = b.toString('utf8', offset, offset + n); offset += n; return value;
        }
        case ARRAY: {
          const n = length(), value = []; for (let i = 0; i < n; i++) value.push(get()); return value;
        }
        case OBJECT: {
          const n = length(), value = {};
          for (let i = 0; i < n; i++) {
            const index = uint(); if (index >= BigInt(keys.length)) throw new RangeError('Unknown key index');
            Object.defineProperty(value, keys[Number(index)], { value: get(), enumerable: true, writable: true, configurable: true });
          }
          return value;
        }
        default: throw new RangeError('Unknown tag');
      }
    };
    const result = get(); if (offset !== b.length) throw new RangeError('Trailing bytes'); return result;
  }
  return { encode, decode };
}
