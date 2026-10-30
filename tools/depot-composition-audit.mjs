// Replay the bounded #533 workloads and diagnose final geometry independently of admission.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {buildDepot} from '../map/micro/strategies/depot.ts';
import {createAccessMask,elementShapes,findRegionRoute,shapesShareArea} from '../map/micro/geometry.ts';
import {microMetrics} from '../map/micro/metrics.ts';
import {hunterClearance,portalStands,validatePortalReach} from '../map/micro/portals.ts';
import {validateFillConstraints} from '../map/micro/margins.ts';
import {measureFill} from '../map/micro/fill.ts';
import {rect} from '../shared/shape.ts';
const baselinePath='docs/reports/issue-533/baseline.json.gz';
const output=process.argv[2] ?? 'docs/reports/issue-533/comparison.json.gz';
const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const paths=git('ls-files','--cached','--others','--exclude-standard','map/micro','map/kernel','shared').split(/\r?\n/).filter(p=>p.endsWith('.ts'));
const hashes=async()=>Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(p))])));
// Normalize CRLF only; preserve all other whitespace and final-newline differences.
const normalizedHash=async p=>hash((await readFile(p,'utf8')).replaceAll('\r\n','\n'));
const normalizedHashes=async()=>Object.fromEntries(await Promise.all(paths.map(async p=>[p,await normalizedHash(p)])));
const auditPath='tools/depot-composition-audit.mjs';
const base=JSON.parse(gunzipSync(await readFile(baselinePath)));
const archived=JSON.parse(gunzipSync(await readFile('docs/reports/issue-663/results.json.gz')));
const only=process.argv[3];
if (process.argv[2] === '--verify') {
  const verification=JSON.parse(await readFile('docs/reports/issue-533/final-source-verification.json','utf8'));
  const comparisonBytes=await readFile('docs/reports/issue-533/comparison.json.gz');
  const report=JSON.parse(gunzipSync(comparisonBytes));
  assert.equal(hash(await readFile(baselinePath)),verification.baselineSha256,'Baseline hash mismatch');
  assert.equal(hash(comparisonBytes),verification.comparisonSha256,'Comparison hash mismatch');
  assert.equal(report.baselineHash,verification.baselineSha256,'Comparison baseline mismatch');
  assert.equal(await normalizedHash(auditPath),verification.finalAuditNormalizedSha256,'Audit tool hash mismatch');
  const before=await normalizedHashes();
  assert.deepEqual(before,verification.finalNormalizedSourceHashes,'Final source inventory mismatch');
  assert.equal(base.rows.length,14,'Expected 14 baseline workloads');
  assert.equal(report.rows.length,14,'Expected 14 comparison workloads');
  assert.deepEqual(verification.verifiedOutputs,report.rows.map(r=>({name:r.name,hash:r.current.outputHash})),'Recorded output inventory mismatch');
  assert.equal(new Set(report.rows.map(r=>r.name)).size,14,'Duplicate comparison workload');
  for(const row of report.rows) {
    const input=base.rows.find(b=>b.name===row.name); assert.ok(input,`Missing input ${row.name}`);
    assert.equal(hash(input.brief),row.briefHash,`Brief drift: ${row.name}`);
    assert.equal(hash(buildDepot(input.brief)),row.current.outputHash,`Output drift: ${row.name}`);
  }
  assert.deepEqual(await normalizedHashes(),before,'Source changed during verification');
  assert.equal(await normalizedHash(auditPath),verification.finalAuditNormalizedSha256,'Audit tool changed during verification');
  console.log('Verified 14 production outputs, final normalized sources, audit tool, and retained artifacts'); process.exit(0);
}
if (process.argv[2] === '--rebind') {
  const reportPath='docs/reports/issue-533/comparison.json.gz';
  const bytes=await readFile(reportPath), report=JSON.parse(gunzipSync(bytes));
  assert.equal(report.baselineHash,hash(await readFile(baselinePath)),'Baseline changed');
  const before=await hashes();
  const changes=Object.keys({...report.sourceHashes,...before}).filter(p=>report.sourceHashes[p]!==before[p]);
  const allowed=['map/micro/strategies/depot.ts','map/micro/region-types.ts'];
  assert.ok(changes.every(p=>allowed.includes(p)),`Unexpected changed sources: ${changes}`);
  for(const row of report.rows) {
    const input=base.rows.find(b=>b.name===row.name); assert.ok(input,`Missing input ${row.name}`);
    assert.equal(hash(input.brief),row.briefHash,`Brief drift: ${row.name}`);
    assert.equal(hash(buildDepot(input.brief)),row.current.outputHash,`Output drift: ${row.name}`);
  }
  assert.equal(report.rows.length,base.rows.length,'Incomplete output verification');
  assert.deepEqual(await hashes(),before,'Source changed during rebind');
  await writeFile('docs/reports/issue-533/final-source-verification.json',JSON.stringify({comparisonSha256:hash(bytes),baselineSha256:report.baselineHash,diagnosticSourceHashes:report.sourceHashes,finalSourceHashes:before,finalNormalizedSourceHashes:await normalizedHashes(),finalAuditNormalizedSha256:await normalizedHash(auditPath),changedSources:changes,verifiedOutputs:report.rows.map(r=>({name:r.name,hash:r.current.outputHash})),auditSha256:hash(await readFile('tools/depot-composition-audit.mjs')),node:process.version,trackedDirty:git('status','--porcelain','--untracked-files=no'),note:'All full production results rebuilt identically; retained geometry diagnostics were not rerun. During diagnostic capture the audit script gained only the separate visual rendering branch; diagnostic code did not change.'},null,2)+'\n');
  console.log(`Verified ${report.rows.length} final outputs; changed sources: ${changes.join(', ')||'none'}`); process.exit(0);
}
if (process.argv[2] === '--visual') {
  const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  function svg(b,r) {
    const size=b.cellSize,xs=b.cells.map(c=>c.x),ys=b.cells.map(c=>c.y),x=Math.min(...xs)*size,y=Math.min(...ys)*size;
    let out=`<svg viewBox="${x-size} ${y-size} ${(Math.max(...xs)+1)*size-x+2*size} ${(Math.max(...ys)+1)*size-y+2*size}">`;
    for(const c of b.cells) out+=`<rect x="${c.x*size}" y="${c.y*size}" width="${size}" height="${size}" fill="#ece8da" stroke="#ccc"/>`;
    for(const e of r.elements) {
      out+=`<rect x="${e.x}" y="${e.y}" width="${e.template.w}" height="${e.template.h}" fill="${e.label.startsWith('depot-warehouse')?'#a8bbd1':'#91b391'}" opacity=".7"/>`;
      for(const sh of elementShapes(e,true)) {
        if(sh.kind==='rect') out+=`<rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" fill="#343b40"/>`;
        else if(sh.kind==='circle') out+=`<circle cx="${sh.x}" cy="${sh.y}" r="${sh.r}" fill="#343b40"/>`;
        else out+=`<polygon points="${sh.points.map(p=>`${p.x+sh.x},${p.y+sh.y}`).join(' ')}" fill="#343b40"/>`;
      }
    }
    for(const p of b.portals) out+=`<line x1="${p.x*size}" y1="${p.y*size}" x2="${(p.x+(p.axis==='h'?p.length:0))*size}" y2="${(p.y+(p.axis==='v'?p.length:0))*size}" stroke="#bc1d89" stroke-width="8"/>`;
    return out+'</svg>';
  }
  const before=await hashes(), rows=base.rows.slice(0,12).map(row=>({row,current:buildDepot(row.brief)}));
  assert.deepEqual(await hashes(),before,'Source changed during visual capture; rerun');
  const doc=`<!doctype html><meta charset="utf-8"><title>Depot composition #533</title><style>body{font:15px system-ui;margin:24px;background:#f7f6f2;color:#252d31}section{border-top:1px solid #999;padding:16px 0}.pair{display:flex;gap:16px}figure{margin:0;flex:1;min-width:0}svg{width:100%;max-height:520px}figcaption{font-weight:600}</style><h1>Depot composition #533</h1><p>Baseline and current production. Warehouse envelopes blue, container/crate envelopes green, collision dark, portal seams magenta. These are geometry previews rather than roof or art renders. See comparison.json.gz for independent access checks.</p>${rows.map(({row,current})=>`<section><h2>${esc(row.name)}</h2><div class="pair">${[['Before',row.result],['After',current]].map(([name,r])=>`<figure><figcaption>${name}: ${r.manifest.warehouses} warehouses, ${r.manifest.rows} rows, ${r.manifest.infillCrates} crates, ${r.manifest.loot} loot</figcaption>${svg(row.brief,r)}</figure>`).join('')}</div></section>`).join('')}`;
  await writeFile('docs/reports/issue-533/index.html.gz',gzipSync(doc));
  await writeFile('test-results/533-depot-composition.html',doc);
  console.log(`Rendered ${rows.length} authored pairs`); process.exit(0);
}
const before=await hashes();
function diagnose({brief:b,result:r,traces}) {
  const blockers=r.elements.flatMap(e=>elementShapes(e));
  const closed=r.elements.flatMap(e=>elementShapes(e,true));
  const mask=createAccessMask(b), stands=portalStands(b).flatMap(s=>s.points);
  const errors=[...validateFillConstraints(b,closed),...validatePortalReach({...b,blockers},{search:'thorough'}).errors];
  const doorsteps=[],rooms=[];
  for(const e of r.elements.filter(e=>e.label.startsWith('depot-warehouse'))) {
    const trace=traces.find(t=>t.label===e.label);
    assert.ok(trace,`Missing warehouse trace ${e.label}`);
    for(const door of trace.realization.openings.filter(o=>o.kind==='door'&&(o.a==='outside'||o.b==='outside'))) {
      const {run,center}=door, horizontal=run.axis==='h', start=(horizontal?run.x:run.y)+center-1;
      for(const along of new Set([Math.floor(start),Math.ceil(start)])) {
        const point=horizontal?{x:e.x+(along+1)*b.cellSize,y:e.y+(run.y===0?-1:e.template.h/b.cellSize+1)*b.cellSize}
          :{x:e.x+(run.x===0?-1:e.template.w/b.cellSize+1)*b.cellSize,y:e.y+(along+1)*b.cellSize};
        const square=rect(point.x-b.cellSize,point.y-b.cellSize,2*b.cellSize,2*b.cellSize);
        const near=[...stands].sort((a,c)=>Math.hypot(a.x-point.x,a.y-point.y)-Math.hypot(c.x-point.x,c.y-point.y))[0];
        doorsteps.push({label:e.label,point,contained:mask.contains(square),clear:!closed.some(s=>shapesShareArea(s,square)),reached:near?!!findRegionRoute(mask,blockers,near,point,hunterClearance(b.cellSize)):null});
      }
    }
    const outside=doorsteps.find(d=>d.label===e.label)?.point;
    for(const space of trace.allocation.spaces) rooms.push({label:e.label,space:space.id,reached:!!outside&&space.cells.some(c=>findRegionRoute(mask,blockers,outside,{x:e.x+(c.x+.5)*b.cellSize,y:e.y+(c.y+.5)*b.cellSize},microMetrics({cellSize:b.cellSize,bodyProfile:'cell'}).clearance.contestant))});
  }
  const warehouses=r.elements.filter(e=>e.label.startsWith('depot-warehouse'));
  return {outputHash:hash(r),manifest:r.manifest,warehouseEnvelopeCells:warehouses.reduce((n,e)=>n+e.template.w*e.template.h/b.cellSize**2,0),roofCells:warehouses.reduce((n,e)=>n+(e.template.roofs??[]).reduce((m,roof)=>m+roof.cells.length,0),0),fill:measureFill(b,r.elements),errors,doorsteps,rooms};
}
const rows=[];
for(const row of base.rows.filter(r=>!only||r.name.includes(only))) {
  console.log(`Audit ${row.name}`);
  const traces=[],result=buildDepot(row.brief,t=>traces.push(t));
  const historical=archived.rows.find(r=>r.name===row.name)?.builds.production;
  let baseline;
  if(historical) {
    assert.equal(hash(row.result),historical.outputHash,`Historical output drift: ${row.name}`);
    const warehouses=row.result.elements.filter(e=>e.label.startsWith('depot-warehouse'));
    baseline={outputHash:historical.outputHash,manifest:row.result.manifest,warehouseEnvelopeCells:warehouses.reduce((n,e)=>n+e.template.w*e.template.h/row.brief.cellSize**2,0),roofCells:warehouses.reduce((n,e)=>n+(e.template.roofs??[]).reduce((m,roof)=>m+roof.cells.length,0),0),fill:historical.fill,errors:historical.errors,doorsteps:historical.doorsteps,rooms:historical.rooms};
  } else baseline=diagnose(row);
  const current=hash(result)===hash(row.result)?baseline:diagnose({brief:row.brief,result,traces});
  rows.push({name:row.name,briefHash:hash(row.brief),baseline,current,result,traces});
}
assert.deepEqual(await hashes(),before,'Source changed during audit; rerun');
await writeFile(output,gzipSync(JSON.stringify({audit:'depot-composition-1',createdAt:new Date().toISOString(),baselineHash:hash(await readFile(baselinePath)),baselineCommit:base.commit,currentCommit:git('rev-parse','HEAD'),trackedDirty:git('status','--porcelain','--untracked-files=no'),sourceHashes:before,auditSha256:hash(await readFile('tools/depot-composition-audit.mjs')),node:process.version,rows,limitations:'Twelve authored depots from one map per size, plus no-fit and zero-density cases. Doorstep reach uses nearest portal and room reach uses first exterior stand; failures are diagnostic, not exhaustive impossibility proofs.'})));
console.log(`Saved ${rows.length} workloads to ${output}`);
