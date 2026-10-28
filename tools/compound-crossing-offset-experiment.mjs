// Tool-only full-admission counterfactual for issue #631. Production stays unchanged.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { prepareDelegation } from '../map/micro/delegation.ts';
import { buildCompoundGeneration } from '../map/micro/strategies/compound.ts';
import { previewedCoverExecution } from '../map/micro/strategies/cover.ts';
import { createFillMask, elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['out'], arg => `Unknown option ${arg}; use --out=path.json`);
const target = { id: 'compound@792,168', offer: 'exterior:794,170', run: { axis: 'v', x: 803, y: 170, length: 20 } };
const source = await readFile('map/micro/delegation.ts', 'utf8');
const original = 'const offset = Math.floor((run.length - width) / 2);';
assert.equal(source.split(original).length, 2, 'instrumentation anchor must be unique');
const replacement = `const offset = parent.id === ${JSON.stringify(target.id)} && run.axis === 'v' && run.x === 803 && run.y === 170 && run.length === 20 && globalThis.__compoundOffset631 !== undefined ? globalThis.__compoundOffset631 : Math.floor((run.length - width) / 2);`;
assert.ok(!Object.hasOwn(globalThis, '__compoundOffset631'), 'experiment global must be unused');
const temporary = resolve('map/micro', `.compound-offset-${randomUUID()}.ts`);
try {
  await writeFile(temporary, source.replace(original, replacement), { flag: 'wx' });
  const experiment = (await import(pathToFileURL(temporary).href)).prepareDelegation;
  const seed = 'issue330-before-36x18';
  const views = mapViews(generate(seed, { mode: 'game', zoneWidth: 36, zoneHeight: 18 }), GAME_ENGINES.compose);
  const nodes = views.briefs.filter(b => b.type === 'compound').map(buildCompoundGeneration).filter(n => n.preparation);
  const witness = nodes.find(n => n.input.id === target.id);
  assert.ok(witness, 'current-map witness exists');
  assert.ok(witness.offers.some(o => o.key === target.offer), 'witness offer exists');
  function run(node, prepare, offset, diagnose = false) {
    globalThis.__compoundOffset631 = offset;
    const entry = previewedCoverExecution(), events = [];
    const prepared = prepare(node.input, node.offers, { ...node.policyData, receiving: entry.receiving }, e => events.push(e));
    const built = prepared.children.map(c => ({ patch: c, result: entry.build(c.brief) }));
    const blockers = [...(node.policyData.blockers ?? []), ...built.flatMap(c => c.result.elements.flatMap(e => elementShapes(e)))];
    const retainedFill = diagnose ? createFillMask(prepared.retained) : null;
    const rootFill = diagnose ? createFillMask(node.input) : null;
    const parentShapes = diagnose ? node.retained.elements.flatMap(e => elementShapes(e, true)) : [];
    const geometry = diagnose ? {
      rootPortalErrors: validatePortalReach({ ...node.input, blockers }).errors,
      retainedPortalErrors: validatePortalReach({ ...prepared.retained, blockers }).errors,
      childPortalErrors: built.map(c => ({ key: c.patch.key, errors: validatePortalReach({ ...c.patch.brief, blockers }).errors })),
      parentShapesOutsideRetainedFill: parentShapes.filter(s => !retainedFill.contains(s)).length,
      allShapesOutsideRootFill: [...parentShapes, ...built.flatMap(c => c.result.elements.flatMap(e => elementShapes(e, true)))].filter(s => !rootFill.contains(s)).length,
      childShapesOutsideFill: built.map(c => { const fill = createFillMask(c.patch.brief); return { key: c.patch.key, count: c.result.elements.flatMap(e => elementShapes(e, true)).filter(s => !fill.contains(s)).length }; }),
    } : null;
    return { prepared, events, cover: built.map(c => ({ key: c.patch.key, elements: c.result.elements.length })), geometry };
  }
  const centered = nodes.map(node => {
    const actual = run(node, prepareDelegation), replay = run(node, experiment);
    assert.deepEqual(actual.prepared, node.preparation, `${node.input.id}: baseline production replay`);
    assert.deepEqual(replay, actual, `${node.input.id}: instrumented centered replay`);
    return { id: node.input.id, accepted: actual.prepared.children.map(c => c.key), cover: actual.cover };
  });
  const baseline = run(witness, prepareDelegation, undefined, true);
  const candidate = baseline.events.find(e => e.run.axis === 'v' && e.run.x === 803 && e.run.y === 170 && e.run.length === 20 && e.offerKeys.includes(target.offer));
  assert.ok(candidate && candidate.reason === 'protected-footprint' && candidate.portal, 'centered conflict exists');
  const width = candidate.portal.length, centeredOffset = candidate.portal.y - target.run.y;
  const trials = [];
  for (let offset = 0; offset + width <= target.run.length; offset++) {
    const result = run(witness, experiment, offset);
    if (result.prepared.children.length) Object.assign(result, run(witness, experiment, offset, true));
    const event = result.events.find(e => e.run.axis === 'v' && e.run.x === 803 && e.run.y === 170 && e.run.length === 20 && e.offerKeys.includes(target.offer));
    trials.push({ offset, event: event ?? null, accepted: result.prepared.children.map(c => c.key), rejected: result.prepared.rejected, cover: result.cover, geometry: result.geometry, crossings: result.prepared.crossings });
  }
  assert.deepEqual(trials[centeredOffset].accepted, baseline.prepared.children.map(c => c.key));
  const ten = trials.find(t => t.offset === 10);
  assert.equal(ten?.event?.reason, 'selected', 'offset 10 clears first-stage gates');
  assert.ok(ten.accepted.includes(target.offer), 'offset 10 admits the witness offer');
  assert.ok(ten.cover.find(c => c.key === target.offer)?.elements > 0, 'admitted child has usable cover');
  assert.deepEqual(run(witness, experiment, centeredOffset, true), baseline, 'centered witness matches full production replay');
  const paths = ['tools/compound-crossing-offset-experiment.mjs', 'map/micro/delegation.ts', 'map/micro/delegation-execute.ts', 'map/micro/strategies/compound.ts', 'map/micro/strategies/cover.ts', 'map/micro/geometry.ts', 'map/micro/margins.ts', 'map/micro/portals.ts', 'map/kernel/margins.ts', 'map/micro/region-types.ts', 'map/chain.ts', 'map/macro/src/chain/map.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update((await readFile(path, 'utf8')).replace(/\r\n/g, '\n')).digest('hex')])));
  const report = { experiment: 'compound-crossing-offset-1', createdAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commitMeaning: 'Checkout HEAD; source hashes identify working-tree sources, including uncommitted edits.', node: process.version, contentVersion: REGION_TYPES_VERSION, sourceHashFormat: 'sha256-utf8-lf', sourceHashes, seed, target, width, centeredOffset, centered, baseline: { event: candidate, rejected: baseline.prepared.rejected, accepted: baseline.prepared.children.map(c => c.key), cover: baseline.cover, geometry: baseline.geometry }, trials, defects: views.report.defects, limits: 'One current-library 36x18 map and one specific seam. Each offset changes only this seam in a temporary copy of preparation and runs complete incremental admission, including partition, blockers and exact cover receiving preview. Root, retained and child portal reach and fill containment are reported separately against combined primary and preview geometry; errors are not suppressed. Other seams remain centered. Cover element counts are receiver previews, not a regenerated full compound or final gameplay validation. Centered replay equality is asserted for every prepared compound in this map. No policy, production output, version or fixture is changed; this does not establish general benefit or a safe offset selection policy.' };
  const out = resolve(args.get('out') ?? 'test-results/631/compound-crossing-offsets.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ out, centeredOffset, centeredSuccesses: centered.filter(c => c.accepted.length), trials: trials.map(t => ({ offset: t.offset, decision: t.event?.reason, accepted: t.accepted, cover: t.cover, rejected: t.rejected })) }));
} finally {
  delete globalThis.__compoundOffset631;
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
