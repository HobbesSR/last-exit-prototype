import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

/**
 * `map/tools/author-inward-grounds.mts` authored the inward variants of the module set it
 * names: `common-primitives@5`, `common-set-pieces@5`, `district-set-pieces@4`. The #849
 * adoption migrated them into later versions by hand (weights, `fillable`, hints), which the
 * tool doesn't author, so its checks read that set. A committed top-level library now pins the
 * later set, so these checks read a copy pinned back. The sparse-sides adoption (#851, #895)
 * pointed its local set pieces' slots at `<set>-sp-<n>` sets of its own; the copy points them
 * back at the authored `<set>` and drops those sets and their tiles.
 */
export const INWARD_MODULES = ['common-primitives@5.json', 'common-set-pieces@5.json', 'district-set-pieces@4.json'];
const PINS = { 'common-primitives': 5, 'common-set-pieces': 5, 'district-set-pieces': 4 };
let dir;

/** A temporary copy of committed top-level library `name` that includes the inward tool's module set. */
export function inwardSourceLibrary(name) {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'last-exit-inward-source-'));
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  const library = JSON.parse(readFileSync(resolve('map/macro/content', name), 'utf8'));
  library.includes = library.includes.map(ref => ({ ...ref, version: PINS[ref.name] ?? ref.version }));
  delete library.passabilityRules;
  delete library.fitPlacedSetPieces;
  delete library.tiles;
  delete library.tileSets;
  for (const piece of library.setPieces ?? [])
    piece.tiles = piece.tiles.map(slot => ({ ...slot, tileSetId: slot.tileSetId.replace(/-sp-\d+$/, '') }));
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(library, null, 2) + '\n');
  return file;
}
