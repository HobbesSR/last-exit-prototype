/** Reproduce full-owner diagnostics on the maps with actual park geometry drift. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {generate,checkMap} from '../map/tools/core.ts';
import {sweepUnits,unitKey,unitSeed} from '../map/tools/sweep.mts';
const replay=JSON.parse(readFileSync('docs/reports/issue-698/park-replay.json','utf8'));
const baseline=JSON.parse(readFileSync('map/tools/fixtures/chain-baseline.json','utf8'));
const keys=new Set(replay.drift.map(d=>d.map)),records=[];
for(const unit of sweepUnits(baseline.provenance.cases)) {
 if(!keys.has(unitKey(unit)))continue;
 const start=performance.now(),map=generate(unitSeed(unit),unit.params);
 const check=checkMap(map,{diagnose:true});
 records.push({key:unitKey(unit),regions:map.results.length,ms:performance.now()-start,check});
 assert.ok(check.valid,JSON.stringify(records.at(-1)));
 console.error(`Diagnosed ${records.length}/${keys.size}: ${unitKey(unit)}`);
}
assert.equal(records.length,keys.size);
writeFileSync('docs/reports/issue-698/changed-map-diagnostics.json',JSON.stringify({
 scriptSha256:createHash('sha256').update(readFileSync('tools/park-pocket-diagnostics.mjs')).digest('hex'),
 node:process.version,records},null,2)+'\n');
