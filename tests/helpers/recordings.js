// Reading stored recordings back in tests (26, shared/recording-format.ts): every frame rebuilt, every
// checkpoint checked, and the archive digest recomputed from the stored lines.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { checkpointFailures, readRecording } from '../../shared/recording-format.ts';

export const sha256 = text => createHash('sha256').update(text).digest('hex');

/** An archive's text, from gzip bytes (a Buffer or chunks) or text. */
export function archiveText(source) {
  if (typeof source === 'string') return source;
  return gunzipSync(Array.isArray(source) ? Buffer.concat(source) : source).toString('utf8');
}

/** A stored archive read back with its frames rebuilt; throws if a checkpoint does not hold. */
export function readArchive(source) {
  const recording = readRecording(archiveText(source));
  const failures = checkpointFailures(recording, sha256);
  if (failures.length) throw new Error(`checkpoints fail at frames ${failures.join(', ')}`);
  return recording;
}

/** The stored lines between the header and the trailer: one per retained frame. */
export function storedLines(source) {
  const lines = archiveText(source).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(1, lines.at(-1)?.startsWith('{"end":') ? -1 : undefined);
}

/** The archive digest the writer publishes: SHA-256 over each stored frame line and a newline (26). */
export function storedDigest(source) {
  const hash = createHash('sha256');
  for (const line of storedLines(source)) hash.update(`${line}\n`);
  return hash.digest('hex');
}
