/** Stable per-cell draws, independent of the order in which a brief lists its cells. */
export function draw(seed: number, x: number, y: number, channel: number): number {
  let n = Math.imul(seed ^ channel, 0x9e3779b1) ^ Math.imul(x, 0x85ebca6b) ^ Math.imul(y, 0xc2b2ae35);
  n = Math.imul(n ^ n >>> 16, 0x7feb352d);
  n = Math.imul(n ^ n >>> 15, 0x846ca68b);
  return ((n ^ n >>> 16) >>> 0) / 0x100000000;
}

const DELEGATION_CHANNEL = 0x64656c67;

/** Derive a named child seed without consuming or shifting the parent's random stream. */
export function delegationSeed(parentSeed: number, stableKey: string): number {
  if (!Number.isSafeInteger(parentSeed)) throw new RangeError('Parent seed must be a safe integer.');
  if (typeof stableKey !== 'string' || stableKey.length === 0) throw new RangeError('Delegation key must be a nonempty string.');

  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(stableKey)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return Math.floor(draw(parentSeed, hash, 0, DELEGATION_CHANNEL) * 0x7fffffff);
}
