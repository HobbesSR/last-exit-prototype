// Synchronous RFC 1952 (gzip) / RFC 1951 (deflate) decompression for browser and Node callers.
// Used by `shared/wire-schema.ts` to decode compressed `welcome` and `ready` envelopes synchronously
// without an async stream step or third-party dependency.

const MAX_BITS = 15;
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

interface HuffmanTree {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildTree(lengths: Uint8Array, numSymbols: number): HuffmanTree {
  const counts = new Uint16Array(MAX_BITS + 1);
  for (let i = 0; i < numSymbols; i++) counts[lengths[i]]++;
  if (counts[0] === numSymbols) return { counts, symbols: new Uint16Array(0) };

  let left = 1;
  for (let len = 1; len <= MAX_BITS; len++) {
    left <<= 1;
    left -= counts[len];
    if (left < 0) throw new RangeError('invalid deflate huffman tree');
  }

  const offsets = new Uint16Array(MAX_BITS + 1);
  for (let len = 1; len < MAX_BITS; len++) offsets[len + 1] = offsets[len] + counts[len];
  const symbols = new Uint16Array(numSymbols);
  for (let sym = 0; sym < numSymbols; sym++) {
    const len = lengths[sym];
    if (len !== 0) symbols[offsets[len]++] = sym;
  }
  return { counts, symbols };
}

const FIXED_LIT = (() => {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return buildTree(lengths, 288);
})();

const FIXED_DIST = (() => {
  const lengths = new Uint8Array(32);
  lengths.fill(5);
  return buildTree(lengths, 32);
})();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Parses an RFC 1952 gzip header and returns the byte offset of the deflate payload. */
function parseGzipHeader(bytes: Uint8Array): number {
  if (bytes.length < 18) throw new RangeError('truncated gzip stream');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new RangeError('invalid gzip header');
  const flags = bytes[3];
  if (flags & 0xe0) throw new RangeError('invalid gzip flags');
  const dataEnd = bytes.length - 8;
  let pos = 10;
  if (flags & 0x04) {
    if (pos + 2 > dataEnd) throw new RangeError('truncated gzip stream');
    const xlen = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2 + xlen;
  }
  if (flags & 0x08) {
    while (pos < dataEnd && bytes[pos] !== 0) pos++;
    if (pos >= dataEnd) throw new RangeError('truncated gzip stream');
    pos++;
  }
  if (flags & 0x10) {
    while (pos < dataEnd && bytes[pos] !== 0) pos++;
    if (pos >= dataEnd) throw new RangeError('truncated gzip stream');
    pos++;
  }
  if (flags & 0x02) pos += 2;
  if (pos > dataEnd) throw new RangeError('truncated gzip stream');
  return pos;
}

/**
 * Decompresses a single-member RFC 1952 gzip payload synchronously, refusing truncated streams, trailing bytes,
 * CRC/size mismatches, and inflated outputs exceeding `maxBytes`.
 */
export function gunzip(bytes: Uint8Array, maxBytes: number): Uint8Array {
  let bytePos = parseGzipHeader(bytes);
  const dataEnd = bytes.length - 8;
  let bitBuf = 0, bitCount = 0;

  const ensureBits = (n: number): void => {
    while (bitCount < n) {
      if (bytePos >= dataEnd) throw new RangeError('truncated gzip stream');
      bitBuf |= bytes[bytePos++] << bitCount;
      bitCount += 8;
    }
  };
  const readBits = (n: number): number => {
    if (n === 0) return 0;
    ensureBits(n);
    const val = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return val;
  };
  const alignByte = (): void => {
    const discard = bitCount & 7;
    if (discard) {
      bitBuf >>>= discard;
      bitCount -= discard;
    }
    bytePos -= bitCount >>> 3;
    bitBuf = 0;
    bitCount = 0;
  };
  const decodeSymbol = (tree: HuffmanTree): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= MAX_BITS; len++) {
      ensureBits(1);
      code |= bitBuf & 1;
      bitBuf >>>= 1;
      bitCount--;
      const count = tree.counts[len];
      if (code - count < first) return tree.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new RangeError('invalid deflate huffman code');
  };

  let out = new Uint8Array(Math.min(maxBytes, Math.max(256, bytes.length * 4)));
  let outLen = 0;
  const reserveOut = (add: number): void => {
    if (outLen + add > maxBytes) throw new RangeError('compressed message too large');
    if (outLen + add <= out.length) return;
    let nextCap = out.length * 2;
    while (nextCap < outLen + add) nextCap *= 2;
    const next = new Uint8Array(Math.min(maxBytes, nextCap));
    next.set(out.subarray(0, outLen));
    out = next;
  };

  let finalBlock = 0;
  while (!finalBlock) {
    finalBlock = readBits(1);
    const blockType = readBits(2);
    if (blockType === 0) {
      alignByte();
      if (bytePos + 4 > dataEnd) throw new RangeError('truncated gzip stream');
      const len = bytes[bytePos] | (bytes[bytePos + 1] << 8);
      const nlen = bytes[bytePos + 2] | (bytes[bytePos + 3] << 8);
      bytePos += 4;
      if ((len ^ 0xffff) !== nlen) throw new RangeError('invalid deflate stored block');
      if (bytePos + len > dataEnd) throw new RangeError('truncated gzip stream');
      reserveOut(len);
      out.set(bytes.subarray(bytePos, bytePos + len), outLen);
      outLen += len;
      bytePos += len;
      continue;
    }
    if (blockType === 3) throw new RangeError('invalid deflate block type');

    let litTree = FIXED_LIT, distTree = FIXED_DIST;
    if (blockType === 2) {
      const hlit = readBits(5) + 257;
      const hdist = readBits(5) + 1;
      const hclen = readBits(4) + 4;
      if (hlit > 286 || hdist > 30) throw new RangeError('invalid deflate header');
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) codeLengths[CODE_LENGTH_ORDER[i]] = readBits(3);
      const codeTree = buildTree(codeLengths, 19);

      const lengths = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = decodeSymbol(codeTree);
        if (sym < 16) {
          lengths[i++] = sym;
        } else {
          let repeat = 0, value = 0;
          if (sym === 16) {
            if (i === 0) throw new RangeError('invalid deflate repeat');
            value = lengths[i - 1];
            repeat = 3 + readBits(2);
          } else if (sym === 17) {
            repeat = 3 + readBits(3);
          } else {
            repeat = 11 + readBits(7);
          }
          if (i + repeat > hlit + hdist) throw new RangeError('invalid deflate code length repeat');
          lengths.fill(value, i, i + repeat);
          i += repeat;
        }
      }
      if (lengths[256] === 0) throw new RangeError('invalid deflate end-of-block');
      litTree = buildTree(lengths.subarray(0, hlit), hlit);
      distTree = buildTree(lengths.subarray(hlit), hdist);
    }

    while (true) {
      const sym = decodeSymbol(litTree);
      if (sym < 256) {
        reserveOut(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        if (sym > 285) throw new RangeError('invalid deflate length symbol');
        const lenIdx = sym - 257;
        const length = LEN_BASE[lenIdx] + readBits(LEN_EXTRA[lenIdx]);
        const distSym = decodeSymbol(distTree);
        if (distSym >= 30) throw new RangeError('invalid deflate distance symbol');
        const distance = DIST_BASE[distSym] + readBits(DIST_EXTRA[distSym]);
        if (distance < 1 || distance > outLen) throw new RangeError('invalid deflate distance');
        reserveOut(length);
        if (distance >= length) {
          out.copyWithin(outLen, outLen - distance, outLen - distance + length);
          outLen += length;
        } else {
          for (let k = 0; k < length; k++) {
            out[outLen] = out[outLen - distance];
            outLen++;
          }
        }
      }
    }
  }

  alignByte();
  if (bytePos !== dataEnd) throw new RangeError('trailing bytes in gzip stream');

  const expectedCrc = (bytes[dataEnd] | (bytes[dataEnd + 1] << 8) | (bytes[dataEnd + 2] << 16) | (bytes[dataEnd + 3] << 24)) >>> 0;
  const expectedSize = (bytes[dataEnd + 4] | (bytes[dataEnd + 5] << 8) | (bytes[dataEnd + 6] << 16) | (bytes[dataEnd + 7] << 24)) >>> 0;
  const result = out.subarray(0, outLen);
  if (crc32(result) !== expectedCrc) throw new RangeError('gzip crc mismatch');
  if ((outLen >>> 0) !== expectedSize) throw new RangeError('gzip size mismatch');
  return result;
}
