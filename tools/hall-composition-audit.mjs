import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {buildHall} from '../map/micro/strategies/hall.ts';
import {measureFill} from '../map/micro/fill.ts';
import {createFillMask,createAccessMask,elementShapes,findRegionRoute,shapesShareArea,travelClear} from '../map/micro/geometry.ts';
import {hunterClearance,portalStands,validatePortalReach} from '../map/micro/portals.ts';
import {validateFillConstraints} from '../map/micro/margins.ts';
import {microMetrics} from '../map/micro/metrics.ts';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {generate} from '../map/chain.ts';
import {GAME_ENGINES} from '../map/engines.ts';
import {mapViews} from '../map/macro/src/chain/map.ts';
import {circle} from '../shared/shape.ts';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const dir='docs/reports/issue-533-hall'; await mkdir(dir,{recursive:true});
if (!['--verify', '--capture-new-library', undefined].includes(process.argv[2])) throw new Error('Use no argument to inspect retained briefs, or --verify. Baseline capture is historical.');
{
 const baseBytes=await readFile(`${dir}/baseline.json.gz`), base=JSON.parse(gunzipSync(baseBytes));
 const files=git('ls-files','--cached','--others','--exclude-standard','map/micro','map/kernel','shared','map/macro/src','map/macro/content','map/chain.ts','map/engines.ts').split(/\r?\n/).filter(p=>/\.(ts|json)$/.test(p));
 const sources=async()=>Object.fromEntries(await Promise.all(files.sort().map(async p=>[p,hash((await readFile(p,'utf8')).replaceAll('\r\n','\n'))])));
 const before=await sources();
 if(process.argv[2]==='--capture-new-library') {
  // Historical original-library rows remain intact; capture only this deliberate
  // library prerequisite, comparing the two builders on identical final briefs.
  const sourcePath='map/micro/strategies/hall.ts';
  const oldSource=execFileSync('git',['show',`${base.commit}:${sourcePath}`],{encoding:'utf8'});
  await mkdir('test-results',{recursive:true});
  const scratch=await mkdtemp(resolve('test-results/hall-source-'));
  const pinned=resolve(scratch,'hall.ts');
  await writeFile(pinned,oldSource.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
   (_,a,p,z)=>`${a}${pathToFileURL(resolve(dirname(sourcePath),p)).href}${z}`));
  const old=(await import(pathToFileURL(pinned).href)).buildHall;
  base.rows=base.rows.filter(r=>!r.name.startsWith('new-library/'));
  const inventory=[];
  for(const [zoneWidth,zoneHeight] of [[12,6],[24,12],[36,18]]) {
   for(let i=-1;i<10;i++) {
    const seed=i<0?`issue330-before-${zoneWidth}x${zoneHeight}`:`issue533-hall-new-${i}`;
    const views=mapViews(generate(seed,{mode:'game',zoneWidth,zoneHeight}),GAME_ENGINES.compose);
    const halls=views.briefs.filter(b=>b.type==='hall'); let positive=0;
    for(const brief of halls) {
     const result=old(brief),current=buildHall(brief),wings=current.manifest.wings??0;
     if(wings) positive++;
     if(i<0||wings) base.rows.push({name:`new-library/${zoneWidth}x${zoneHeight}/${seed}/${brief.id}`,
      brief,briefHash:hash(brief),result,outputHash:hash(result)});
    }
    inventory.push({seed,zoneWidth,zoneHeight,halls:halls.length,positive,defects:views.report.defects});
    console.log(`${zoneWidth}x${zoneHeight} ${seed}: ${halls.length} halls, ${positive} positive`);
    if(positive) break;
   }
  }
  assert.deepEqual(await sources(),before,'Sources changed during input capture');
  base.newLibrary={commit:git('rev-parse','HEAD'),node:process.version,sourceHashes:before,inventory,
   note:'Final revised-library briefs, old strategy versus current strategy on identical inputs. Named maps retained whole; additional seeds stop at first positive per size and retain positive briefs. Selection inventory records negative maps. Shared dependencies are current.'};
  await writeFile(`${dir}/baseline.json.gz`,gzipSync(JSON.stringify(base)));
  console.log(`Retained ${base.rows.length} baseline inputs and pinned original outputs`); process.exit(0);
 }

 if(process.argv[2]==='--verify') {
  const report=JSON.parse(gunzipSync(await readFile(`${dir}/comparison.json.gz`)));
  assert.equal(report.baselineHash,hash(baseBytes)); assert.deepEqual(report.sourceHashes,before);
  assert.equal(report.auditHash,hash((await readFile('tools/hall-composition-audit.mjs','utf8')).replaceAll('\r\n','\n')));
  assert.equal(report.rows.length,base.rows.length); assert.equal(new Set(report.rows.map(r=>r.name)).size,report.rows.length);
  for(const row of report.rows) { const b=base.rows.find(v=>v.name===row.name); assert.ok(b); assert.equal(hash(b.brief),b.briefHash); assert.equal(row.briefHash,b.briefHash); assert.equal(hash(b.result),b.outputHash); assert.equal(row.baseline.outputHash,b.outputHash); assert.equal(hash(buildHall(b.brief)),row.current.outputHash); assert.equal(hash(row.result),row.current.outputHash); assert.equal(row.current.fillErrors.length,0); assert.equal(row.current.portalErrors.length,0); assert.equal(row.current.badLoot.length,0); assert.equal(row.lostWalkable.length,0); assert.equal(row.current.samples.filter(p=>p.reached===false).length,0); }
  assert.deepEqual(await sources(),before); console.log(`Verified ${report.rows.length} outputs and source hashes`); process.exit(0);
 }
 function flood(b,r) {
  const blockers=r.elements.flatMap(e=>elementShapes(e)), access=createAccessMask(b), size=b.cellSize, radius=hunterClearance(size);
  const cells=[...b.cells].sort((a,c)=>a.y-c.y||a.x-c.x), point=c=>({x:(c.x+1)*size,y:(c.y+1)*size}), key=c=>`${c.x},${c.y}`;
  const byKey=new Map(cells.map(c=>[key(c),c])), free=new Map();
  for(const c of cells) free.set(key(c),travelClear(access,blockers,point(c),point(c),radius));
  const root=portalStands(b)[0]?.points[0]??cells.map(point).find(p=>travelClear(access,blockers,p,p,radius));
  const reached=new Set(),queue=[];
  if(root) for(const c of cells) if(free.get(key(c))&&Math.hypot(point(c).x-root.x,point(c).y-root.y)<=2.5*size&&travelClear(access,blockers,root,point(c),radius)){reached.add(key(c));queue.push(c);}
  for(let i=0;i<queue.length;i++) {const c=queue[i];for(const [dx,dy] of [[1,0],[0,1],[-1,0],[0,-1]]) {const n=byKey.get(`${c.x+dx},${c.y+dy}`);if(n&&free.get(key(n))&&!reached.has(key(n))&&travelClear(access,blockers,point(c),point(n),radius)){reached.add(key(n));queue.push(n);}}}
  return {walkable:[...free].filter(([,v])=>v).map(([k])=>k),reachable:[...reached]};
 }
 function inspect(b,r) {
  const blockers=r.elements.flatMap(e=>elementShapes(e)), closed=r.elements.flatMap(e=>elementShapes(e,true));
  const fill=measureFill(b,r.elements), radius=microMetrics({cellSize:b.cellSize,bodyProfile:'cell'}).lootRadius;
  const badLoot=r.loot.filter(p=>closed.some(s=>shapesShareArea(s,circle(p.x,p.y,radius))));
  const structural=r.elements.filter(e=>e.label==='hall'||e.label.startsWith('hall-wing'));
  const stands=portalStands(b).flatMap(s=>s.points), access=createAccessMask(b);
  const samples=[];
  for(const e of structural.filter(e=>e.label.startsWith('hall-wing-'))) {
   const x=e.x,y=e.y,w=e.template.w,h=e.template.h,s=b.cellSize, inset=1.25*s;
   const pts=[{x:x+w/2,y:y+inset},{x:x+w/2,y:y+h-inset},{x:x+inset,y:y+h/2},{x:x+w-inset,y:y+h/2}];
   for(const point of pts) {
    const nearest=[...stands].sort((a,c)=>Math.hypot(a.x-point.x,a.y-point.y)-Math.hypot(c.x-point.x,c.y-point.y))[0];
    samples.push({label:e.label,point,reached:nearest?!!findRegionRoute(access,blockers,nearest,point,hunterClearance(s)):null});
   }
  }
  return {outputHash:hash(r),manifest:r.manifest,structural:structural.map(e=>({label:e.label,x:e.x,y:e.y,w:e.template.w,h:e.template.h,encloses:!!e.template.encloses,envelopeCells:e.template.w*e.template.h/(b.cellSize*b.cellSize),roofCells:e.template.encloses?e.template.w*e.template.h/(b.cellSize*b.cellSize):(e.template.roofs??[]).reduce((n,v)=>n+v.cells.length,0)})),pillars:r.manifest.pillars??0,crates:r.manifest.infillCrates??0,loot:r.loot.length,occupied:fill.cells-fill.freeCells,fillErrors:validateFillConstraints(b,closed),portalErrors:validatePortalReach({...b,blockers},{search:'thorough'}).errors,badLoot,samples};
 }
 const rows=[];
 for(const b of base.rows) { console.log(`Audit ${b.name}`); const result=buildHall(b.brief), baseline=inspect(b.brief,b.result), current=hash(result)===b.outputHash?baseline:inspect(b.brief,result);
  const candidates=measureFill({...b.brief,cells:createFillMask(b.brief).cells},[],6).rectangles;
  const oldFlood=flood(b.brief,b.result), newFlood=hash(result)===b.outputHash?oldFlood:flood(b.brief,result); const walkable=new Set(newFlood.walkable), reachable=new Set(newFlood.reachable); const lostWalkable=oldFlood.reachable.filter(k=>walkable.has(k)&&!reachable.has(k));
  rows.push({name:b.name,briefHash:b.briefHash,eligible:candidates.length>1,noFit:candidates.length===0,unchanged:hash(result)===b.outputHash,baseline,current,oldFlood,newFlood,lostWalkable,result}); }
 assert.deepEqual(await sources(),before,'source changed during audit');
 const auditHash=hash((await readFile('tools/hall-composition-audit.mjs','utf8')).replaceAll('\r\n','\n'));
 const report={audit:'hall-composition-comparison-1',baselineHash:hash(baseBytes),commit:git('rev-parse','HEAD'),node:process.version,sourceHashes:before,auditHash,rows,limits:'Five original-library halls, seven synthetic shapes and the retained final-library briefs. New-library samples include first-positive seed selection, retained in baseline.newLibrary.inventory. Eligibility is a coarse disjoint 6x6 fill-rectangle indicator, not a placement guarantee. Perimeter samples use the nearest portal; null means no portal. Samples are diagnostics and may lie on obstacles; they are not exhaustive accessibility proofs.'};
 await writeFile(`${dir}/comparison.json.gz`,gzipSync(JSON.stringify(report)));
 await writeFile(`${dir}/summary.json`,JSON.stringify({maps:base.maps,rows:rows.map(({name,eligible,noFit,unchanged,baseline,current,lostWalkable})=>({name,eligible,noFit,unchanged,baseline,current,lostWalkable}))},null,2)+'\n');
 const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 function svg(b,r){const z=b.cellSize,xs=b.cells.map(c=>c.x),ys=b.cells.map(c=>c.y),x=Math.min(...xs)*z,y=Math.min(...ys)*z;
  let out=`<svg viewBox="${x-z} ${y-z} ${(Math.max(...xs)+1)*z-x+2*z} ${(Math.max(...ys)+1)*z-y+2*z}">`;
  for(const c of b.cells)out+=`<rect x="${c.x*z}" y="${c.y*z}" width="${z}" height="${z}" fill="#ece8da" stroke="#ccc"/>`;
  for(const e of r.elements){out+=`<rect x="${e.x}" y="${e.y}" width="${e.template.w}" height="${e.template.h}" fill="#8ba7bb" opacity=".35"/>`;for(const s of elementShapes(e,true)) {if(s.kind==='rect')out+=`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="#343b40"/>`;else if(s.kind==='circle')out+=`<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="#343b40"/>`;else out+=`<polygon points="${s.points.map(p=>`${p.x+s.x},${p.y+s.y}`).join(' ')}" fill="#343b40"/>`;}}
  for(const p of b.portals)out+=`<line x1="${p.x*z}" y1="${p.y*z}" x2="${(p.x+(p.axis==='h'?p.length:0))*z}" y2="${(p.y+(p.axis==='v'?p.length:0))*z}" stroke="#bc1d89" stroke-width="8"/>`; return out+'</svg>';}
 const html=`<!doctype html><meta charset="utf-8"><title>Hall composition</title><style>body{font:15px system-ui;margin:24px}.pair{display:flex;gap:16px}figure{margin:0;flex:1;min-width:0}svg{width:100%;max-height:500px}section{border-top:1px solid #999;padding:16px 0}</style><h1>Hall composition #533</h1><p>Owned cells pale, envelopes blue, collision dark, portal seams magenta. Exact inputs and outputs are retained in the compressed reports.</p>${rows.map(row=>{const b=base.rows.find(v=>v.name===row.name);return `<section><h2>${esc(row.name)}</h2><div class="pair"><figure><figcaption>Before</figcaption>${svg(b.brief,b.result)}</figure><figure><figcaption>After</figcaption>${svg(b.brief,row.result)}</figure></div></section>`}).join('')}`;
 await writeFile(`${dir}/index.html.gz`,gzipSync(html));
 await mkdir('test-results',{recursive:true});
 await writeFile('test-results/533-hall-composition.html',html);
 const failures=rows.filter(r=>r.current.fillErrors.length||r.current.portalErrors.length||r.current.badLoot.length||r.lostWalkable.length||r.current.samples.some(p=>p.reached===false));
 console.log(`Retained ${rows.length} comparisons in ${dir}; ${failures.length} failed geometry/access cases`);
 assert.deepEqual(failures.map(r=>r.name),[], 'Final geometry/access failures');
}
