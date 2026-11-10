import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const [root, variant] = process.argv.slice(2);
if (!root || !['base','changed'].includes(variant)) throw Error('root base|changed');
if (variant === 'changed') for (const file of ['ground-items.ts','loot.ts','world-physics.ts'])
  await copyFile(`shared/simulation/${file}`, `${root}/shared/simulation/${file}`);
for (const [file, name, timer] of [
  ['loot.ts','scatterPoint','scatter'], ['world-physics.ts','synchronizePhysicalItems','sync'], ['lifecycle.ts','eliminate','eliminate']
]) {
  const path = `${root}/shared/simulation/${file}`;
  let source = (variant === 'changed' ? await readFile(`shared/simulation/${file}`,'utf8')
    : execFileSync('git',['show',`6943fa1:shared/simulation/${file}`],{encoding:'utf8'})).replaceAll('\r\n','\n');
  const at = source.indexOf(`export function ${name}(`), open = source.indexOf('{\n',at), end = source.indexOf('\n}',open);
  if (at<0 || open<0 || end<0) throw Error(`missing ${name}`);
  source = source.slice(0,open+2) + `  dropProfiler.start('drop.${timer}'); dropProfiler.count('work.drop.${timer}'); try {\n`
    + source.slice(open+2,end) + `\n  } finally { dropProfiler.stop('drop.${timer}'); }` + source.slice(end);
  await writeFile(path, `import * as dropProfiler from '../profiler.ts';\n`+source);
}
console.log(`Instrumented ${variant}: ${resolve(root)}`);
