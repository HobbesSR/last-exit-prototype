// Read-only opportunity ceiling on the ORIGINAL fixed routes. No generated content changes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const [source, evidence, output] = process.argv.slice(2);
if (!output) throw Error('Usage: exposure.mjs PROTOTYPE_SOURCE EXTRACTED_EVIDENCE NEW_OUTPUT');
const load = file => import(pathToFileURL(path.resolve(source, file)));
const { readChainMap } = await load('map/macro/src/chain/saving.ts');
const { rect, segmentShapeDistance } = await load('shared/shape.ts');
const { bodyRadius } = await load('shared/movement.ts');
const hash = b => createHash('sha256').update(b).digest('hex');
const report = { definition: 'Optimistic exposure ceiling, NOT feasible geometry or encounter evidence: an original complete route touches any allowed fill cell of a depot/market owner with an eligible different-type seam. Every cell of that owner is hypothetically solid, ignoring access, spacing, siting and loot. Original routes and geometry are unchanged. Local seam-cell exposure is also recorded but is not an upper bound for long inward obstacles.', cases: [] };
for (const width of [12, 24, 36]) for (let i = 1; i <= 3; i++) {
  const seed = `size-${width}-${i}`, inputs = {};
  const read = file => { const bytes = fs.readFileSync(path.resolve(evidence, file)); inputs[file] = hash(bytes); return bytes; };
  const map = readChainMap(gunzipSync(read(`baseline/${seed}.json.gz`)));
  const seams = JSON.parse(gunzipSync(read(`baseline-corrected/${seed}-seams.json.gz`)));
  const routes = JSON.parse(read(`baseline-routes/${seed}-routes.json`));
  const size = map.cellSize, { origin } = seams;
  const selected = new Set(['depot', 'market']), eligibleOwners = new Set(), edgeCells = new Set();
  let eligibleUnits = 0;
  for (const s of seams.seams) if (s.eligible && !s.guaranteed && s.types[0] !== s.types[1] && s.types.some(t => selected.has(t))) {
    eligibleUnits++;
    s.owners.forEach((id, side) => { if (selected.has(s.types[side])) { eligibleOwners.add(id); const c = s.cells[side]; edgeCells.add(`${c.x},${c.y}`); } });
  }
  const fill = new Map();
  for (const r of map.results) if (selected.has(r.brief.type) && eligibleOwners.has(r.brief.id))
    for (const c of r.brief.fillCells ?? r.brief.cells) fill.set(`${c.x},${c.y}`, r.brief.id);
  const bodies = {};
  for (const [body, role] of [['contestant', 'contestant'], ['hunter', 'gladiator']]) {
    const radius = bodyRadius({ role }), padding = Math.ceil(radius / size) + 1;
    const rows = routes.bodies[body].routes.map((r, index) => {
      const touchedOwners = new Set(), touchedEdges = new Set();
      if (r.status === 'complete') for (let j = 1; j < r.points.length; j++) {
        const a = r.points[j - 1], b = r.points[j];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (size / 2))), candidates = new Set();
        // Samples at <= half a cell plus a conservative square neighborhood cover
        // every cell within radius of the segment. Exact distance removes false positives.
        for (let t = 0; t <= steps; t++) {
          const x = Math.floor((a.x + (b.x - a.x) * t / steps - origin.x) / size);
          const y = Math.floor((a.y + (b.y - a.y) * t / steps - origin.y) / size);
          for (let dy = -padding; dy <= padding; dy++) for (let dx = -padding; dx <= padding; dx++) {
            const k = `${x + dx},${y + dy}`; if (fill.has(k)) candidates.add(k);
          }
        }
        for (const k of candidates) {
          const [x, y] = k.split(',').map(Number);
          if (segmentShapeDistance(a, b, rect(x * size + origin.x, y * size + origin.y, size, size)) < radius - 0.01) {
            touchedOwners.add(fill.get(k)); if (edgeCells.has(k)) touchedEdges.add(k);
          }
        }
      }
      return { index, category: r.category, status: r.status, ownerFillExposure: [...touchedOwners].sort(), localSeamCellExposure: [...touchedEdges].sort() };
    });
    bodies[body] = { attempted: rows.length, complete: rows.filter(r => r.status === 'complete').length,
      optimisticOwnerFillCeiling: rows.filter(r => r.ownerFillExposure.length).length,
      localSeamCellExposure: rows.filter(r => r.localSeamCellExposure.length).length, routes: rows };
  }
  report.cases.push({ seed, inputHashes: inputs, eligibleUnits, eligibleOwners: [...eligibleOwners].sort(), fillCells: fill.size, bodies });
  console.log(JSON.stringify({ seed, eligibleUnits, fillCells: fill.size, bodies: Object.fromEntries(Object.entries(bodies).map(([k, { routes, ...v }]) => [k, v])) }));
}
report.totals = {};
for (const c of report.cases) for (const [body, b] of Object.entries(c.bodies)) {
  const total = report.totals[body] ??= { attempted: 0, complete: 0, optimisticOwnerFillCeiling: 0, localSeamCellExposure: 0 };
  for (const k of Object.keys(total)) total[k] += b[k];
}
report.scriptSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report.totals));
