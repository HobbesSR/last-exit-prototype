// A match from a retained tuned map cache (42.47), shared by the wire probes. The cache records the source revision
// its maps were generated at. The check refuses a cache whose map, simulation or server sources have changed since,
// apart from declaration-only exports a caller names (they change no behaviour).
import { readFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createMatch } from '../../server/match.js';
import { liveZoneSize } from '../../map/live.ts';
import { contentById, CONTENT_ID } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';

export async function loadCachedMatch(path, { declarationExports = [] } = {}) {
  const bytes = await readFile(path), cache = deserialize(bytes);
  const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number), size = liveZoneSize({ zoneWidth, zoneHeight });
  if (!size || !cache.maps?.length || cache.content !== CONTENT_ID || cache.generator !== 'chain-live-2' || !cache.source)
    throw new Error('requires a tuned chain-live-2 cache with a source revision (42.47)');
  execFileSync('git', ['diff', '--exit-code', cache.source, '--', 'map', 'shared', 'server', ...declarationExports.map(p => `:!${p}`)]);
  const declarationDiff = execFileSync('git', ['diff', cache.source, '--', ...declarationExports], { encoding: 'utf8' });
  const entry = structuredClone(cache.maps[0]);
  if (entry.navigation) attachPortalGraph(entry.map, entry.navigation);
  for (const packed of entry.tiles ?? []) adoptPackedTiles(entry.map, packed);
  const match = await createMatch(cache.seed, size, entry.map, contentById(cache.content));
  const sha = data => createHash('sha256').update(data).digest('hex');
  return {
    match,
    provenance: { path, sha256: sha(bytes), size: cache.size, seed: cache.seed, content: cache.content, source: cache.source,
      generatedAt: cache.generatedAt, generator: cache.generator, declarationExportsDiffSha256: sha(declarationDiff.replace(/\r\n/g, '\n')) },
  };
}
