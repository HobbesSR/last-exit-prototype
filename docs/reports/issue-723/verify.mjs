// Repeat/reordered identity, rollback checks are run separately from timing.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const [directory,output] = process.argv.slice(2);
const root=path.resolve(directory,'batch');
const load=f=>import(pathToFileURL(path.join(root,f)));
const corpus=JSON.parse(gunzipSync(fs.readFileSync(path.join(root,'docs/reports/issue-716/frozen-corpus.json.gz'))));
const {buildRegion}=await load('map/micro/region-types.ts');
const {reorderedBrief}=await load('tests/helpers/chain-briefs.js');
const hash=b=>createHash('sha256').update(b).digest('hex');
const body=({elements,loot,coreElements,manifest})=>({elements,loot,coreElements,manifest});
const report={direct:[],parents:[],status:'running'};
fs.writeFileSync(output,JSON.stringify(report),{flag:'wx'});
for(const [label,rows] of [['direct',corpus.rows],['parents',corpus.additionalParentRows]]) {
  for(const row of rows) {
    const expected=row.sha256;
    const results=[buildRegion(structuredClone(row.brief)),buildRegion(reorderedBrief(row.brief,row.brief.seed))];
    const hashes=results.map(r=>hash(JSON.stringify(body(r))));
    if(hashes.some(h=>h!==expected)) throw Error(`Repeat/reordered drift: ${row.seed}/${row.brief.id}`);
    report[label].push({seed:row.seed,id:row.brief.id,expected,hashes});
    fs.writeFileSync(output,JSON.stringify(report,null,2));
  }
  console.log(`${label}: ${rows.length} repeat/reordered exact matches`);
}
report.status='complete';fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
