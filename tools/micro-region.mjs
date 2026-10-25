// Same briefs, region types and portal check as the browser micro lab.
import { readFile, writeFile } from 'node:fs/promises';
import { buildRegion } from '../map/micro/region-types.ts';
import { regionExample } from '../map/micro/region-examples.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['type', 'seed', 'shape', 'width', 'height', 'brief', 'validate', 'out', 'batch'], argument => `Unknown option ${argument}. Use --type=depot --seed=42 --shape=rectangle --width=24 --height=18 --out=region.json, --brief=brief.json, --batch=20, or --validate=region.json.`);
/** The region's own portal promise, checked from its emitted geometry (elective, 51 principle 9). */
const portalErrors = region => validatePortalReach({ ...region.brief, blockers: region.elements.flatMap(e => elementShapes(e)) }).errors;
let output;
if (args.has('validate')) {
  const errors = portalErrors(JSON.parse(await readFile(args.get('validate'), 'utf8')));
  output = { valid: !errors.length, errors };
  if (errors.length) process.exitCode = 1;
} else {
  const number = name => args.has(name) ? { [name]: Number(args.get(name)) } : {};
  const brief = args.has('brief') ? JSON.parse(await readFile(args.get('brief'), 'utf8'))
    : regionExample({ type: args.get('type') ?? 'depot', seed: 4217, ...number('seed'), shape: args.get('shape') ?? 'rectangle', ...number('width'), ...number('height') });
  if (args.has('batch')) {
    const count = Number(args.get('batch'));
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Batch count must be from 1 to 100.');
    const runs = [];
    for (let i = 0; i < count; i++) {
      const seed = brief.seed + i, start = performance.now();
      try {
        const region = buildRegion({ ...brief, seed }), ms = performance.now() - start, errors = portalErrors(region);
        runs.push({ seed, ms, ...region.manifest, valid: !errors.length, ...(errors.length ? { errors } : {}) });
      } catch (error) { runs.push({ seed, valid: false, errors: [error.message] }); }
      if (!runs.at(-1).valid) process.exitCode = 1;
    }
    output = { type: brief.type, count, valid: runs.every(r => r.valid), runs };
  } else output = buildRegion(brief);
}
const json = JSON.stringify(output, null, 2) + '\n';
if (args.has('out')) await writeFile(args.get('out'), json); else process.stdout.write(json);
