/**
 * FNV-1a over exact float64 bits, for digests that pin computed results (tests/math.test.js,
 * tests/sight-core.test.js). NaN is mixed as the one canonical NaN, whatever its payload.
 */
export function digester() {
  const bits = new DataView(new ArrayBuffer(8));
  let digest = 0x811c9dc5;
  const mix = value => {
    bits.setFloat64(0, Number.isNaN(value) ? NaN : value);
    for (let i = 0; i < 8; i++) digest = Math.imul(digest ^ bits.getUint8(i), 0x01000193) >>> 0;
  };
  return { mix, hex: () => digest.toString(16) };
}
