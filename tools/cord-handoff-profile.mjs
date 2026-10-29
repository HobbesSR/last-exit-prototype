#!/usr/bin/env node
// Detached, source-checked instrumentation for issue #661. Node must support TypeScript stripping.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { gzipSync, gunzipSync } from 'node:zlib';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';

const args = process.argv.slice(2);
if (!(args[0] === '--profile' || args[0] === '--dense' || /^--compare=.+$/.test(args[0])) || args.length > 2
  || (args[1] && (!/^--source=.+$/.test(args[1]) || args[0].startsWith('--compare='))))
  throw new Error('Usage: node tools/cord-handoff-profile.mjs (--profile | --dense) [--source=<git-ref>] | --compare=<git-ref>');
const comparison = args[0].startsWith('--compare=') ? args[0].slice('--compare='.length) : null;
const sourceRef = args[1]?.slice('--source='.length) ?? null;
const root = new URL('../', import.meta.url), inputPath = 'docs/reports/issue-647/compound-response.json.gz';
const paths = ['map/micro/strategies/compound.ts', 'map/micro/yard-handoff.ts', 'map/micro/prospective-parcels.ts', 'map/micro/cord-witness.ts', 'map/micro/delegation-execute.ts', 'map/micro/delegation.ts', 'map/micro/strategies/cover.ts'];
const sha = data => createHash('sha256').update(data).digest('hex');
const sources = Object.fromEntries(await Promise.all(paths.map(async p => [p, (await readFile(new URL(p, root), 'utf8')).replace(/\r\n/g, '\n')])));
const extraSourcePaths = ['tools/cord-handoff-profile.mjs', 'tools/compound-cord-audit.mjs', 'map/micro/canvas.ts', 'map/micro/geometry.ts', 'map/micro/portals.ts', 'shared/free-space.ts'];
const extraSources = Object.fromEntries(await Promise.all(extraSourcePaths.map(async p => [p, sha((await readFile(new URL(p, root), 'utf8')).replace(/\r\n/g, '\n'))])));
const sourceCommit = sourceRef ? execFileSync('git', ['rev-parse', '--verify', `${sourceRef}^{commit}`], { cwd: root, encoding: 'utf8' }).trim() : null;
if (sourceCommit) sources[paths[3]] = execFileSync('git', ['show', `${sourceCommit}:${paths[3]}`], { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n');
const input = await readFile(new URL(inputPath, root));
const records = JSON.parse(gunzipSync(input)).records;
assert.equal(records.length, 38, 'retained input record count');
const nonce = `.cord-profile-${randomUUID()}`, temporary = [];
const localName = (p, suffix = '') => `${nonce}${suffix}-${p.split('/').at(-1)}`;
const urlFor = (p, suffix = '') => new URL(p.replace(/[^/]+$/, localName(p, suffix)), root);
async function put(p, source, suffix = '') { const url = urlFor(p, suffix); temporary.push(url); await writeFile(url, source, { flag: 'wx' }); return url; }
function replace(source, old, replacement, count = 1) {
  assert.equal(source.split(old).length - 1, count, `instrumentation anchor: ${old}`);
  return source.replaceAll(old, replacement);
}
const lock = await acquireMachineLock('bench');
try {
  if (comparison) {
    const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const baselineCommit = git('rev-parse', '--verify', `${comparison}^{commit}`).trim();
    const historical = Object.fromEntries(paths.map(p => [p, git('show', `${baselineCommit}:${p}`).replace(/\r\n/g, '\n')]));
    // This graph is deliberately restricted to the cord-only optimization. Other
    // dependencies are shared working-tree modules, so reject known graph drift.
    for (const p of paths.filter(p => p !== paths[3]))
      assert.equal(sources[p], historical[p], `Comparison supports cord-witness.ts changes only; ${p} differs`);
    async function graph(label, graphSources) {
      const suffix = `-${label}`;
      await put(paths[3], graphSources[paths[3]], suffix);
      const parcel = replace(graphSources[paths[2]], "'./cord-witness.ts'", `'./${localName(paths[3], suffix)}'`);
      await put(paths[2], parcel, suffix);
      const yard = replace(graphSources[paths[1]], "'./prospective-parcels.ts'", `'./${localName(paths[2], suffix)}'`);
      await put(paths[1], yard, suffix);
      await put(paths[4], graphSources[paths[4]], suffix);
      let compound = replace(graphSources[paths[0]], "'../yard-handoff.ts'", `'../${localName(paths[1], suffix)}'`, 2);
      compound = replace(compound, "'../delegation-execute.ts'", `'../${localName(paths[4], suffix)}'`, 2);
      return (await import((await put(paths[0], compound, suffix)).href)).buildCompoundGeneration;
    }
    const builders = { before: await graph('before', historical), after: await graph('after', sources) };
    const rounds = [];
    // A whole warmup followed by three paired rounds. Alternate order to reduce
    // systematic first-run effects. Every invocation is compared, not sampled.
    for (let round = 0; round <= 3; round++) {
      const samples = {};
      for (const label of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        samples[label] = records.map(record => {
          const start = performance.now();
          const result = builders[label](record.brief);
          const elapsedMs = performance.now() - start;
          const output = JSON.stringify(result);
          return { name: record.name, id: record.brief.id, elapsedMs, output,
            outputSha256: sha(output), offers: result.offers?.length ?? 0, children: result.children?.length ?? 0 };
        });
      }
      const rows = samples.before.map((before, i) => {
        const after = samples.after[i];
        assert.equal(before.output, after.output, `Output mismatch in round ${round}, ${before.id}`);
        assert.equal(before.outputSha256, after.outputSha256);
        return { name: before.name, id: before.id, outputSha256: before.outputSha256,
          offers: before.offers, children: before.children, beforeMs: before.elapsedMs, afterMs: after.elapsedMs };
      });
      rounds.push({ round, warmup: round === 0, order: round % 2 ? ['after', 'before'] : ['before', 'after'], rows });
      console.log(`Comparison round ${round}: ${rows.length} equal outputs`);
    }
    const report = { version: 'cord-handoff-comparison-1', createdAt: new Date().toISOString(), node: process.version,
      baselineCommit, currentCommit: git('rev-parse', 'HEAD').trim(), input: { path: inputPath, sha256: sha(input), records: records.length },
      sourceHashFormat: 'sha256-utf8-lf', beforeSources: Object.fromEntries(paths.map(p => [p, sha(historical[p])])),
      afterSources: Object.fromEntries(paths.map(p => [p, sha(sources[p])])), rounds,
      limitations: 'Only cord-witness.ts may differ among the checked source files; all other transitive dependencies come from the current working tree and are not checked against the baseline. Timings are sequential, uninstrumented and machine-specific. Full serialized generation output equality is asserted for each pair.' };
    const out = new URL('test-results/issue-661/compare.json.gz', root);
    await mkdir(new URL('test-results/issue-661/', root), { recursive: true });
    await writeFile(out, gzipSync(JSON.stringify(report)));
    console.log(JSON.stringify({ out: out.pathname, records: records.length, baselineCommit }));
  } else {
  const helperPath = 'map/micro/helper.mjs';
  const helperUrl = await put(helperPath, `import { performance } from 'node:perf_hooks';
export let data = {};
let stack = [];
export function reset() { data = {}; stack = []; }
export function timed(name, fn) { const frame = { start: performance.now(), childMs: 0 }; stack.push(frame); try { return fn(); } finally { const elapsed = performance.now() - frame.start; stack.pop(); if (stack.length) stack.at(-1).childMs += elapsed; const row = data[name] ??= { calls: 0, inclusiveMs: 0, exclusiveMs: 0 }; row.calls++; row.inclusiveMs += elapsed; row.exclusiveMs += elapsed - frame.childMs; } }
export function clone(value) { return timed('clone', () => structuredClone(value)); }
export function outcome(result) { const row = data.probeOutcomes ??= { accepted: 0, refused: 0, reasons: {}, counters: { meshBuilds: 0, sweeps: 0, paths: 0 } }; if (result.ok) row.accepted++; else { row.refused++; row.reasons[result.reason] = (row.reasons[result.reason] ?? 0) + 1; } for (const key of Object.keys(row.counters)) row.counters[key] += result.counters?.[key] ?? 0; return result; }
export function probe(fn) { const before = Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v?.inclusiveMs === 'number').map(([k, v]) => [k, { ...v }])); const result = timed('probeHandoff', fn); outcome(result); const stages = {}; for (const [name, value] of Object.entries(data)) { if (typeof value?.inclusiveMs !== 'number') continue; const prior = before[name] ?? {}; stages[name] = { calls: value.calls - (prior.calls ?? 0), inclusiveMs: value.inclusiveMs - (prior.inclusiveMs ?? 0), exclusiveMs: value.exclusiveMs - (prior.exclusiveMs ?? 0) }; } (data.probes ??= []).push({ verdict: result.ok ? 'accepted' : 'refused', reason: result.ok ? null : result.reason, counters: result.counters ?? null, stages }); return result; }
`);
  const helper = `./${localName(helperPath)}`;
  let cord = sources[paths[3]];
  cord = replace(cord, "import { freePaths, triangulateFreeSpace, type FreeSpace }", "import { freePaths as freePathsOriginal, triangulateFreeSpace as triangulateOriginal, type FreeSpace }");
  cord = replace(cord, "import { createAccessMask, travelClear, validShape }", "import { createAccessMask, travelClear as travelClearOriginal, validShape }");
  cord = `import { timed } from '${helper}';\n` + cord;
  cord = replace(cord, '/** Undirected geometric edge', `const freePaths: typeof freePathsOriginal = (...args) => timed('cordSearch', () => freePathsOriginal(...args));\nconst triangulateFreeSpace: typeof triangulateOriginal = (...args) => timed('cordMesh', () => triangulateOriginal(...args));\nconst travelClear: typeof travelClearOriginal = (...args) => timed('cordSweep', () => travelClearOriginal(...args));\n/** Undirected geometric edge`);
  await put(paths[3], cord);
  let parcel = sources[paths[2]];
  parcel = replace(parcel, "'./cord-witness.ts'", `'./${localName(paths[3])}'`);
  parcel = replace(parcel, 'import { discoverCordWitness, type CordWitness }', 'import { discoverCordWitness as discoverCordWitnessOriginal, type CordWitness }');
  parcel = `import { timed, clone } from '${helper}';\n` + parcel;
  parcel = replace(parcel, 'export interface ParcelHandle', `const discoverCordWitness: typeof discoverCordWitnessOriginal = (...args) => timed('cordWitness', () => discoverCordWitnessOriginal(...args));\nexport interface ParcelHandle`);
  parcel = parcel.replaceAll('structuredClone(', 'clone(');
  parcel = replace(parcel, 'const replay = (ps: Parcel[], ops = operations, target = brief) => {', 'const replayImpl = (ps: Parcel[], ops = operations, target = brief) => {');
  parcel = replace(parcel, '  const blockers = (ps: Parcel[], policy = acceptedPolicy): Shape[] => [', `  const replay: typeof replayImpl = (...args) => timed('replay', () => replayImpl(...args));\n  const blockers = (ps: Parcel[], policy = acceptedPolicy): Shape[] => [`);
  // Wrap the coordinator at the caller, leaving proposal identities untouched.
  await put(paths[2], parcel);
  let yard = sources[paths[1]];
  yard = replace(yard, "'./prospective-parcels.ts'", `'./${localName(paths[2])}'`);
  yard = `import { timed, probe as profileProbe } from '${helper}';\n` + yard;
  const dense = args[0] === '--dense';
  const state = `(globalThis as any)[${JSON.stringify(nonce)}]`;
  const initializationBrief = dense ? `{ ...brief, portals: brief.portals.filter(p => ${state}.denseIds.includes(p.id)) }` : 'brief';
  const finishInit = dense ? `report('init', created.ok ? undefined : created.reason); return;` : `if (created.ok) { const probe = created.coordinator.probeHandoff; created.coordinator.probeHandoff = (...args) => profileProbe(() => probe(...args)); const accept = created.coordinator.acceptHandoff; created.coordinator.acceptHandoff = (...args) => timed('acceptHandoff', () => accept(...args)); const execute = created.coordinator.executeHandoffs; created.coordinator.executeHandoffs = (...args) => timed('executeHandoffs', () => execute(...args)); }`;
  yard = replace(yard, 'const created = createProspectiveParcels(brief, { handoff: context, fixedAccess, terminals });', `const created = timed('initialization', () => createProspectiveParcels(${initializationBrief}, { handoff: context, fixedAccess, terminals }));\n  ${state}.push({ ok: created.ok, reason: created.ok ? null : created.reason, counters: created.counters ?? null, ...( ${dense} ? { retainedBox, steps, elements, fixedAccess, terminals } : {}) });\n  ${finishInit}`);
  await put(paths[1], yard);
  let delegation = sources[paths[5]];
  delegation = `import { timed, clone } from '${helper}';\n` + delegation.replaceAll('structuredClone(', 'clone(');
  delegation = replace(delegation, 'import { inheritBriefMargins }', 'import { inheritBriefMargins as inheritBriefMarginsOriginal }');
  delegation = replace(delegation, 'export interface PatchOffer', `const inheritBriefMargins: typeof inheritBriefMarginsOriginal = (...args) => timed('marginInheritance', () => inheritBriefMarginsOriginal(...args));\nexport interface PatchOffer`);
  delegation = replace(delegation, 'function finishPartition(', 'function finishPartitionOriginal(');
  delegation = replace(delegation, 'export interface PatchOffer', `const finishPartition: typeof finishPartitionOriginal = (...args) => timed('partitionValidation', () => finishPartitionOriginal(...args));\nexport interface PatchOffer`);
  await put(paths[5], delegation);
  let execution = sources[paths[4]];
  execution = replace(execution, "'./delegation.ts'", `'./${localName(paths[5])}'`, 2);
  execution = `import { timed, clone } from '${helper}';\n` + execution;
  execution = execution.replaceAll('structuredClone(', 'clone(');
  execution = replace(execution, '=> prepareCanonicalDelegation(brief, requested, {', "=> timed('preparation', () => prepareCanonicalDelegation(brief, requested, {");
  execution = replace(execution, 'return receiver ? receiver(child, offer) : null;', "return receiver ? timed('receiverPreview', () => receiver(child, offer)) : null;");
  execution = replace(execution, '      },\n    });\n    const context:', '      },\n    }));\n    const context:');
  await put(paths[4], execution);
  let compound = sources[paths[0]];
  if (args[0] === '--dense') compound = replace(compound, 'const MAX_HANDOFF_PORTALS = 128;', 'const MAX_HANDOFF_PORTALS = Infinity;');
  compound = replace(compound, "'../yard-handoff.ts'", `'../${localName(paths[1])}'`, 2);
  compound = replace(compound, "'../delegation-execute.ts'", `'../${localName(paths[4])}'`, 2);
  const compoundUrl = await put(paths[0], compound);
  const helperModule = await import(helperUrl.href);
  const build = (await import(compoundUrl.href)).buildCompoundGeneration;
  if (args[0] === '--dense') {
    const cells = Array.from({ length: 200 * 150 }, (_, i) => ({ x: i % 200, y: Math.floor(i / 200) }));
    const portals = [];
    for (let x = 2; x < 196; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
    for (let y = 2; y < 146; y += 4) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
    assert.equal(portals.length, 170);
    const counts = [128, 129, 140, 150, 160, 170];
    const brief = { id: 'field', seed: 3, type: 'compound', cellSize: 40, cells, portals,
      zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells }], parameters: { gates: 4 } };
    const rounds = [];
    let primarySha256;
    for (let round = 0; round <= 3; round++) {
      const rows = [];
      for (const count of counts) {
        helperModule.reset();
        globalThis[nonce] = [];
        globalThis[nonce].denseIds = portals.slice(0, count).map(p => p.id);
        const start = performance.now();
        const result = build(brief);
        const elapsedMs = performance.now() - start;
        assert.equal(globalThis[nonce].length, 1, `dense ${count}: exactly one initialization`);
        const init = globalThis[nonce][0];
        const primary = { retainedBox: init.retainedBox, steps: init.steps, elements: init.elements, fixedAccess: init.fixedAccess, terminals: init.terminals };
        const digest = sha(JSON.stringify(primary));
        if (primarySha256 === undefined) primarySha256 = digest;
        assert.equal(digest, primarySha256, `dense ${count}: primary geometry and obligations changed`);
        rows.push({ portals: count, elapsedMs, ok: init.ok, reason: init.reason, counters: init.counters,
          primarySha256: digest, outputSha256: sha(JSON.stringify(result)), stages: structuredClone(helperModule.data) });
      }
      rounds.push({ round, warmup: round === 0, rows });
    }
    const report = { version: 'cord-handoff-dense-init-2', createdAt: new Date().toISOString(), node: process.version,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceCommit,
      sourceHashFormat: 'sha256-utf8-lf', sources: { ...extraSources, ...Object.fromEntries(Object.entries(sources).map(([p, source]) => [p, sha(source)])) },
      fixture: { cells: cells.length, cellSize: 40, seed: 3, portalPrefixes: counts, primarySha256,
        geometry: '200x150 with full 170 portals for siting; coordinator receives ID-selected prefixes in the original audit order', inputSha256: sha(JSON.stringify(brief)) }, rounds,
      limitations: 'Investigation only: temporary compound guard bypass, full 170 portals for site selection, then portal prefix substitution at coordinator initialization and immediate return. No claims, settlement, offer probing or execution; this does not establish guard safety or complete compound adoption. One warmup and three sequential instrumented rounds; instrumentation perturbs timings. Selected source hashes do not cover all transitive dependencies.' };
    const out = new URL(sourceCommit ? 'test-results/issue-661/dense-before.json.gz' : 'test-results/issue-661/dense.json.gz', root);
    await mkdir(new URL('test-results/issue-661/', root), { recursive: true });
    await writeFile(out, gzipSync(JSON.stringify(report)));
    console.log(JSON.stringify({ out: out.pathname, cases: counts.length }));
  } else {
  const rows = [];
  globalThis[nonce] = [];
  for (const record of records) {
    helperModule.reset();
    globalThis[nonce] = [];
    const start = performance.now();
    const result = build(record.brief);
    const elapsedMs = performance.now() - start;
    const serialized = JSON.stringify(result);
    rows.push({ name: record.name, id: record.brief.id, cells: record.brief.cells.length, portals: record.brief.portals.length,
      elapsedMs, outputSha256: sha(serialized), offers: result.offers?.length ?? 0, children: result.children?.length ?? 0,
      initializationResults: structuredClone(globalThis[nonce]), stages: structuredClone(helperModule.data) });
  }
  const report = { version: 'cord-handoff-profile-1', createdAt: new Date().toISOString(), node: process.version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceCommit,
    input: { path: inputPath, sha256: sha(input), records: records.length },
    sourceHashFormat: 'sha256-utf8-lf', sources: { ...extraSources, ...Object.fromEntries(Object.entries(sources).map(([p, s]) => [p, sha(s)])) }, rows,
    timingSemantics: 'Wall time; inclusive timings overlap, exclusive timings subtract timed descendants. preparation includes receiverPreview; initialization and probeHandoff include cord work and clone/replay. cordSweep is exact travel-clear proof, cordMesh triangulation, cordSearch path search. Unattributed time includes all other work. Instrumentation perturbs timings.',
    limitations: 'Selected sources only, not the complete transitive graph. One instrumented round; no baseline comparison or dense witnesses. No optimization or performance claim.' };
  const out = new URL(sourceCommit ? 'test-results/issue-661/profile-before.json.gz' : 'test-results/issue-661/profile.json.gz', root);
  await mkdir(new URL('test-results/issue-661/', root), { recursive: true });
  await writeFile(out, gzipSync(JSON.stringify(report)));
  console.log(JSON.stringify({ out: out.pathname, records: rows.length }));
  }
  }
} finally {
  delete globalThis[nonce];
  for (const url of temporary) await unlink(url).catch(error => { if (error.code !== 'ENOENT') throw error; });
  lock.release();
}
