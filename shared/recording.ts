/**
 * What a recording says about itself, and whether this build can play it. One owner, because a
 * reader and a writer that each decide compatibility separately drift the way the sight rule did.
 *
 * Two numbers, not one, and the pair is the point. `schema` says what a recording *is*; `minSchema`
 * says the oldest reader that can still make sense of it. Additive changes — a new optional field,
 * a longer roster — bump `schema` and leave `minSchema` alone, so clients written before the change
 * keep playing recordings written after it. Only a change that genuinely breaks older readers bumps
 * `minSchema`. With a single number every bump would lock out every older client whether it needed
 * to or not, and widening compatibility again would mean a second format migration.
 *
 * The reader's policy stays deliberately simple: a floor, `MIN_SCHEMA`. That is not a constraint of
 * the format. Because compatibility is expressed over integers that both sides record, a reader can
 * later apply any policy it likes — a range, a set of supported versions, a per-feature table —
 * without the recordings changing shape again. Policy lives in the reader; the recording only
 * states facts about itself.
 *
 * `version` in the same header is a different axis and keeps its meaning: which simulation rules
 * produced the recording. A reader needs the schema pair to decide whether it can *read* a file;
 * `version` tells it what the contents *mean*. See [26](../docs/26-recording-contract.md).
 */

/** The schema this build writes. Bump on any change to recorded structure. */
export const SCHEMA = 1;
/**
 * The oldest schema this build can read. Zero, because recordings predating the schema field carry
 * no `schema` at all and are still playable; raise it only when support is deliberately dropped.
 */
export const MIN_SCHEMA = 0;

/**
 * Why a recording cannot be played, or `ok`. The wording belongs to whatever is showing it, so this
 * returns the reason rather than a sentence.
 *
 * - `too-new` — written by a later build that declared older readers cannot cope.
 * - `too-old` — below this build's supported floor.
 * - `pre-vector` — the grid prototype, whose maps carry no obstacle geometry the renderer can draw.
 *   Schema alone cannot catch these: they predate the field, so they are indistinguishable by
 *   number from any other pre-schema archive and have to be recognised by their contents.
 */
export type RecordingFit = 'ok' | 'too-new' | 'too-old' | 'pre-vector';

const count = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;

export function recordingFit(header: unknown): RecordingFit {
  const record = (header ?? {}) as { schema?: unknown; minSchema?: unknown; map?: { obstacles?: unknown } | null };
  if (count(record.minSchema) > SCHEMA) return 'too-new';
  if (count(record.schema) < MIN_SCHEMA) return 'too-old';
  if (!record.map?.obstacles) return 'pre-vector';
  return 'ok';
}
