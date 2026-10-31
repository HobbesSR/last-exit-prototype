// Materialize complete immutable sources; never writes expected corpus/results.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const prototype = '1cb30ff13103ac46532fa855de71ab9ca6266155';
const driver = '2b72f1fb3519df2653ea7768848d1f92764a8cf4';
const root = fs.mkdtempSync(path.resolve('test-results/issue-724-'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, args, cwd = process.cwd()) => execFileSync(command, args, {cwd,stdio:'pipe',windowsHide:true});
for (const name of ['control','batch','driver']) fs.mkdirSync(path.join(root,name));
run('git', ['archive', `--output=${path.join(root,'prototype.tar')}`, prototype]);
run('git', ['archive', `--output=${path.join(root,'driver.tar')}`, driver]);
for (const name of ['control','batch']) run('tar', ['-xf',path.join(root,'prototype.tar'),'-C',path.join(root,name)]);
run('tar', ['-xf',path.join(root,'driver.tar'),'-C',path.join(root,'driver')]);
run(process.execPath, ['docs/reports/issue-723/prepare.mjs',root], path.join(root,'driver'));
const expected = {
  'map/micro/geometry.ts':'b7e2b7b2d65d1d87ba74915d6edff14a6c0f4b7d583ee6548dd969e25b0c01a7',
  'map/micro/strategies/content-access.ts':'252336ef28bbaa8675a8de6c14580a87995bd04c754f9988e99fd88722c86d3b',
};
for (const [file, sha256] of Object.entries(expected)) {
  const from = path.join(root,'batch',file);
  if (hash(from) !== sha256) throw Error(`Control preparation drift: ${file}`);
  fs.copyFileSync(from,path.join(root,'control',file));
}
const corpus = path.join(root,'control/docs/reports/issue-716/frozen-corpus.json.gz');
if (hash(corpus) !== 'b90b15079f1396798217462c7782a08a6d15f527838f5e8dd4f52f2d970ce9bb') throw Error('Frozen corpus drift');
run(process.execPath, ['docs/reports/issue-724/prepare.mjs',root]);
fs.writeFileSync(path.join(root,'setup.json'),JSON.stringify({prototype,driver,control:expected},null,2)+'\n');
console.log(root);
