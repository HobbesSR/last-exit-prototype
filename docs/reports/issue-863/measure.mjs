import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
for (let pair=1;pair<=3;pair++) for (const variant of ['base','changed']) {
  const prefix=resolve(`test-results/issue863/pair-${pair}-${variant}`);
  const root=resolve(`test-results/issue863/${variant}`);
  const fd=openSync(`${prefix}.log`,'w');
  const result=spawnSync(process.execPath,['tests/bench-stages.mjs','--size=36x18','--content=content-6',
    '--seed=4217','--clients=1',`--maps-cache=${resolve('test-results/issue863/maps.bin')}`,`--out=${prefix}.json`],
    {cwd:root,stdio:['ignore',fd,fd]});
  closeSync(fd);
  if(result.status!==0) throw Error(`${variant} pair ${pair} failed ${result.status}; ${prefix}.log`);
  const data=JSON.parse(readFileSync(`${prefix}.json`));
  console.log(JSON.stringify({pair,variant,tick:data.tick,run:data.run,eliminations:data.raw.series['work.drop.eliminate']?.reduce((a,b)=>a+b,0)}));
}
writeFileSync('test-results/issue863/timing-complete.txt','Three alternating pairs complete\n');
