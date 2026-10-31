// Isolated full-builder comparison on immutable #716 inputs. Run from repo root.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { acquireMachineLock } from '../../../tests/helpers/machine-lock.js';
const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw Error('Usage: node docs/reports/issue-723/compare.mjs SNAPSHOTS OUTPUT');
const hash = b => createHash('sha256').update(b).digest('hex');
const corpusBytes = fs.readFileSync(path.join(directory,'control/docs/reports/issue-716/frozen-corpus.json.gz'));
const corpus = JSON.parse(gunzipSync(corpusBytes));
const content = ({elements,loot,coreElements,manifest}) => ({elements,loot,coreElements,manifest});
const sourcePins = {};
const builders = {};
for (const name of ['control','batch']) {
  const root = path.resolve(directory,name);
  sourcePins[name] = Object.fromEntries(['map/micro/geometry.ts','map/micro/strategies/content-access.ts'].map(f=>[f,hash(fs.readFileSync(path.join(root,f)))]));
  builders[name] = {};
  for (const type of ['depot','market']) builders[name][type] = (await import(pathToFileURL(path.join(root,`map/micro/strategies/${type}.ts`))))[type==='depot'?'buildDepot':'buildMarket'];
}
fs.writeFileSync(output,'',{flag:'wx'});
const report = {scope:'121 frozen direct builders; same prototype source except shared-origin search implementation and guard adapter. Excludes macro/composition.',node:process.version,corpusSha256:hash(corpusBytes),sourcePins,repeats:[]};
const lock = await acquireMachineLock('bench',{timeoutMs:1000,pollMs:100});
try {
  for (let repetition=0;repetition<3;repetition++) {
    const pair = {};
    // Alternate ordering to reduce systematic warmup/order bias.
    for (const name of repetition%2?['batch','control']:['control','batch']) {
      const groups={}, outputs=[], started=performance.now();
      for (const row of corpus.rows) {
        const tick=performance.now(), result=builders[name][row.brief.type](structuredClone(row.brief));
        const ms=performance.now()-tick, actual=hash(JSON.stringify(content(result)));
        if(actual!==row.sha256) throw Error(`Frozen output drift: ${name} ${row.seed}/${row.brief.id}`);
        const key=`${row.brief.type}/${row.seed.split('-')[1]}`, group=groups[key]??={count:0,ms:0}; group.count++;group.ms+=ms;
        outputs.push(actual);
      }
      pair[name]={ms:performance.now()-started,groups,outputSha256:hash(JSON.stringify(outputs)),checked:outputs.length};
      console.log(JSON.stringify({repetition:repetition+1,name,...pair[name]}));
    }
    report.repeats.push(pair);
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  }
  const median = xs=>xs.sort((a,b)=>a-b)[1];
  report.medians=Object.fromEntries(['control','batch'].map(n=>[n,median(report.repeats.map(p=>p[n].ms))]));
  report.speedup=report.medians.control/report.medians.batch;
  report.status='complete';
} finally {lock.release();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
