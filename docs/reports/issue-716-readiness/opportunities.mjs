// Optimistic physical-contact ceiling under the fixed two-family/unchanged-brief scope.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const [source, evidence, panel, output] = process.argv.slice(2);
if (!output) throw Error('Usage: opportunities.mjs SOURCE EVIDENCE CANDIDATE_PANEL NEW_OUTPUT.gz');
const load = f => import(pathToFileURL(path.resolve(source, f)));
const { readChainMap } = await load('map/macro/src/chain/saving.ts');
const { planBlock } = await load('map/micro/strategies/block.ts');
const hash = b => createHash('sha256').update(b).digest('hex');
const selected = new Set(['depot', 'market']), key = c => `${c.x},${c.y}`;
const union = xs => {
  const result = [];
  for (const [a, b] of xs.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else result.push([a, b]);
  }
  return result;
};
const report = { definition: 'Optimistic eligible positive physical-join opportunity, not feasible placement or route encounters. A fixed unmodified opposite owner must already contact the seam with a static obstacle. Either selected family may hypothetically fill its allowed seam cell. Block parents are mutable only where an unchanged planned depot/market child has allowed fill. All original briefs, parent plans, other builders and ownership remain fixed.', cases: [] };
for (const w of [12, 24, 36]) for (let i = 1; i <= 3; i++) {
  const seed = `size-${w}-${i}`, inputs = {};
  const read = (root, file) => { const bytes = fs.readFileSync(path.resolve(root, file)); inputs[file] = hash(bytes); return bytes; };
  const map = readChainMap(gunzipSync(read(evidence, `baseline/${seed}.json.gz`)));
  const audit = JSON.parse(gunzipSync(read(evidence, `baseline-corrected/${seed}-seams.json.gz`)));
  const current = JSON.parse(gunzipSync(read(panel, `${seed}-seams.json.gz`)));
  const mutable = new Map(), blockChildren = [];
  for (const r of map.results.filter(r => r.brief.type === 'block')) {
    const lots = planBlock(r.brief).lots.filter(child => selected.has(child.type));
    mutable.set(r.brief.id, new Set(lots.flatMap(child => (child.fillCells ?? child.cells).map(key))));
    blockChildren.push({ id: r.brief.id, children: lots.map(c => ({ id: c.id, type: c.type, fillCells: (c.fillCells ?? c.cells).length })) });
  }
  const seams = audit.seams.filter(s => s.eligible && !s.guaranteed && s.types[0] !== s.types[1] && s.types.some(t => selected.has(t))).map(s => {
    const variable = s.types.map((type, side) => selected.has(type) || Boolean(mutable.get(s.owners[side])?.has(key(s.cells[side]))));
    const fixedSide = variable[0] ? 1 : 0;
    const possible = variable.every(Boolean) ? [[s.lo, s.hi]] : union(s.contacts[fixedSide].filter(c => c.kind === 'obstacle').map(c => c.interval));
    return { axis: s.axis, fixed: s.fixed, lo: s.lo, hi: s.hi, owners: s.owners, types: s.types, variable, possible };
  });
  // Validate that every measured anchor has a positive static/static overlap, not a gate-only join.
  const gateOnly = current.seams.filter(s => s.types.some(t => selected.has(t)) && s.joined.some(([a, b]) => b > a)).filter(s => {
    const [left, right] = s.contacts.map(cs => union(cs.filter(c => c.kind === 'obstacle').map(c => c.interval)));
    return !left.some(([a, b]) => right.some(([c, d]) => Math.min(b, d) > Math.max(a, c)));
  });
  const row = { seed, inputHashes: inputs, eligibleSeamCells: seams.length, possibleSeamCells: seams.filter(s => s.possible.length).length,
    possibleContactLength: seams.flatMap(s => s.possible).reduce((n, [a, b]) => n + b - a, 0), gateOnlyJoinedSeams: gateOnly.length, blockChildren, seams };
  report.cases.push(row); console.log(JSON.stringify({ seed, eligible: seams.length, possible: row.possibleSeamCells, possibleContactLength: row.possibleContactLength, gateOnlyJoinedSeams: row.gateOnlyJoinedSeams }));
}
report.scriptSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
fs.writeFileSync(output, gzipSync(JSON.stringify(report)), { flag: 'wx' });
