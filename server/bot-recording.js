import { createHash } from 'node:crypto';

// Hash the encoded committed rows as IEEE-754 binary64 words in little-endian order.
export function botCommandDigest(words) {
  const bytes = Buffer.alloc(words.length * 8);
  for (let i = 0; i < words.length; i++) bytes.writeDoubleLE(words[i], i * 8);
  return createHash('sha256').update(bytes).digest('hex');
}
