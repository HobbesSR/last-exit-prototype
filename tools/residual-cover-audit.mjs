// #531's first installment: compare receivers on identical authored-map briefs.
// The baseline is the unchanged standalone cover builder, not an older library.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { buildCover, COVER_EXECUTOR_VERSION } from '../map/micro/strategies/cover.ts';
import { buildHutGeneration, HUT_EXECUTION_REGISTRY } from '../map/micro/strategies/hut.ts';
import { buildCompoundGeneration, COMPOUND_EXECUTION_REGISTRY } from '../map/micro/strategies/compound.ts';
import { executeDelegation, executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { saveDelegationSnapshot, readDelegationSnapshot } from '../map/micro/delegation-snapshot.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { measureFill } from '../map/micro/fill.ts';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['out'], arg => `Unknown option ${arg}; use --out=path.json`);
const out = resolve(args.get('out') ?? 'test-results/531-receiver.json');
// Read provenance first so an unavailable Git process fails before expensive checks.
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceHashes = Object.fromEntries(await Promise.all([
  'tools/residual-cover-audit.mjs', 'map/micro/strategies/cover.ts',
  'map/micro/strategies/hut.ts', 'map/micro/strategies/compound.ts', 'map/micro/region-types.ts',
].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const legacyCover = {
  version: 'cover-types-23', build: buildCover,
  receiving: brief => buildCover(brief).elements.length ? null : 'cover has no usable placement in the inherited fill',
};
const builders = {
  hut: [buildHutGeneration, HUT_EXECUTION_REGISTRY],
  compound: [buildCompoundGeneration, COMPOUND_EXECUTION_REGISTRY],
};
function inspect(node) {
  const flat = flattenDelegationResult(node), blockers = flat.elements.flatMap(e => elementShapes(e));
  const leaves = executionLeaves(node);
  const errors = [
    ...validateBriefPartition(node.input, leaves.map(leaf => leaf.brief)),
    ...validatePortalReach({ ...node.input, blockers }).errors,
    ...leaves.flatMap(leaf => validateFillConstraints(leaf.brief, leaf.elements.flatMap(e => elementShapes(e, true)))),
    ...leaves.flatMap(leaf => validatePortalReach({ ...leaf.brief, blockers }).errors),
  ];
  return {
    offers: node.offers?.length ?? 0, accepted: node.preparation?.children.length ?? 0,
    childElements: (node.children ?? []).reduce((n, child) => n + flattenDelegationResult(child).elements.length, 0),
    elements: flat.elements.length, loot: flat.loot.length, freeCells: measureFill(node.input, flat.elements).freeCells,
    rejections: node.preparation?.rejected.map(({ key, reason }) => ({ key, reason })) ?? [], errors,
  };
}
const maps = [];
for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
  const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
  const map = generate(seed, { mode: 'game', zoneWidth, zoneHeight });
  const views = mapViews(map, GAME_ENGINES.compose), rows = [], snapshots = new Set();
  for (const brief of views.briefs.filter(brief => builders[brief.type])) {
    const [build, registry] = builders[brief.type];
    const beforeNode = executeDelegation(brief, { ...registry, cover: legacyCover });
    const afterNode = build(brief);
    const before = inspect(beforeNode);
    const sameGeometry = isDeepStrictEqual(flattenDelegationResult(beforeNode), flattenDelegationResult(afterNode))
      && isDeepStrictEqual(executionLeaves(beforeNode), executionLeaves(afterNode));
    const after = sameGeometry ? structuredClone(before) : inspect(afterNode);
    // Accepted child interfaces may alter retained loot, but the primary building is fixed.
    assert.deepEqual(afterNode.retained.elements, beforeNode.retained.elements, `${brief.id}: primary structures`);
    let snapshot = null;
    if (after.accepted > before.accepted && !snapshots.has(brief.type)) {
      const full = saveDelegationSnapshot(afterNode), omitted = saveDelegationSnapshot(afterNode, { omitResults: true });
      assert.deepEqual(readDelegationSnapshot(full), afterNode);
      assert.deepEqual(flattenDelegationResult(readDelegationSnapshot(omitted, registry)), flattenDelegationResult(afterNode));
      // Full historical results load without today's builder registry; recovery refuses old versions.
      assert.deepEqual(readDelegationSnapshot(saveDelegationSnapshot(beforeNode)), beforeNode);
      assert.throws(() => readDelegationSnapshot(saveDelegationSnapshot(beforeNode, { omitResults: true }), registry), /version/i);
      snapshot = { full: true, omitted: true, historicalFull: true, historicalRecoveryRefused: true };
      snapshots.add(brief.type);
    }
    rows.push({ id: brief.id, type: brief.type, cells: brief.cells.length, before, after, snapshot });
  }
  const summary = Object.keys(builders).map(type => {
    const typed = rows.filter(row => row.type === type);
    const total = side => Object.fromEntries(['offers', 'accepted', 'childElements', 'elements', 'loot', 'freeCells'].map(key =>
      [key, typed.reduce((n, row) => n + row[side][key], 0)]));
    return { type, regions: typed.length, before: total('before'), after: total('after') };
  });
  const errors = [...views.report.defects, ...rows.flatMap(row => [...row.before.errors, ...row.after.errors])];
  maps.push({ seed, zoneWidth, zoneHeight, summary, rows, errors });
  console.log(JSON.stringify({ seed, summary, errors }));
}
const report = {
  audit: 'residual-cover-receiver-1', commit, sourceHashes, createdAt: new Date().toISOString(),
  contentVersion: REGION_TYPES_VERSION, receiverVersion: COVER_EXECUTOR_VERSION, maps,
  limits: 'One map per authored size, top-level huts/compounds only; same layouts and primary builders. Baseline receiver uses unchanged standalone buildCover. Checks root/leaf portal routes, leaf fill, partition, unchanged structures and sampled changed-node snapshot recovery. No claim of human balance, exhaustive coverage, or adoption by other strategies. Counts may differ from historical audits because authored libraries changed in #530.',
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
if (maps.some(map => map.errors.length)) process.exitCode = 1;
