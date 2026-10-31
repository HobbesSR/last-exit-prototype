// Independently validate final frozen block-parent geometry, without recapture.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const [directory,output] = process.argv.slice(2);
const root=path.resolve(directory,'batch');
const {validateRegion}=await import(pathToFileURL(path.join(root,'tools/incidental-seam-validate.mjs')));
const bytes=fs.readFileSync(path.join(root,'docs/reports/issue-716/frozen-corpus.json.gz'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const rows=JSON.parse(gunzipSync(bytes)).additionalParentRows;
const report={corpusSha256:hash(bytes),status:'running',regions:[]};
fs.writeFileSync(output,gzipSync(JSON.stringify(report)),{flag:'wx'});
for(const row of rows) {
  if(hash(JSON.stringify(row.expected))!==row.sha256)throw Error('Corrupt expected result');
  const result=validateRegion({brief:row.brief,...row.expected});
  report.regions.push({seed:row.seed,...result});
  fs.writeFileSync(output,gzipSync(JSON.stringify(report)));
  console.log(JSON.stringify({seed:row.seed,id:row.brief.id,fillErrors:result.fillErrors.length,portal:result.portal.valid,loot:result.loot.map(r=>({role:r.role,counts:r.targets.reduce((a,t)=>(a[t.status]=(a[t.status]??0)+1,a),{})}))}));
}
report.status='complete';fs.writeFileSync(output,gzipSync(JSON.stringify(report)));
