/** S3 schema migration witness: compare all content and 224 old hashes before accepting new layout fingerprints. Run from repository root. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { generate, CHAIN_LIBRARY } from '../../chain.ts';
import { libraryFingerprint } from '../../macro/src/coding.ts';
import { viewHashes } from '../sweep.mts';
const base='3fe884f';
const oldLibrary=JSON.parse(execFileSync('git',['show',`${base}:map/macro/content/chain-library.json`],{encoding:'utf8'}));
const {name,zonePlan,zoneWidth,zoneHeight, ...content}=CHAIN_LIBRARY;
assert.deepEqual({...content,version:2},oldLibrary);
const oldFingerprint=libraryFingerprint(oldLibrary);
const baseline=JSON.parse(execFileSync('git',['show',`${base}:map/tools/fixtures/chain-baseline.json`],{encoding:'utf8'}));
const entries={};let count=0;
for(const c of baseline.provenance.cases) for(let i=1;i<=c.count;i++) {
 const seed=`${c.seedPrefix}-${i}`,key=`${c.id}/${seed}`;
 const map=generate(seed,c.params);
 const current=viewHashes(map);
 const normalized=viewHashes({...map,layout:{...map.layout,library:oldFingerprint}});
 assert.deepEqual(normalized,baseline.entries[key],key);
 for(const view of Object.keys(current)) if(view!=='layout') assert.equal(current[view],baseline.entries[key][view],`${key}/${view}`);
 entries[key]=current;
 if(++count%20===0) console.log(`Verified ${count} maps`);
}
mkdirSync('test-results', {recursive:true});
writeFileSync('test-results/s3-audited-entries.json',JSON.stringify(entries,null,2)+'\n');
console.log(JSON.stringify({verified:count,oldFingerprint,newFingerprint:libraryFingerprint(CHAIN_LIBRARY),contentUnchanged:true}));
