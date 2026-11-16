// A match from a retained tuned map cache (42.47), shared by the wire probes. The cache records the source revision
// its maps were generated at. The check refuses a cache whose map, simulation or server sources have changed since,
// except for reviewed changes the caller pins: { path: sha256 of that file's LF-normalized diff from the cache's
// source }. A pinned file whose diff differs from its reviewed hash is refused, so a later behavioural change in the
// same file cannot pass as the reviewed declaration-only one (review 868 on PR #1140).
import { readFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createMatch } from '../../server/match.js';
import { liveZoneSize } from '../../map/live.ts';
import { contentById, CONTENT_ID } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';

const sha = data => createHash('sha256').update(data).digest('hex');

/** The LF-normalized diff of one file from a revision, and its hash. */
export function fileDiff(revision, path) {
  // Full blob ids: the default abbreviation grows with the repository, which would change the hash of an unchanged diff.
  const diff = execFileSync('git', ['diff', '--full-index', '--no-color', '--no-ext-diff', revision, '--', path], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
  return { diff, sha256: sha(diff) };
}

export async function loadCachedMatch(path, { reviewedChanges = {} } = {}) {
  const bytes = await readFile(path), cache = deserialize(bytes);
  const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number), size = liveZoneSize({ zoneWidth, zoneHeight });
  if (!size || !cache.maps?.length || cache.content !== CONTENT_ID || cache.generator !== 'chain-live-2' || !cache.source)
    throw new Error('requires a tuned chain-live-2 cache with a source revision (42.47)');
  const pinned = Object.keys(reviewedChanges);
  execFileSync('git', ['diff', '--exit-code', '--stat', cache.source, '--', 'map', 'shared', 'server', ...pinned.map(p => `:!${p}`)]);
  for (const file of pinned) {
    const { diff, sha256 } = fileDiff(cache.source, file);
    if (sha256 !== reviewedChanges[file]) throw new Error(`${file} differs from its reviewed change since ${cache.source} (diff sha256 ${sha256}):\n${diff}`);
  }
  const entry = structuredClone(cache.maps[0]);
  if (entry.navigation) attachPortalGraph(entry.map, entry.navigation);
  for (const packed of entry.tiles ?? []) adoptPackedTiles(entry.map, packed);
  const match = await createMatch(cache.seed, size, entry.map, contentById(cache.content));
  return {
    match,
    provenance: { path, sha256: sha(bytes), size: cache.size, seed: cache.seed, content: cache.content, source: cache.source,
      generatedAt: cache.generatedAt, generator: cache.generator, reviewedChanges },
  };
}
