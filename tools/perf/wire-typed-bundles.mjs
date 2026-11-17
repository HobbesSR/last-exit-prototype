// #1130 field-typed comparison (42.54): the deployable browser bundles for both backends, and their footprint.
// - P: pbjs static code for the native model (encode/decode only; no reflection, no runtime codegen, so a strict
//   content security policy holds) + protobufjs/minimal + the framing in wire-typed-protobuf.mjs.
// - D: the descriptor codec runtime (wire-descriptor-codec.mjs) + its schema for the native model, as data.
// Both are bundled and minified by esbuild (ESM, browser) and gzipped at level 9. The projection <-> native converter
// is shared by both and excluded from both; it is reported separately (wire-typed-schema.mjs, its own bundle).
// Usage: node tools/perf/wire-typed-bundles.mjs --out-dir=DIR  (writes bundles + footprint.json there)
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { gzipSync, constants } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { cliArgs } from '../../tests/helpers/args.js';
import { typedFieldLists } from './wire-typed-fields.mjs';
import { typedModel, nativeModel, descriptorSchema, protoDescriptor } from './wire-typed-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..', '..');
const args = cliArgs();
if (!args.has('out-dir')) throw new Error('--out-dir required');
const out = path.resolve(args.get('out-dir'));
await mkdir(out, { recursive: true });
const posix = p => p.split(path.sep).join('/');

const native = nativeModel(typedModel(typedFieldLists()));
await writeFile(path.join(out, 'state-proto.json'), JSON.stringify(protoDescriptor(native), null, 1));
await writeFile(path.join(out, 'd-schema.json'), JSON.stringify(descriptorSchema(native)));

// Static code: encoders and decoders only (no verify/convert/create/delimited/typeurl helpers), es6 module.
const pbjs = path.join(root, 'node_modules', 'protobufjs-cli', 'bin', 'pbjs');
execFileSync(process.execPath, [pbjs, '-t', 'static-module', '-w', 'es6', '--no-create', '--no-verify', '--no-convert', '--no-delimited',
  '--no-typeurl', '--no-service', '--no-comments', '--no-beautify', '-o', path.join(out, 'state-pb.mjs'), path.join(out, 'state-proto.json')], { stdio: 'inherit' });

await writeFile(path.join(out, 'p-entry.mjs'), `import * as types from './state-pb.mjs';
import { createTypedProtobufCodec } from '${posix(path.join(here, 'wire-typed-protobuf.mjs'))}';
export const createCodec = () => createTypedProtobufCodec(types, { version: ${native.version}, root: '${native.root}', name: 'protobuf-static' });
`);
await writeFile(path.join(out, 'd-entry.mjs'), `import { createDescriptorCodec } from '${posix(path.join(here, 'wire-descriptor-codec.mjs'))}';
import schema from './d-schema.json' with { type: 'json' };
export function createCodec() { const c = createDescriptorCodec(schema, { name: 'descriptor' }); return { name: 'descriptor', encode: n => c.encodeAs('state', n), decode: b => c.decode(b) }; }
`);
await writeFile(path.join(out, 'converter-entry.mjs'), `export { typedModel, nativeModel } from '${posix(path.join(here, 'wire-typed-schema.mjs'))}';\n`);

// protobufjs/minimal always bundles `long` (64-bit integers). This schema has no 64-bit field, so a deployment could
// stub it out: the 'protobuf-static-no-long' row is that best case, an optimization stock protobufjs does not ship.
await writeFile(path.join(out, 'no-long.mjs'), 'export default null;\n');
const footprint = {};
for (const [name, entry, alias] of [['descriptor', 'd-entry.mjs'], ['protobuf-static', 'p-entry.mjs'], ['protobuf-static-no-long', 'p-entry.mjs', { long: path.join(out, 'no-long.mjs') }], ['converter', 'converter-entry.mjs']]) {
  const row = footprint[name] = {};
  for (const minify of [false, true]) {
    const result = await build({ entryPoints: [path.join(out, entry)], bundle: true, minify, format: 'esm', platform: 'browser', target: 'es2022',
      write: false, legalComments: 'none', metafile: true, absWorkingDir: root, ...(alias ? { alias } : {}) });
    const code = result.outputFiles[0].contents, file = `${name}${minify ? '.min' : ''}.mjs`;
    await writeFile(path.join(out, file), code);
    const gz = gzipSync(code, { level: constants.Z_BEST_COMPRESSION }).length;
    row[minify ? 'minified' : 'unminified'] = { file, bytes: code.length, gzipBytes: gz, gzipKiB: +(gz / 1024).toFixed(2),
      inputs: Object.fromEntries(Object.entries(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs).map(([k, v]) => [posix(k).replace(/^.*node_modules\//, 'node_modules/'), v.bytesInOutput])) };
  }
}
const pkg = name => JSON.parse(execFileSync(process.execPath, ['-p', `JSON.stringify(require('${name}/package.json').version)`], { cwd: root, encoding: 'utf8' }));
const report = { generatedAt: new Date().toISOString(), versions: { protobufjs: pkg('protobufjs'), 'protobufjs-cli': pkg('protobufjs-cli'), esbuild: pkg('esbuild') }, footprint,
  staticModuleBytes: (await readFile(path.join(out, 'state-pb.mjs'))).length };
await writeFile(path.join(out, 'footprint.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(footprint).map(([k, v]) => [k, { min: v.minified.gzipKiB, unmin: v.unminified.gzipKiB }]))));
