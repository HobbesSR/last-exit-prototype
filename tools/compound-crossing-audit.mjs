// Output-preserving crossing diagnosis for #629 / #531.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { clearFootprint } from '../map/kernel/margins.ts';
import { prepareDelegation } from '../map/micro/delegation.ts';
import { executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { buildCompoundGeneration } from '../map/micro/strategies/compound.ts';
import { previewedCoverExecution } from '../map/micro/strategies/cover.ts';
import { createRegionMask, elementShapes, travelClear } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['out'], arg => `Unknown option ${arg}; use --out=path.json`);
const key = c => `${c.x},${c.y}`;
const count = values => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});

function inspect(brief) {
  const node = buildCompoundGeneration(brief), events = [];
  if (!node.preparation) return { id: brief.id, cells: brief.cells.length, offers: 0, accepted: 0,
    fallback: node.fallbackReason, attempts: [], events: [] };
  const policy = { ...node.policyData, receiving: previewedCoverExecution().receiving };
  const prepared = prepareDelegation(node.input, node.offers, policy, event => events.push(event));
  assert.deepEqual(prepared, node.preparation, `${brief.id}: diagnostic replay preserves preparation`);
  const protectedKeys = new Set((policy.protectedCells ?? []).map(key));
  for (const c of clearFootprint(policy.protectedRuns ?? [], node.input.cells)) protectedKeys.add(key(c));
  const intersectsProtection = portal => {
    // Equivalent to clearFootprint([portal], protectedCells), without rebuilding
    // the reserved-cell set for every counterfactual offset in a broad yard.
    for (let along = -1; along <= portal.length; along++) for (const across of [-1, 0]) {
      const x = portal.x + (portal.axis === 'h' ? along : across);
      const y = portal.y + (portal.axis === 'v' ? along : across);
      if (protectedKeys.has(`${x},${y}`)) return true;
    }
    return false;
  };
  const playable = createRegionMask({ cells: [...node.input.cells, ...node.input.clearCells], cellSize: brief.cellSize });
  const radius = hunterClearance(brief.cellSize), width = Math.ceil(2 * radius / brief.cellSize);
  // Probe other offsets only as counterfactual first-stage feasibility. They do
  // not pass retained/child reach, inherited fill or receiver admission here.
  const probes = events.filter(e => e.portal).map(event => {
    const offered = node.offers.filter(o => event.offerKeys.includes(o.key));
    const given = new Set(offered.flatMap(o => o.cells.map(key)));
    const cells = event.a === node.input.id ? node.input.cells.filter(c => !given.has(key(c)))
      : offered.find(o => `${node.input.id}/delegate/${encodeURIComponent(o.key)}` === event.a).cells;
    const classify = portal => {
      if (intersectsProtection(portal)) return 'protected-footprint';
      const stands = portalStands({ cells, cellSize: brief.cellSize, portals: [portal] })[0].points;
      return stands.length && stands.every((p, i) => travelClear(playable, policy.blockers ?? [], p,
        stands[Math.max(0, i - 1)], radius)) ? 'selected' : 'blocked-travel';
    };
    assert.equal(classify(event.portal), event.reason, `${brief.id}: independent centered candidate classification`);
    const alternatives = [];
    for (let offset = 0; offset + width <= event.run.length; offset++) {
      const portal = { ...event.portal, x: event.run.x + (event.run.axis === 'h' ? offset : 0),
        y: event.run.y + (event.run.axis === 'v' ? offset : 0) };
      alternatives.push({ offset, reason: classify(portal) });
    }
    return { ...event, alternateOffsets: count(alternatives.map(a => a.reason)),
      firstClearOffset: alternatives.find(a => a.reason === 'selected')?.offset ?? null };
  });
  const attempts = [];
  for (const event of events) {
    let attempt = attempts.find(a => JSON.stringify(a.offerKeys) === JSON.stringify(event.offerKeys));
    if (!attempt) { attempt = { offerKeys: event.offerKeys, decisions: {} }; attempts.push(attempt); }
    attempt.decisions[event.reason] = (attempt.decisions[event.reason] ?? 0) + 1;
  }
  const flat = flattenDelegationResult(node), blockers = flat.elements.flatMap(e => elementShapes(e));
  return { id: brief.id, seed: brief.seed, cells: brief.cells.length, offers: node.offers.length,
    accepted: prepared.children.length, rejections: prepared.rejected, replayEqual: true,
    portalErrors: validatePortalReach({ ...node.input, blockers }).errors,
    leafPortalErrors: executionLeaves(node).flatMap(leaf => validatePortalReach({ ...leaf.brief, blockers }).errors),
    attempts, shortRuns: events.filter(e => !e.portal), candidates: probes };
}

const maps = [];
for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
  const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
  const views = mapViews(generate(seed, { mode: 'game', zoneWidth, zoneHeight }), GAME_ENGINES.compose);
  const rows = views.briefs.filter(b => b.type === 'compound').map(inspect);
  const summary = { regions: rows.length, offers: rows.reduce((n, r) => n + r.offers, 0),
    accepted: rows.reduce((n, r) => n + r.accepted, 0),
    decisions: count(rows.flatMap(r => r.candidates?.map(c => c.reason) ?? [])),
    candidatesWithClearAlternate: rows.flatMap(r => r.candidates ?? []).filter(c => c.reason !== 'selected' && c.firstClearOffset !== null).length };
  maps.push({ seed, zoneWidth, zoneHeight, summary, defects: views.report.defects, rows });
  console.log(JSON.stringify({ seed, ...summary }));
}
const fixturePath = 'tests/fixtures/compound-330-strip-brief.json.gz';
const fixtureBytes = await readFile(fixturePath);
const fixture = { path: fixturePath, sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  row: inspect(JSON.parse(gunzipSync(fixtureBytes))) };
const paths = ['tools/compound-crossing-audit.mjs', 'map/micro/delegation.ts', 'map/micro/delegation-execute.ts',
  'map/micro/strategies/compound.ts', 'map/micro/strategies/cover.ts', 'map/micro/geometry.ts',
  'map/micro/portals.ts', 'map/kernel/margins.ts', 'map/micro/region-types.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, createHash('sha256').update((await readFile(path, 'utf8')).replace(/\r\n/g, '\n')).digest('hex')])));
const report = { audit: 'compound-crossing-diagnosis-1', createdAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  commitMeaning: 'Checkout HEAD at report generation, not necessarily the audited code revision; sourceHashes identify the working-tree sources including uncommitted edits.',
  node: process.version, contentVersion: REGION_TYPES_VERSION, sourceHashFormat: 'sha256-utf8-lf', sourceHashes, maps, fixture,
  limits: 'Three current-library authored maps, top-level compounds only, plus one historical stored strip brief. Actual centered-candidate decisions come from unchanged preparation; exact preparation replay equality is asserted. Alternate offsets independently check only the existing protected-footprint and swept-travel gates on runs actually visited. They are not selected, and do not establish complete retained/child access, fill or receiver feasibility; later unvisited runs are not searched. Repeated candidates in incremental multi-offer attempts are counted separately. Root/leaf portal errors and full-map defects are retained rather than hidden. No generation, snapshot, reservation or policy changes and no density, loot, balance or performance improvement claimed.' };
const out = resolve(args.get('out') ?? 'test-results/629/compound-crossings.json');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
