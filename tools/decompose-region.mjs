import { readFile, writeFile } from 'node:fs/promises';
import { decompositionExample, planExample } from '../shared/map/micro/decomposition/example.ts';
import { validateDecompositionPlan } from '../shared/map/micro/decomposition/validate.ts';

const args = new Map();
for (const argument of process.argv.slice(2)) {
  const match = /^--([a-z-]+)=(.+)$/.exec(argument);
  if (!match || !['shape', 'spec', 'beam', 'residual-penalty', 'piece-penalty', 'validate', 'out'].includes(match[1]) || args.has(match[1])) throw new Error(`Invalid option ${argument}. Use --shape=neck --beam=8 --out=plan.json, --spec=context.json, or --validate=plan.json.`);
  args.set(match[1], match[2]);
}
if (args.has('validate') && [...args.keys()].some(k => !['validate', 'out'].includes(k))) throw new Error('Validation cannot be combined with generation options.');
if (args.has('spec') && args.has('shape')) throw new Error('Choose a custom context or an example shape.');
let output;
if (args.has('validate')) {
  const errors = validateDecompositionPlan(JSON.parse(await readFile(args.get('validate'), 'utf8')));
  output = { valid: !errors.length, errors, scope: 'ownership, interfaces and score accounting; generator utility requires its registry' };
  if (errors.length) process.exitCode = 1;
} else {
  const input = args.has('spec') ? JSON.parse(await readFile(args.get('spec'), 'utf8')) : decompositionExample(args.get('shape') ?? 'neck');
  output = planExample(input, {
    ...(args.has('beam') ? { beamWidth: Number(args.get('beam')) } : {}),
    ...(args.has('residual-penalty') ? { residualComponentPenalty: Number(args.get('residual-penalty')) } : {}),
    ...(args.has('piece-penalty') ? { piecePenalty: Number(args.get('piece-penalty')) } : {}),
  });
}
const json = JSON.stringify(output, null, 2) + '\n';
if (args.has('out')) await writeFile(args.get('out'), json); else process.stdout.write(json);
