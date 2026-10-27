// #598: untimed diagnostic counts plus uninstrumented plan timings on the same briefs.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planBlock } from '../map/micro/strategies/block.ts';
import { regionExample } from '../map/micro/region-examples.ts';

const sourcePath = 'map/micro/strategies/block.ts';
const source = await readFile(sourcePath, 'utf8');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const trackedWorktreeDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
const toolSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && (!args[0].startsWith('--out=') || args[0] === '--out=')))
  throw new Error('Usage: node tools/block-fallback-cost.mjs [--out=PATH]');
const baselineCommit = execFileSync('git', ['rev-parse', '872932e^{commit}'], { encoding: 'utf8' }).trim();
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:${sourcePath}`], { encoding: 'utf8' });
const resolveImports = code => code.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
  (_, start, relative, end) => `${start}${pathToFileURL(resolve(dirname(sourcePath), relative)).href}${end}`);
const marker = '      scan: for (const cell of [...mask.cells].sort(compareCells))';
const predicate = 'if (!keepsAlleys(box)) continue;';
if (!source.includes(marker) || !source.includes(predicate)) throw new Error('Fallback instrumentation markers changed; inspect before measuring.');
let diagnostic = source.replace(marker, `    diagnosticCounts = { connectivityChecks: 0, connectivityRejected: 0 };\n    const countedKeepsAlleys = (box: Box) => {\n      diagnosticCounts.connectivityChecks++;\n      const accepted = keepsAlleys(box);\n      if (!accepted) diagnosticCounts.connectivityRejected++;\n      return accepted;\n    };\n${marker}`)
  .replace(predicate, 'if (!countedKeepsAlleys(box)) continue;');
diagnostic = 'export let diagnosticCounts = { connectivityChecks: 0, connectivityRejected: 0 };\n' + diagnostic;
diagnostic = resolveImports(diagnostic);
const root = resolve('test-results');
await mkdir(root, { recursive: true });
const scratch = await mkdtemp(resolve(root, 'fallback-cost-'));
try {
  const file = resolve(scratch, 'diagnostic.ts');
  await writeFile(file, diagnostic);
  const instrumented = await import(pathToFileURL(file).href);
  const baselineFile = resolve(scratch, 'baseline.ts');
  await writeFile(baselineFile, resolveImports(baselineSource));
  const baseline = (await import(pathToFileURL(baselineFile).href)).planBlock;
  const cases = [['neck', 24, 18], ['cross', 18, 48]];
  const rows = [];
  for (const [shape, width, height] of cases) {
    const brief = regionExample({ type: 'block', shape, width, height, seed: 1 });
    const measured = planBlock(brief);
    if (!measured.allocation) throw new Error(`${shape}: no SDK fallback`);
    const observed = instrumented.planBlock(brief);
    if (JSON.stringify(observed) !== JSON.stringify(measured)) throw new Error(`${shape}: instrumented plan differs`);
    if (baseline(brief).lots.length) throw new Error(`${shape}: ordinary planner found a lot`);
    const counts = { ...instrumented.diagnosticCounts };
    const times = { baseline: [], current: [] };
    for (let i = 0; i < 5; i++) {
      const order = i % 2 ? [['current', planBlock], ['baseline', baseline]] : [['baseline', baseline], ['current', planBlock]];
      for (const [name, run] of order) {
        const start = performance.now();
        const plan = run(brief);
        times[name].push(performance.now() - start);
        if (name === 'current' && JSON.stringify(plan) !== JSON.stringify(measured)) throw new Error(`${shape}: unstable plan`);
      }
    }
    rows.push({ shape, width, height, cells: brief.cells.length, counts, pieces: measured.allocation.pieces.length, timesMs: times });
  }
  if (!rows.some(row => row.counts.connectivityRejected > 0)) throw new Error('No fallback witness rejected a disconnected remainder.');
  const report = JSON.stringify({ node: process.version, baselineCommit, head, trackedWorktreeDirty, toolSha256,
    sourceSha256: createHash('sha256').update(source).digest('hex'), rows }, null, 2) + '\n';
  if (args.length) await writeFile(args[0].slice('--out='.length), report, 'utf8');
  else process.stdout.write(report);
} finally { await rm(scratch, { recursive: true, force: true }); }
