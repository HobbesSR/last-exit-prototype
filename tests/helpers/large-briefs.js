import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { checkBrief } from './builder-contract.js';

/** The larger authored sizes' extreme briefs (`tools/large-briefs.mjs`), and those of each type. */
export const { briefs } = JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/large-briefs.json.gz', import.meta.url))));
export const byType = new Map();
for (const entry of briefs) byType.set(entry.brief.type, [...byType.get(entry.brief.type) ?? [], entry]);

/** Types whose briefs are checked in a file of their own, to keep each under the slow tier's 60 s (31, #849). */
export const OWN_FILE = new Set(['park']);
const BUILDS_NOTHING = new Set(['open']);

/** Each of a type's briefs builds, keeps its geometry in the fill and counts every cell (the contract's checks). */
export function checkLargeBriefs(type, entries) {
  const found = [];
  for (const { seed, brief } of entries) {
    const at = `${seed}/${brief.id} (${brief.portals.length} portals, ${brief.cells.length} cells)`;
    const { result, found: problems } = checkBrief(brief, { reach: false, reorder: false });
    for (const problem of problems) found.push(`${at}: ${problem}`);
    if (result && !BUILDS_NOTHING.has(type) && !result.elements.length) found.push(`${at}: built no geometry, so it proves nothing`);
  }
  assert.deepEqual(found, []);
}
