#!/usr/bin/env node
/**
 * Point-in-time paired compound delegation timings. Run with Node's TypeScript support.
 * Compares --before's delegation.ts with the checked-out file; both use current
 * sibling modules, executor and compound strategy. Recheck compatibility if they drift.
 * Temporary .timing-<uuid>-*.ts modules live beside their originals in map/micro/
 * and map/micro/strategies/ so relative imports resolve. finally removes them;
 * after a hard interruption, remove leftover modules before type/import checks.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';

const before = process.argv[2]?.startsWith('--before=') ? process.argv[2].slice('--before='.length) : '4a7a5ba';
if (process.argv.length > 3 || !before || process.argv[2] && !process.argv[2].startsWith('--before='))
  throw new Error('Usage: node tools/compound-delegation-timing.mjs [--before=<commit>]');

const root = new URL('../', import.meta.url);
const nonce = `.timing-${randomUUID()}`;
const temporary = [];
const timed = { before: 0, after: 0 };
const roundMs = value => Number(value.toFixed(3));
const median = values => {
  const ordered = [...values].sort((a, b) => a - b);
  return (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2;
};
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourceAt = (commit, path) => execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8' });
async function temporaryModule(path, name, source) {
  const url = new URL(`../${path.replace(/[^/]+$/, `${nonce}-${name}.ts`)}`, import.meta.url);
  temporary.push(url);
  await writeFile(url, source);
  return url;
}
function replaceExactly(source, from, to, count) {
  if (source.split(from).length !== count + 1) throw new Error(`Expected ${count} imports of ${from}`);
  return source.replaceAll(from, to);
}
const cellsOf = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, i) =>
  ({ x: i % w, y: Math.floor(i / w) })).filter(c => keep(c.x, c.y));
function directBrief(shape, seed) {
  const cells = cellsOf(40, 34, shape === 'concave' ? (x, y) => y < 20 || x < 20 : () => true);
  return { id: `compound-${seed}`, seed, type: 'compound', cellSize: 40, cells,
    zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }], portals: [
      { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
      { id: 'east', axis: 'v', x: 40, y: 8, length: 2 }] };
}
function macroBrief() {
  const cells = cellsOf(200, 150), portals = [];
  for (let x = 2; x < 196; x += 4) portals.push(
    { id: `n${x}`, axis: 'h', x, y: 0, length: 2 },
    { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
  for (let y = 2; y < 146; y += 4) portals.push(
    { id: `w${y}`, axis: 'v', x: 0, y, length: 2 },
    { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
  if (portals.length !== 170) throw new Error('Macro portal fixture changed.');
  return { id: 'macro', seed: 3, type: 'compound', cellSize: 40, cells,
    zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals, parameters: { gates: 4 } };
}

const lock = await acquireMachineLock('bench');
try {
  const currentDelegation = await readFile(new URL('../map/micro/delegation.ts', import.meta.url), 'utf8');
  const executor = await readFile(new URL('../map/micro/delegation-execute.ts', import.meta.url), 'utf8');
  const compound = await readFile(new URL('../map/micro/strategies/compound.ts', import.meta.url), 'utf8');
  const builders = {};
  for (const [name, source] of [['before', sourceAt(before, 'map/micro/delegation.ts')], ['after', currentDelegation]]) {
    const implementation = await temporaryModule('map/micro/delegation.ts', `${name}-preparation`, source);
    const shim = await temporaryModule('map/micro/delegation.ts', `${name}-shim`,
      `import { canonicalDelegationBrief, prepareCanonicalDelegation as prepare } from './${implementation.pathname.split('/').at(-1)}';\n` +
      `import { performance } from 'node:perf_hooks';\n` +
      `export { canonicalDelegationBrief };\n` +
      `export function prepareCanonicalDelegation(...args) { const start = performance.now(); try { return prepare(...args); } finally { globalThis[${JSON.stringify(nonce)}][${JSON.stringify(name)}] += performance.now() - start; } }\n`);
    const execution = await temporaryModule('map/micro/delegation-execute.ts', `${name}-execute`,
      replaceExactly(executor, "'./delegation.ts'", `'./${shim.pathname.split('/').at(-1)}'`, 2));
    const strategy = await temporaryModule('map/micro/strategies/compound.ts', `${name}-compound`,
      replaceExactly(compound, "'../delegation-execute.ts'", `'../${execution.pathname.split('/').at(-1)}'`, 2));
    builders[name] = {
      build: (await import(strategy.href)).buildCompoundGeneration,
      flatten: (await import(execution.href)).flattenDelegationResult,
    };
  }
  globalThis[nonce] = timed;
  const inputs = [
    ...['field', 'concave'].flatMap(shape => Array.from({ length: 20 }, (_, i) => ({ kind: shape, brief: directBrief(shape, i + 1) }))),
    { kind: 'macro', brief: macroBrief() },
  ];
  const rounds = [];
  for (let round = 1; round <= 3; round++) {
    const samples = {};
    const outputs = {};
    for (const name of round % 2 ? ['before', 'after'] : ['after', 'before']) {
      samples[name] = { field: [], concave: [], macro: [] };
      outputs[name] = [];
      for (const { kind, brief } of inputs) {
        const preparationStart = timed[name];
        const start = performance.now();
        const node = builders[name].build(brief);
        const total = performance.now() - start;
        samples[name][kind].push({ total, preparation: timed[name] - preparationStart });
        outputs[name].push(node);
      }
    }
    for (let i = 0; i < inputs.length; i++) {
      if (!isDeepStrictEqual(outputs.before[i], outputs.after[i]))
        throw new Error(`Execution node differs at ${inputs[i].kind} seed ${inputs[i].brief.seed}, round ${round}.`);
      if (!isDeepStrictEqual(builders.before.flatten(outputs.before[i]), builders.after.flatten(outputs.after[i])))
        throw new Error(`Flattened result differs at ${inputs[i].kind} seed ${inputs[i].brief.seed}, round ${round}.`);
    }
    const report = Object.fromEntries(Object.entries(samples).map(([name, groups]) => [name,
      Object.fromEntries(Object.entries(groups).map(([kind, entries]) => [kind, {
        count: entries.length,
        medianBuildMs: roundMs(median(entries.map(e => e.total))),
        medianPreparationMs: roundMs(median(entries.map(e => e.preparation))),
      }]))]));
    rounds.push({ round, ...report });
    console.error(`Completed paired round ${round}/3.`);
  }
  console.log(JSON.stringify({ source: { before, head: git('rev-parse', 'HEAD'),
    dirtyPaths: git('status', '--porcelain', '--untracked-files=no').split(/\r?\n/).filter(Boolean),
    node: process.version }, inputs: { field: 20, concave: 20, macroCells: 30000, macroPortals: 170 },
    rounds, exactNodeAndFlattenedResult: true }, null, 2));
} finally {
  delete globalThis[nonce];
  await Promise.all(temporary.map(url => unlink(url)));
  lock.release();
}
