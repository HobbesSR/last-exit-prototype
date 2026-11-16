// Benchmark-only Node codec. Its corpus-derived dictionary is not a protocol schema.
const NULL = 0, FALSE = 1, TRUE = 2, POSITIVE = 3, FLOAT = 4, STRING = 5, ARRAY = 6, OBJECT = 7, NEGATIVE = 8;

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
    let buffer = Buffer.allocUnsafe(1024), offset = 0;
    const reserve = n => {
      if (offset + n <= buffer.length) return;
      let size = buffer.length;
      while (size < offset + n) size *= 2;
      const larger = Buffer.allocUnsafe(size); buffer.copy(larger, 0, 0, offset); buffer = larger;
    };
    const byte = n => { reserve(1); buffer[offset++] = n; };
    const uint = n => {
      do { const next = n % 128; n = Math.floor(n / 128); byte(next + (n ? 128 : 0)); } while (n);
    };
    const put = v => {
      if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return byte(NULL);
      if (v === false) return byte(FALSE);
      if (v === true) return byte(TRUE);
      if (typeof v === 'number') {
        if (Number.isSafeInteger(v)) {
          byte(v < 0 ? NEGATIVE : POSITIVE); uint(Math.abs(v)); return;
        }
        byte(FLOAT); reserve(8); buffer.writeDoubleLE(v, offset); offset += 8; return;
      }
      if (typeof v === 'string') {
        const size = Buffer.byteLength(v, 'utf8'); byte(STRING); uint(size); reserve(size);
        offset += buffer.write(v, offset, size, 'utf8'); return;
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
    return Buffer.from(buffer.subarray(0, offset));
  }
  function decode(bytes) {
    const b = Buffer.from(bytes); let offset = 0;
    const byte = () => { if (offset >= b.length) throw new RangeError('Truncated input'); return b[offset++]; };
    const uint = () => {
      let n = 0, factor = 1;
      for (let i = 0; i < 8; i++) {
        const v = byte(), digit = v % 128;
        if (digit > Math.floor((Number.MAX_SAFE_INTEGER - n) / factor)) throw new RangeError('Integer out of range');
        n += digit * factor;
        if (v < 128) return n;
        factor *= 128;
      }
      throw new RangeError('Invalid varuint');
    };
    const length = () => { const n = uint(); if (n > b.length) throw new RangeError('Invalid length'); return n; };
    const get = () => {
      switch (byte()) {
        case NULL: return null;
        case FALSE: return false;
        case TRUE: return true;
        case POSITIVE: return uint();
        case NEGATIVE: { const n = uint(); return n === 0 ? 0 : -n; }
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
            const index = uint(); if (index >= keys.length) throw new RangeError('Unknown key index');
            Object.defineProperty(value, keys[index], { value: get(), enumerable: true, writable: true, configurable: true });
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
