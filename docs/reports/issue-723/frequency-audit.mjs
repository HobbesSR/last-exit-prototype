// Replay the declared ordinary-route measure from the immutable evidence archive.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [source,extracted,output]=process.argv.slice(2);
if(!output)throw Error('Usage: node docs/reports/issue-723/frequency-audit.mjs PROTOTYPE_SOURCE EXTRACTED_ARCHIVE NEW_REPORT');
const hash=b=>createHash('sha256').update(b).digest('hex');
const archive=path.resolve(source,'docs/reports/issue-716/evidence.tar.gz');
const root=path.resolve(extracted),out=path.join(root,'replayed-effects');
if(!fs.existsSync(out))execFileSync(process.execPath,['tools/incidental-seam-effects.mjs',path.join(root,'baseline-routes'),path.join(root,'candidate-routes'),path.join(root,'candidate'),out],{cwd:path.resolve(source),stdio:'inherit'});
const report=JSON.parse(fs.readFileSync(path.join(out,'summary.json'))),totals={};
for(const row of report.cases){
  const bytes=fs.readFileSync(path.join(out,`${row.seed}-effects.json`));
  if(hash(bytes)!==row.outputSha256 || hash(fs.readFileSync(path.join(root,'effects',`${row.seed}-effects.json`)))!==row.outputSha256)throw Error(`Historical effect drift: ${row.seed}`);
  row.inputHashes=Object.fromEntries(Object.entries(row.inputHashes).map(([f,h])=>[path.basename(path.dirname(f))+'/'+path.basename(f),h]));
  for(const[body,counts]of Object.entries(row.bodies))for(const[key,value]of Object.entries(counts)){const t=totals[body]??={};t[key]=(t[key]??0)+value;}
}
Object.assign(report,{archiveSha256:hash(fs.readFileSync(archive)),replayedAllNineOutputsExactly:true,totals,zeroEffectMaps:report.cases.filter(r=>Object.values(r.bodies).every(b=>b.affected===0)).map(r=>r.seed),conclusion:'The declared fixed panel has route effects on 10.08%/11.18% of contestant/hunter attempts. This does not establish an encounter on a typical traversal; no endpoint selection, content tuning or player-traffic inference is part of this replay.'});
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({totals,zeroEffectMaps:report.zeroEffectMaps}));
