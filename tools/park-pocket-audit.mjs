#!/usr/bin/env node
/** #698: exact saved briefs, real production builds, fixed endpoints and retained failures. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { cpus } from 'node:os';
import { readMap, checkMap } from '../map/tools/core.ts';
import { chainMapToJson } from '../map/macro/src/chain/saving.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { builtMapFrame } from '../map/micro/adapter.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { elementShapes, createAccessMask, findRegionRoute } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { measureNavigationStructure, summarizeRoutes } from '../map/tools/navigation-structure.ts';
import { measurePocketRoutes, pocketPairs } from './experiments/park-pocket-routes.mjs';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';
import { createBuilderCanvas } from '../map/micro/canvas.ts';
import { protectedRoutes } from '../map/micro/strategies/scatter.ts';
import { siteParkPocket } from '../map/micro/strategies/park-pocket.ts';

const dir = process.argv[2] ?? 'docs/reports/issue-698';
const base = '63fb8aa', hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
const summarize = samples => Object.fromEntries([...new Set(samples.map(s => `${s.category}/${s.stratum}`))].sort()
  .map(k => [k, summarizeRoutes(samples.filter(s => `${s.category}/${s.stratum}` === k))]));
mkdirSync(dir, { recursive: true }); mkdirSync('test-results', { recursive: true });
// Evaluate the exact base builder with imports resolving to their original modules.
// Those imports have no behavior changes here; their hashes are pinned in the manifest.
const oldSource = execFileSync('git', ['show', `${base}:map/micro/strategies/park.ts`], { encoding: 'utf8' });
const oldModule = oldSource.replace(/from '([^']+)'/g, (_, spec) =>
  `from '${pathToFileURL(resolve('map/micro/strategies', spec)).href}'`);
writeFileSync('test-results/issue-698-before.mts', oldModule);
const { buildPark: buildBefore } = await import(pathToFileURL(resolve('test-results/issue-698-before.mts')).href);
const sources = [...new Set([...git('ls-files', 'map', 'shared').split('\n'),
  'map/micro/strategies/park-pocket.ts', 'map/micro/placeables/park-hedge-pocket.ts',
  'tools/park-pocket-audit.mjs', 'tools/experiments/park-pocket-routes.mjs', 'tests/helpers/machine-lock.js'])].sort();
const sourceHashes = Object.fromEntries(sources.map(file => [file, hash(readFileSync(file))]));
const inputs = [], summaries = [], details = [], timings = [];
const timed = (label, fn) => { const start = performance.now(), value = fn(); timings.push({ label, ms: performance.now() - start }); return value; };
const { release } = await acquireMachineLock('bench');
try {
  for (const width of [12, 24, 36]) {
    console.error(`Park pocket audit: ${width}`);
    const file = `docs/reports/issue-688/size-${width}-1.json.gz`, metricsFile = `docs/reports/issue-688/size-${width}-1-metrics.json.gz`;
    const bytes = gunzipSync(readFileSync(file)), metricBytes = gunzipSync(readFileSync(metricsFile));
    inputs.push({ file, sha256: hash(bytes), metricsFile, metricsSha256: hash(metricBytes) });
    const before = readMap(JSON.parse(bytes)), oldMetrics = JSON.parse(metricBytes), after = structuredClone(before);
    after.build = REGION_TYPES_VERSION;
    const indices = before.results.flatMap((r, i) => r.brief.type === 'park' ? [i] : []);
    for (const i of indices) assert.deepEqual(buildBefore(before.results[i].brief), before.results[i], 'base builder matches retained input');
    // Warm both paths once, then three sequential paired observations on all real family briefs.
    for (const i of indices) { buildBefore(before.results[i].brief); buildRegion(before.results[i].brief); }
    const generation = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const start = performance.now(); for (const i of indices) buildBefore(before.results[i].brief);
      const beforeMs = performance.now() - start, next = performance.now();
      for (const i of indices) after.results[i] = buildRegion(before.results[i].brief);
      generation.push({ repeat, beforeMs, afterMs: performance.now() - next });
    }
    const changed = indices.filter(i => JSON.stringify(after.results[i]) !== JSON.stringify(before.results[i]));
    const unchanged = indices.filter(i => !changed.includes(i));
    const sites = changed.map(i => {
      const region = after.results[i], element = region.elements.find(e => e.label === 'park-pocket');
      assert.ok(element, 'every changed real park admits a pocket');
      const admission = timed(`${width}/${region.brief.id}/siting-with-route-preparation`, () => {
        const b = region.brief;
        return siteParkPocket(b, createBuilderCanvas(b, protectedRoutes(b, 'Park', b.portals.length <= 32 ? 'root' : 'nearby')));
      });
      const blockers = region.elements.flatMap(e => elementShapes(e, true));
      const validation = timed(`${width}/${region.brief.id}/final-owner-proof`, () => {
        const fillErrors = validateFillConstraints(region.brief, blockers);
        const portals = validatePortalReach({ ...region.brief, blockers }, { search: 'thorough' });
        const target = { x: element.x + 3 * region.brief.cellSize, y: element.y + 7 * region.brief.cellSize };
        const root = portalStands(region.brief).flatMap(p => p.points).toSorted((a, b) => Math.hypot(a.x-target.x,a.y-target.y)-Math.hypot(b.x-target.x,b.y-target.y))[0];
        const pocketRoute = findRegionRoute(createAccessMask(region.brief), blockers, root, target, hunterClearance(region.brief.cellSize));
        return { valid: !fillErrors.length && portals.valid && !!pocketRoute, fillErrors, portalErrors: portals.errors, joins: portals.joins, pocketRoute };
      });
      assert.ok(validation.valid, JSON.stringify(validation));
      const b = region.brief;
      const reordered = { ...b, cells: [...b.cells].reverse(), fillCells: [...b.fillCells].reverse(), clearCells: [...b.clearCells].reverse(),
        zones: b.zones.map(z => ({ ...z, cells: [...z.cells].reverse() })) };
      const again = buildRegion(reordered);
      assert.deepEqual(again.elements, region.elements); assert.deepEqual(again.loot, region.loot);
      const oldLoot = before.results[i].loot;
      const sameSite = (p, q) => p.x === q.x && p.y === q.y;
      return { index: i, owner: b.id, element, admission, validation, beforeLoot: oldLoot.length, afterLoot: region.loot.length,
        removedLoot: oldLoot.filter(p => !region.loot.some(q => sameSite(p,q))).length,
        addedLoot: region.loot.filter(p => !oldLoot.some(q => sameSite(p,q))).length };
    });
    const beforeCheck = checkMap(before), afterCheck = checkMap(after);
    assert.ok(beforeCheck.valid && afterCheck.valid, 'whole-map composition, proof and core checks');
    const origin = builtMapFrame(composeRegions(before.results)).origin;
    const focused = sites.flatMap(site => pocketPairs(site.element, before.cellSize, origin));
    const oldLoot = sites.flatMap(site => {
      const old = before.results[site.index], root = pocketPairs(site.element, before.cellSize, origin).at(-1).from;
      return old.loot.map(p => ({ category: 'before-owner-loot', from: root, to: { x:p.x+origin.x, y:p.y+origin.y }, owner:site.owner,
        retainedAfter: after.results[site.index].loot.some(q => q.x===p.x && q.y===p.y) }));
    });
    const actualLoot = sites.flatMap(site => {
      const region = after.results[site.index], stands = portalStands(region.brief).flatMap(p => p.points);
      return region.loot.map(p => {
        const root = stands.toSorted((a,b) => Math.hypot(a.x-p.x,a.y-p.y)-Math.hypot(b.x-p.x,b.y-p.y))[0];
        return { category:'actual-after-owner-loot', from:{x:root.x+origin.x,y:root.y+origin.y}, to:{x:p.x+origin.x,y:p.y+origin.y}, owner:site.owner };
      });
    });
    const pairs = Object.fromEntries(oldMetrics.roles.map(role => [role.body, [...focused, ...oldLoot,
      ...role.samples.filter(p => p.category !== 'within-region').map(p => ({ category:p.category, stratum:p.stratum, from:p.from, to:p.to }))]]));
    const fixedBefore = sites.length ? timed(`${width}/fixed-before`, () => measurePocketRoutes(before, pairs)) : null;
    const fixedAfter = sites.length ? timed(`${width}/fixed-after`, () => measurePocketRoutes(after, pairs)) : null;
    const actualAfter = sites.length ? timed(`${width}/actual-after-targets`, () => measurePocketRoutes(after, { contestant:actualLoot, hunter:actualLoot })) : null;
    const metrics = sites.length ? timed(`${width}/structure-after`, () => measureNavigationStructure(after)) : oldMetrics;
    const roles = metrics.roles.map(role => {
      const old = oldMetrics.roles.find(r=>r.body===role.body), b = fixedBefore?.roles.find(r=>r.body===role.body), a = fixedAfter?.roles.find(r=>r.body===role.body);
      if (a) {
        assert.deepEqual(a.samples.map(p=>[p.from,p.to]),b.samples.map(p=>[p.from,p.to]));
        assert.ok(a.samples.filter(p=>p.category==='pocket-target').every(p=>p.status==='complete' && p.ratio>1.5), 'target-relative detour');
        assert.ok(actualAfter.roles.find(r=>r.body===role.body).samples.every(p=>p.status==='complete'), 'actual final owner loot accessible');
        for (const site of sites) assert.ok(role.regions.find(r=>r.id===site.owner).deadEndArea-old.regions.find(r=>r.id===site.owner).deadEndArea>100*before.cellSize**2, 'substantial added pocket');
      }
      return { body:role.body, before:b?summarize(b.samples):null, after:a?summarize(a.samples):null,
        actualAfter: actualAfter ? summarize(actualAfter.roles.find(r=>r.body===role.body).samples) : null,
        owners:sites.map(site=>({ id:site.owner, before:old.regions.find(r=>r.id===site.owner), after:role.regions.find(r=>r.id===site.owner) })),
        mapBefore:{components:old.components,deadEndArea:old.deadEndArea,walkableArea:old.walkableArea},
        mapAfter:{components:role.components,deadEndArea:role.deadEndArea,walkableArea:role.walkableArea} };
    });
    const resultBytes = chainMapToJson(after);
    // Complete saved results are historical data; layout-only old identities must be refused.
    assert.deepEqual(readMap(JSON.parse(resultBytes)), after, 'new complete saved-map round trip');
    assert.throws(() => readMap(JSON.parse(chainMapToJson(before, { results:false }))), /built by strategies types-55, not types-56/, 'old layout identity refuses silent regeneration');
    assert.deepEqual(readMap(JSON.parse(chainMapToJson(after, { results:false }))), after, 'current layout-only rebuild');
    const record = { width, sites, unchangedOwners:unchanged.map(i=>before.results[i].brief.id), generation, beforeCheck, afterCheck,
      fixedBefore, fixedAfter, actualAfter, structureAfter:metrics };
    writeFileSync(`${dir}/size-${width}-after.json.gz`, gzipSync(resultBytes));
    writeFileSync(`${dir}/size-${width}-report.json.gz`, gzipSync(JSON.stringify(record)));
    details.push(record); summaries.push({ width, parks:indices.length, changed:sites.length, unchanged:unchanged.length, generation,
      sites:sites.map(({validation,...site})=>({...site,validationValid:validation.valid})), roles });
  }
} finally { release(); }

const shapeSvg = (shape, color) => shape.kind==='rect' ? `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" fill="${color}"/>`
  : shape.kind==='circle' ? `<circle cx="${shape.x}" cy="${shape.y}" r="${shape.r}" fill="${color}"/>`
  : `<polygon points="${shape.points.map(p=>`${shape.x+p.x},${shape.y+p.y}`).join(' ')}" fill="${color}"/>`;
function panel(record,site,changed,body) {
  const map=readMap(JSON.parse(gunzipSync(readFileSync(`docs/reports/issue-688/size-${record.width}-1.json.gz`))));
  const r=map.results[site.index],s=r.brief.cellSize,e=site.element,origin=builtMapFrame(composeRegions(map.results)).origin;
  const after=readMap(JSON.parse(gunzipSync(readFileSync(`${dir}/size-${record.width}-after.json.gz`)))).results[site.index];
  const region=changed?after:r,routes=(changed?record.fixedAfter:record.fixedBefore).roles.find(r=>r.body===body).samples;
  return `<figure><figcaption>${record.width}: ${site.owner}, ${body}, ${changed?'after':'before'}</figcaption><svg viewBox="${e.x-3*s} ${e.y-3*s} ${20*s} ${20*s}">
  ${r.brief.cells.filter(c=>c.x*s>=e.x-3*s && c.x*s<e.x+17*s && c.y*s>=e.y-3*s && c.y*s<e.y+17*s).map(c=>`<rect x="${c.x*s}" y="${c.y*s}" width="${s}" height="${s}" fill="#e3ebed" stroke="#ccd8dc"/>`).join('')}
  ${region.elements.flatMap(e=>elementShapes(e,true)).map(sh=>shapeSvg(sh,'#526751')).join('')}
  ${region.loot.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="4" fill="#108080"/>`).join('')}
  ${changed?r.loot.filter(p=>!after.loot.some(q=>q.x===p.x&&q.y===p.y)).map(p=>`<circle cx="${p.x}" cy="${p.y}" r="7" fill="none" stroke="#d32c45" stroke-width="3"/>`).join(''):''}
  ${routes.filter(p=>p.category==='pocket-target' && p.to.x>=e.x+origin.x && p.to.x<e.x+14*s+origin.x && p.to.y>=e.y+origin.y && p.to.y<e.y+14*s+origin.y).map(p=>`<polyline points="${p.points.map(p=>`${p.x-origin.x},${p.y-origin.y}`).join(' ')}" fill="none" stroke="#d05b24" stroke-width="3"/>`).join('')}
  </svg></figure>`;
}
const html=`<!doctype html><meta charset="utf-8"><title>Production park pocket · #698</title><style>body{font:16px system-ui;margin:24px;color:#233a40}section{display:grid;grid-template-columns:1fr 1fr}figure{margin:8px}svg{width:100%;background:#f7f9fa}pre{white-space:pre-wrap}</style><h1>Production park pocket · #698</h1><p>Real production builder results on exact saved briefs. Green: body-blocking hedges/trees; teal: actual loot; orange: fixed pocket target routes. One pocket per admitted park. The 12×6 sample has no fit. Switch bodies to inspect both sets of routes. No exploration simulation or map-scale progression claim.</p><label>Body <select id="body"><option>contestant</option><option>hunter</option></select></label>${['contestant','hunter'].map(body=>`<div class="body" data-body="${body}">${details.flatMap(r=>r.sites.map(site=>`<section>${panel(r,site,false,body)}${panel(r,site,true,body)}</section>`)).join('')}</div>`).join('')}<h2>Evidence</h2><pre>${JSON.stringify(summaries,null,2)}</pre><script>function show(){document.querySelectorAll('.body').forEach(e=>e.hidden=e.dataset.body!==document.querySelector('#body').value)}document.querySelector('#body').onchange=show;show()</script>`;
writeFileSync(`${dir}/index.html`,html);
writeFileSync(`${dir}/summary.json`,JSON.stringify(summaries,null,2)+'\n');
writeFileSync(`${dir}/timing.json`,JSON.stringify({node:process.version,cpu:cpus()[0]?.model,timings,note:'Sequential shared bench lock. Three warm family build pairs; diagnostic and offline analysis costs separate.'},null,2)+'\n');
writeFileSync(`${dir}/manifest.json`,JSON.stringify({base,revision:git('rev-parse','HEAD'),version:REGION_TYPES_VERSION,node:process.version,legacyBuilderSha256:hash(oldSource),sourceHashes,inputs,
  artifacts:Object.fromEntries(['index.html','summary.json','timing.json',...[12,24,36].flatMap(w=>[`size-${w}-after.json.gz`,`size-${w}-report.json.gz`])].map(file=>[file,hash(readFileSync(`${dir}/${file}`))]))},null,2)+'\n');
console.error(`Recorded ${dir}`);
