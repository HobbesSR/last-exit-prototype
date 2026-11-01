import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const [panel, effects, output] = process.argv.slice(2);
if (!output) throw Error('Usage: summarize.mjs PANEL EFFECTS NEW_OUTPUT');
const hash = b => createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.resolve(panel, 'manifest.json')));
const effectBytes = fs.readFileSync(path.resolve(effects, 'summary.json')), effectSummary = JSON.parse(effectBytes);
const report = { version: 'issue-716-readiness-summary-1', effectSummarySha256: hash(effectBytes), cases: [], totals: {}, categories: {}, typePairs: {} };
const types = new Set(['depot', 'market']);
const union = intervals => {
  const result = [];
  for (const [a, b] of intervals.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0] || p[1] - q[1])) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else result.push([a, b]);
  }
  return result;
};
const length = intervals => intervals.reduce((n, [a, b]) => n + b - a, 0);
for (const row of manifest.cases) {
  for (const [f, h] of Object.entries(row.artifacts)) if (hash(fs.readFileSync(path.resolve(panel, f))) !== h) throw Error(`Artifact drift: ${f}`);
  const raw = JSON.parse(gunzipSync(fs.readFileSync(path.resolve(panel, `${row.seed}-seams.json.gz`))));
  const effect = effectSummary.cases.find(c => c.seed === row.seed);
  const detailedBytes = fs.readFileSync(path.resolve(effects, `${row.seed}-effects.json`));
  if (hash(detailedBytes) !== effect.outputSha256) throw Error(`Effect artifact drift: ${row.seed}`);
  const detailed = JSON.parse(detailedBytes), categories = {};
  for (const [body, { routes }] of Object.entries(detailed.bodies)) for (const route of routes) {
    const counts = (categories[body] ??= {})[route.category] ??= { attempted: 0, affected: 0, zeroEffect: 0 };
    const total = (report.categories[body] ??= {})[route.category] ??= { attempted: 0, affected: 0, zeroEffect: 0 };
    for (const group of [counts, total]) { group.attempted++; group.affected += Number(route.effect); group.zeroEffect += Number(!route.effect); }
  }
  const groups = Object.fromEntries(Object.entries(raw.groups).filter(([pair]) => pair.split(' / ').some(t => types.has(t))));
  const selected = raw.seams.filter(s => s.types[0] !== s.types[1] && s.types.some(t => types.has(t)));
  for (const s of selected.filter(s => s.eligible && !s.guaranteed)) {
    const group = report.typePairs[s.pair] ??= { eligibleLength: 0, contactLengthByType: {}, joinedLength: 0, sampledCrossingsPerBody: 0,
      bodies: { contestant: { blockedSamples: 0, contiguousBlockedSpans: 0, maxBlockedSpanCells: 0 }, hunter: { blockedSamples: 0, contiguousBlockedSpans: 0, maxBlockedSpanCells: 0 } } };
    group.eligibleLength += raw.cellSize; group.joinedLength += length(s.joined); group.sampledCrossingsPerBody += 2;
    s.contacts.forEach((contacts, side) => { const type = s.types[side]; group.contactLengthByType[type] = (group.contactLengthByType[type] ?? 0) + length(union(contacts.map(c => c.interval))); });
    for (const body of ['contestant', 'hunter']) group.bodies[body].blockedSamples += s.blocked[body].length;
  }
  for (const line of raw.spans.filter(s => s.types[0] !== s.types[1] && s.types.some(t => types.has(t)))) {
    const group = report.typePairs[line.pair]; if (!group) continue;
    for (const body of ['contestant', 'hunter']) {
      const spans = union(line.eligible.flatMap(([a, b]) => line.blocked[body].map(([c, d]) => [Math.max(a, c), Math.min(b, d)])));
      group.bodies[body].contiguousBlockedSpans += spans.length;
      group.bodies[body].maxBlockedSpanCells = Math.max(group.bodies[body].maxBlockedSpanCells, ...spans.map(([a, b]) => (b - a) / raw.cellSize));
    }
  }
  const joinedLength = selected.reduce((n, s) => n + length(s.joined), 0);
  const eligibleSpans = raw.spans.filter(s => s.types[0] !== s.types[1] && s.types.some(t => types.has(t))).flatMap(s => s.eligible.map(([a, b]) => (b - a) / raw.cellSize));
  const bodies = effect.bodies;
  for (const [body, counts] of Object.entries(bodies)) {
    const total = report.totals[body] ??= {};
    for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
  }
  report.cases.push({ seed: row.seed, buildMs: row.buildMs, selectedJoinedLength: joinedLength,
    eligibleSeamCells: selected.filter(s => s.eligible).length,
    eligibleSpans: { count: eligibleSpans.length, maxCells: Math.max(0, ...eligibleSpans), oneCell: eligibleSpans.filter(v => v === 1).length },
    groups, bodies, categories, finalRouteStatuses: Object.fromEntries(Object.entries(row.bodies).map(([k, b]) => [k, b.statuses])),
    rebuiltOwners: row.rows.length, manifests: row.rows.map(({ id, type, manifest }) => ({ id, type, manifest })) });
}
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ totals: report.totals, cases: report.cases.map(({ seed, selectedJoinedLength, bodies }) => ({ seed, selectedJoinedLength, bodies })) }));
