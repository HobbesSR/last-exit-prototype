// Same generation and validation as the browser lab; custom specs are the future macro seam.
import { readFile, writeFile } from 'node:fs/promises';
import { generateMicroRegion, validateMicroRegion } from '../shared/map/micro/index.ts';
import { microExample } from '../shared/map/micro/examples.ts';
import { composeMicroRegions } from '../shared/map/micro/compose.ts';

const args = new Map();
for (const argument of process.argv.slice(2)) {
  const match = /^--([a-z-]+)=(.+)$/.exec(argument);
  if (!match || !['builder', 'seed', 'shape', 'profile', 'count', 'spec', 'layout', 'validate', 'out', 'batch'].includes(match[1])) throw new Error(`Unknown option ${argument}. Use --builder=depot --seed=42 --shape=rectangle --profile=cell --out=region.json, --builder=entry --count=24, --spec=spec.json, --layout=spec-list.json, --batch=20, or --validate=region.json.`);
  args.set(match[1], match[2]);
}
let output;
if (args.has('validate')) {
  const result = JSON.parse(await readFile(args.get('validate'), 'utf8'));
  const errors = validateMicroRegion(result);
  output = { valid: !errors.length, errors };
  if (errors.length) process.exitCode = 1;
} else if (args.has('layout')) {
  output = composeMicroRegions(JSON.parse(await readFile(args.get('layout'), 'utf8')));
} else {
  const spec = args.has('spec') ? JSON.parse(await readFile(args.get('spec'), 'utf8'))
    : microExample(args.get('builder') ?? 'depot', Number(args.get('seed') ?? 4217), args.get('shape') ?? 'rectangle');
  if (args.has('profile')) spec.bodyProfile = args.get('profile');
  if (args.has('count')) spec.entry = { count: Number(args.get('count')) };
  if (args.has('batch')) {
    const count = Number(args.get('batch'));
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Batch count must be from 1 to 100.');
    const runs = [];
    for (let i = 0; i < count; i++) {
      const seed = spec.seed + i, start = performance.now();
      try { const result = generateMicroRegion({ ...spec, seed }); runs.push({ seed, ms: performance.now() - start, ...result.manifest, valid: true }); }
      catch (error) { runs.push({ seed, valid: false, error: error.message }); process.exitCode = 1; }
    }
    output = { builder: spec.builder, count, valid: runs.every(r => r.valid), emptyBuilders: runs.filter(r => r.valid && r.attempted === r.rejected).map(r => r.seed), runs };
  } else output = generateMicroRegion(spec);
}
const json = JSON.stringify(output, null, 2) + '\n';
if (args.has('out')) await writeFile(args.get('out'), json); else process.stdout.write(json);
