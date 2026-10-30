#!/usr/bin/env node
/** Source-bound, opt-in #705 experiment. Never imported by production generation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { cpus } from 'node:os';
import { readMap, checkMap } from '../map/tools/core.ts';
import { chainMapToJson, decodeChainMap } from '../map/macro/src/chain/saving.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { validateLibrary } from '../map/macro/src/chain/library.ts';
import { layoutViolations } from '../map/macro/src/chain/declared-grid.ts';
import { portalViolations } from '../map/macro/src/chain/regions.ts';
import { proofViolations } from '../map/macro/src/chain/proof.ts';
import { GAME_REGION_TYPES } from '../map/engines.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { builtMapFrame } from '../map/micro/adapter.ts';
import { elementShapes, createAccessMask, findRegionRoute } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { measureNavigationStructure, summarizeRoutes } from '../map/tools/navigation-structure.ts';
import { measurePocketRoutes } from './experiments/park-pocket-routes.mjs';
import { experimentCurtain } from './experiments/macro-curtain.mjs';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';

const args = process.argv.slice(2), verify = args.includes('--verify');
if (args.some(a => a !== '--verify' && !a.startsWith('--out=') && !a.startsWith('--sizes='))) throw Error('Use --out=DIR [--sizes=12,24,36] [--verify]');
const dir = args.find(a => a.startsWith('--out='))?.slice(6) ?? 'test-results/macro-boundary';
const sizes = (args.find(a => a.startsWith('--sizes='))?.slice(8) ?? '12,24,36').split(',').map(Number);
assert.ok(sizes.length && sizes.every(w => [12,24,36].includes(w)));
if (!verify && existsSync(`${dir}/manifest.json`)) throw Error('Choose a fresh output directory');
const hash = v => createHash('sha256').update(v).digest('hex');
const git = (...a) => execFileSync('git', a, { encoding:'utf8', maxBuffer:20*1024*1024 }).trim();
const sources = [...new Set([...git('ls-files','map','shared','package-lock.json').split('\n').filter(f => /\.(ts|mts|json)$/.test(f) && !f.includes('/fixtures/')),
  'tools/macro-boundary-experiment.mjs','tools/experiments/macro-curtain.mjs','tools/experiments/park-pocket-routes.mjs','tests/helpers/machine-lock.js'])].sort();
const sourceHashes = Object.fromEntries(sources.map(f => [f,hash(readFileSync(f,'utf8').replaceAll('\r\n','\n'))]));
const retained = verify ? JSON.parse(readFileSync(`${dir}/manifest.json`)) : null;
if (retained) assert.deepEqual(sourceHashes,retained.sourceHashes,'source pins');
mkdirSync(dir,{recursive:true});
const pinText = readFileSync('docs/reports/issue-688/manifest.json','utf8').replaceAll('\r\n','\n');
assert.equal(hash(pinText),'324738422d4a267980f731247a38241a76e7a1f1a31b131bd7fc419f271583a3','immutable #688 manifest');
const pins = JSON.parse(pinText);
const summary = [], preview = [], timings = [], reports = [];
const timed = (label,fn) => { const start=performance.now(),value=fn();timings.push({label,ms:performance.now()-start});return value; };
const summarize = samples => Object.fromEntries([...new Set(samples.map(s=>`${s.category}/${s.stratum}`))].sort().map(k=>[k,summarizeRoutes(samples.filter(s=>`${s.category}/${s.stratum}`===k))]));
const world = (p,o) => ({x:p.x+o.x,y:p.y+o.y});
const same = (a,b) => a.x===b.x && a.y===b.y;
const aggregate = metrics => ({regions:metrics.regions,portals:metrics.portals,onePortalShare:metrics.onePortalShare,roles:metrics.roles.map(r=>{
  const sum = k=>r.regions.reduce((n,a)=>n+a[k],0);
  return {body:r.body,components:r.components,walkableArea:r.walkableArea,deadEndArea:r.deadEndArea,
    perimeter:sum('perimeter'),guaranteedPassableBoundary:sum('guaranteedPassableBoundary'),boundarySamples:sum('boundarySamples'),blockedBoundarySamples:sum('blockedBoundarySamples'),
    walkableSamples:sum('walkableSamples'),emptySamples:sum('emptySamples'),emptyAreaEstimate:sum('emptyAreaEstimate')};
})});
const {release} = await acquireMachineLock('bench');
try {
  for (const width of sizes) {
    console.error(`Macro curtain: ${width}`);
    const pin=pins.maps.find(m=>m.seed===`size-${width}-1`), bytes=gunzipSync(readFileSync(pin.mapFile)), metricBytes=gunzipSync(readFileSync(pin.metricsFile));
    assert.equal(hash(bytes),pin.mapSha256);assert.equal(hash(metricBytes),pin.metricsSha256);
    const before=readMap(JSON.parse(bytes)), original=chainMapToJson(before), beforeMetrics=JSON.parse(metricBytes);
    const intervention=timed(`${width}/plan-and-changed-brief-build`,()=>experimentCurtain(before));
    assert.ok(intervention.map,JSON.stringify(intervention));
    const {map:after,policy}=intervention;
    const v=mapViews(after),b=mapViews(before).resolved;
    assert.deepEqual(v.resolved.cells.map(Boolean),b.cells.map(Boolean),'unchanged playable mask');
    for(let i=0;i<b.cells.length;i++) if(i%b.width<policy.x || i%b.width>=policy.x+4) assert.equal(v.resolved.cells[i],b.cells[i],'unchanged outside classes');
    assert.deepEqual(decodeChainMap(JSON.parse(chainMapToJson(after))),after,'complete saved map rederives exact briefs');
    const originalIds=new Set(before.results.map(r=>r.brief.id));
    const reused=new Set(intervention.reusedIds), affectedBefore=before.results.filter(r=>!reused.has(r.brief.id)), changedAfter=after.results.filter(r=>!reused.has(r.brief.id));
    assert.equal(chainMapToJson(before),original,'input mutation');
    assert.deepEqual(builtMapFrame(composeRegions(before.results)),builtMapFrame(composeRegions(after.results)),'fixed world frame');
    const reordered=structuredClone(before);reordered.layout.slots.reverse();reordered.layout.setPieces.reverse();reordered.library.tiles.reverse();reordered.library.tileSets.reverse();reordered.library.setPieces.reverse();reordered.results.reverse();
    const again=timed(`${width}/reordered-plan-and-build`,()=>experimentCurtain(reordered));
    assert.equal(chainMapToJson(again.map),chainMapToJson(after),'reordered inputs deterministic');
    const stageErrors={library:validateLibrary(after.library,new Set([...GAME_REGION_TYPES,'experiment-curtain'])).errors,
      layout:layoutViolations(v.declaredGrid),portals:portalViolations(v.regions),proof:proofViolations(v.proof,v.regions,after.library)};
    const checks={before:checkMap(before),after:checkMap(after),stageErrors};
    const stagesValid=Object.values(stageErrors).every(a=>!a.length);
    const validations=timed(`${width}/final-changed-owner-proofs`,()=>changedAfter.map(r=>{
      const blockers=r.elements.flatMap(e=>elementShapes(e)),placed=r.elements.flatMap(e=>elementShapes(e,true));
      const fillErrors=validateFillConstraints(r.brief,placed), reach=validatePortalReach({...r.brief,blockers},{search:'thorough'});
      const root=portalStands(r.brief).flatMap(p=>p.points)[0];
      const core=r.coreElements.map(p=>({kind:p.kind,point:p,route:root?findRegionRoute(createAccessMask(r.brief),blockers,root,p,hunterClearance(r.brief.cellSize)):null}));
      return {id:r.brief.id,type:r.brief.type,fillErrors,portalErrors:reach.errors,joins:reach.joins,meshBuilds:reach.meshBuilds,core,valid:!fillErrors.length&&reach.valid&&core.every(c=>c.route)};
    }));
    const origin=builtMapFrame(composeRegions(before.results)).origin,s=before.cellSize;
    const site=policy; // Coordinates fixed by the declared candidate, never by resulting walkability.
    const focus=[.15,.5,.85].map(f=>({category:'curtain-crossing',from:world({x:(site.x-3)*s,y:(site.y0+(site.y1-site.y0+1)*f)*s},origin),to:world({x:(site.x+7)*s,y:(site.y0+(site.y1-site.y0+1)*f)*s},origin)}));
    focus.push({category:'gate-control',from:world({x:(site.x-3)*s,y:(site.gateY+2)*s},origin),to:world({x:(site.x+7)*s,y:(site.gateY+2)*s},origin)});
    const lootPairs=affectedBefore.flatMap(r=>{
      const root=portalStands(r.brief).flatMap(p=>p.points)[0]??r.loot[0];
      return r.loot.map(p=>({category:'before-owner-loot',from:world(root,origin),to:world(p,origin),owner:r.brief.id,
        retainedAfter:after.results.some(q=>q.loot.some(v=>same(v,p)))}));
    });
    const actual=changedAfter.flatMap(r=>{
      const roots=portalStands(r.brief).flatMap(p=>p.points);
      const targets=[...r.loot.map(p=>({...p,category:'actual-after-loot'})),...r.coreElements.map(p=>({...p,category:'actual-after-core'}))];
      return targets.map(p=>{const root=roots[0]??p;return {category:p.category,from:world(root,origin),to:world(p,origin),owner:r.brief.id,noPortal:!roots.length};});
    });
    const pairs=Object.fromEntries(beforeMetrics.roles.map(r=>[r.body,[...focus,...lootPairs,...r.samples.filter(p=>p.category!=='within-region').map(p=>({category:p.category,stratum:p.stratum,from:p.from,to:p.to}))]]));
    const fixedBefore=timed(`${width}/fixed-before`,()=>measurePocketRoutes(before,pairs));
    const fixedAfter=timed(`${width}/fixed-after`,()=>measurePocketRoutes(after,pairs));
    const actualAfter=timed(`${width}/actual-after-targets`,()=>measurePocketRoutes(after,{contestant:actual,hunter:actual}));
    const metrics=timed(`${width}/structure-after`,()=>measureNavigationStructure(after));
    const raw={width,inputSha256:pin.mapSha256,resultSha256:hash(chainMapToJson(after)),policy,checks,validations,
      ownership:{reused:intervention.reusedIds,changed:intervention.changedIds,removed:affectedBefore.filter(r=>!after.results.some(a=>a.brief.id===r.brief.id)).map(r=>r.brief.id),new:changedAfter.filter(r=>!originalIds.has(r.brief.id)).map(r=>r.brief.id)},
      pairs,fixedBefore,fixedAfter,actualAfter,structureAfter:metrics};
    const roles=metrics.roles.map(r=>{
      const b=fixedBefore.roles.find(v=>v.body===r.body).samples,a=fixedAfter.roles.find(v=>v.body===r.body).samples;
      assert.deepEqual(a.map(p=>[p.from,p.to]),b.map(p=>[p.from,p.to]));
      const matched=a.filter((p,i)=>p.status==='complete'&&b[i].status==='complete');
      return {body:r.body,before:summarize(b),after:summarize(a),actualAfter:summarize(actualAfter.roles.find(v=>v.body===r.body).samples),pairedComplete:matched.length,
        pairedBefore:summarize(b.filter((p,i)=>p.status==='complete'&&a[i].status==='complete')),pairedAfter:summarize(matched)};
    });
    const actualFailures=actualAfter.roles.flatMap(r=>r.samples.filter(p=>p.status!=='complete').map(p=>({body:r.body,owner:p.owner,category:p.category,status:p.status,from:p.from,to:p.to})));
    const proofFailures=validations.filter(v=>!v.valid).map(v=>v.id);
    summary.push({width,policy,verdict:checks.before.valid&&checks.after.valid&&stagesValid&&!proofFailures.length&&!actualFailures.length?'mechanics-checks-pass':'retain-failures-defer-adoption',
      checksValid:checks.before.valid&&checks.after.valid&&stagesValid,proofFailures,actualFailures,reused:reused.size,changedAfter:changedAfter.length,affectedBefore:affectedBefore.length,
      oldLoot:lootPairs.length,removedOldLoot:lootPairs.filter(p=>!p.retainedAfter).length,actualAfterTargets:actual.length,before:aggregate(beforeMetrics),after:aggregate(metrics),roles});
    const reportText=JSON.stringify(raw), reportFile=`size-${width}.json.gz`, mapFile=`size-${width}-after.json.gz`;
    reports.push({width,file:reportFile,sha256:hash(reportText),mapFile,mapSha256:hash(chainMapToJson(after))});
    if(verify) {assert.equal(hash(reportText),retained.reports.find(r=>r.width===width).sha256,'full deterministic report');assert.equal(hash(gunzipSync(readFileSync(`${dir}/${reportFile}`))),reports.at(-1).sha256,'retained raw report');assert.equal(hash(gunzipSync(readFileSync(`${dir}/${mapFile}`))),reports.at(-1).mapSha256,'retained map');}
    else {writeFileSync(`${dir}/${reportFile}`,gzipSync(reportText));writeFileSync(`${dir}/${mapFile}`,gzipSync(chainMapToJson(after)));}
    // Full-map preview uses built geometry and the same measured fixed routes, in the fixed frame.
    const view=m=>({shapes:m.results.flatMap(r=>r.elements.flatMap(e=>elementShapes(e,true))),portals:m.results.filter(r=>r.brief.type==='experiment-curtain').flatMap(r=>r.brief.portals)});
    preview.push({width,origin,cellSize:s,frame:builtMapFrame(composeRegions(before.results)),policy,before:view(before),after:view(after),routesBefore:fixedBefore,routesAfter:fixedAfter});
    console.error(JSON.stringify(summary.at(-1),null,0).slice(0,500));
  }
} finally {await release();}

const html=`<!doctype html><meta charset="utf-8"><title>Macro curtain #705</title><style>body{font:15px system-ui;margin:20px;color:#253a50}section{display:flex;gap:12px}figure{margin:0;width:50%}canvas{width:100%;background:#eef2f3;border:1px solid #bac6cb}select{font:inherit}pre{white-space:pre-wrap}label{margin-right:20px}</style><h1>Opt-in macro curtain · #705</h1><p>Grey: physical geometry. Blue: experimental curtain. Green: curtain portal promises. Orange: fixed measured routes. Red dots: failed endpoints. The strip changes ownership and regenerates changed briefs; this is not an isolated wall overlay or production promotion. Both panels use identical world endpoints. Use browser zoom to inspect.</p><label>Size <select id="size">${preview.map((r,i)=>`<option value="${i}">${r.width}×${r.width/2}</option>`).join('')}</select></label><label>Body <select id="body"><option>contestant</option><option>hunter</option></select></label><label>Routes <select id="category"><option>curtain-crossing</option><option>gate-control</option><option>across-map</option><option>spawn-exit</option><option>spawn-charger</option><option>charger-loot</option><option>before-owner-loot</option></select></label><section><figure><figcaption>Before</figcaption><canvas id="before" width="1600" height="800"></canvas></figure><figure><figcaption>After</figcaption><canvas id="after" width="1600" height="800"></canvas></figure></section><pre id="status"></pre><details><summary>Full summary</summary><pre>${JSON.stringify(summary,null,2)}</pre></details><script>
const data=${JSON.stringify(preview)};
function draw(){const r=data[+document.querySelector('#size').value],body=document.querySelector('#body').value,cat=document.querySelector('#category').value;let statuses=[];for(const phase of ['before','after']){const c=document.getElementById(phase),g=c.getContext('2d');g.resetTransform();g.clearRect(0,0,c.width,c.height);const s=r.cellSize,w=r.frame.width,h=r.frame.height,k=Math.min(c.width/w,c.height/h);g.scale(k,k);for(const sh of r[phase].shapes){g.fillStyle='#79878c';g.beginPath();if(sh.kind==='rect')g.rect(sh.x,sh.y,sh.w,sh.h);else if(sh.kind==='circle')g.arc(sh.x,sh.y,sh.r,0,Math.PI*2);else{sh.points.forEach((p,i)=>i?g.lineTo(sh.x+p.x,sh.y+p.y):g.moveTo(sh.x+p.x,sh.y+p.y));g.closePath()}g.fill()}if(phase==='after'){g.fillStyle='#244d80';for(const [a,b]of [[r.policy.y0,r.policy.gateY],[r.policy.gateY+4,r.policy.y1+1]])g.fillRect((r.policy.x+1.5)*s,a*s,s,(b-a)*s);g.strokeStyle='#159460';g.lineWidth=s/5;for(const p of r.after.portals){g.beginPath();g.moveTo(p.x*s,p.y*s);g.lineTo((p.x+(p.axis==='h'?p.length:0))*s,(p.y+(p.axis==='v'?p.length:0))*s);g.stroke()}}const routes=r[phase==='before'?'routesBefore':'routesAfter'].roles.find(v=>v.body===body).samples.filter(p=>p.category===cat);for(const p of routes){g.strokeStyle='#d85b24';g.lineWidth=s/12;g.beginPath();p.points.forEach((v,i)=>i?g.lineTo(v.x-r.origin.x,v.y-r.origin.y):g.moveTo(v.x-r.origin.x,v.y-r.origin.y));g.stroke();if(p.status!=='complete'){g.fillStyle='#df2535';g.beginPath();g.arc(p.to.x-r.origin.x,p.to.y-r.origin.y,s/3,0,Math.PI*2);g.fill()}}statuses.push(phase+': '+JSON.stringify(routes.map(p=>({status:p.status,ratio:p.ratio}))))}document.querySelector('#status').textContent=statuses.join('\\n')}document.querySelectorAll('select').forEach(e=>e.onchange=draw);draw();</script>`;
if(verify){assert.equal(hash(html),retained.previewSha256,'preview');assert.equal(hash(readFileSync(`${dir}/index.html`)),retained.previewSha256);assert.equal(hash(readFileSync(`${dir}/summary.json`)),retained.summarySha256);assert.equal(hash(readFileSync(`${dir}/timing.json`)),retained.timingSha256);assert.deepEqual(JSON.parse(readFileSync(`${dir}/summary.json`)),summary);}
else {
  writeFileSync(`${dir}/summary.json`,JSON.stringify(summary,null,2)+'\n');writeFileSync(`${dir}/index.html`,html);
  writeFileSync(`${dir}/timing.json`,JSON.stringify({node:process.version,cpu:cpus()[0]?.model,timings,note:'Sequential under shared bench lock. Single observations; changed-brief builds and reordered repeat include planning. Offline routes/structure and final proofs reported separately.'},null,2)+'\n');
  writeFileSync(`${dir}/manifest.json`,JSON.stringify({sourceRevision:git('rev-parse','HEAD'),sourceHashes,inputManifestSha256:hash(pinText),inputs:pins.maps.filter(m=>sizes.some(w=>m.seed===`size-${w}-1`)),reports,previewSha256:hash(html),summarySha256:hash(readFileSync(`${dir}/summary.json`)),timingSha256:hash(readFileSync(`${dir}/timing.json`))},null,2)+'\n');
}
console.error(`${verify?'Verified':'Recorded'} #705 in ${dir}`);
