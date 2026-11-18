// Finds the two kinds of damage Windows tools do to UTF-8 text (#1179): a byte-order mark, which
// PowerShell 5.1's Set-Content and Out-File write, and double encoding, where UTF-8 bytes were read
// as cp1252 (PowerShell 5.1's Get-Content, Python's default on Windows) and written back as UTF-8,
// so `·` (U+00B7) becomes U+00C2 U+00B7. Examples here are code points: the text itself would fail.

const cp1252 = new TextDecoder('windows-1252');
/** How cp1252 shows each UTF-8 continuation byte, 0x80 to 0xBF. */
const continuation = `[${Array.from({ length: 64 }, (_, i) => cp1252.decode(Uint8Array.of(0x80 + i)))
  .join('').replace(/[\]\\^-]/g, '\\$&')}]`;
/** A cp1252-rendered UTF-8 lead byte followed by as many continuation bytes as it announces. */
const doubleEncoded = new RegExp(
  `[\\u00c2-\\u00df]${continuation}|[\\u00e0-\\u00ef]${continuation}{2}|[\\u00f0-\\u00f4]${continuation}{3}`, 'g');

/** Returns one message per problem in `bytes`, with a line number for double encoding. */
export function encodingDamage(bytes) {
  const problems = [];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push('starts with a UTF-8 byte-order mark');
  const text = Buffer.from(bytes).toString('utf8');
  for (const match of text.matchAll(doubleEncoded)) {
    const line = text.slice(0, match.index).split('\n').length;
    problems.push(`line ${line}: ${JSON.stringify(match[0])} is double-encoded UTF-8 (it was ${JSON.stringify(Buffer.from(cp1252Bytes(match[0])).toString('utf8'))})`);
  }
  return problems;
}

function cp1252Bytes(text) {
  const bytes = [];
  for (const char of text) {
    for (let b = 0; b < 256; b++) if (cp1252.decode(Uint8Array.of(b)) === char) { bytes.push(b); break; }
  }
  return bytes;
}
