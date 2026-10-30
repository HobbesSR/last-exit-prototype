#!/usr/bin/env node
/** #694 source-bound static composition, separate from maintained generation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { cpus, platform, release as osRelease, totalmem } from 'node:os';
import { readMap, checkMap } from '../map/tools/core.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { builtMapFrame } from '../map/micro/adapter.ts';
import { chainMapToJson } from '../map/macro/src/chain/saving.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { measureNavigationStructure, summarizeRoutes } from '../map/tools/navigation-structure.ts';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';
import { PATTERN, placeBottle, validateBottle, targetPairs } from './experiments/static-barrier.mjs';
import { measureFixedRoutes } from './experiments/barrier-routes.mjs';

const args = process.argv.slice(2), verify = args.includes('--verify');
if (args.some(a => a !== '--verify' && !a.startsWith('--out='))) throw Error('Use --out=DIRECTORY or --verify');
const dir = args.find(a => a.startsWith('--out='))?.slice(6) ?? 'test-results/static-barrier';
if (!verify && existsSync(`${dir}/manifest.json`)) throw Error('Evidence already exists; choose a fresh --out or --verify');
const hash = v => createHash('sha256').update(v).digest('hex');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const sourceFiles = [...new Set([...git('ls-files', 'map', 'shared', 'package-lock.json').split('\n').filter(f => /\.(ts|mts|json)$/.test(f) && !f.includes('/fixtures/')),
  'tools/static-barrier-experiment.mjs', 'tools/experiments/static-barrier.mjs', 'tools/experiments/barrier-routes.mjs', 'tests/helpers/machine-lock.js'])].sort();
const sourceHashes = Object.fromEntries(sourceFiles.map(f => [f, hash(readFileSync(f, 'utf8').replaceAll('\r\n', '\n'))]));
const retained = verify ? JSON.parse(readFileSync(`${dir}/manifest.json`)) : null;
if (retained) assert.deepEqual(sourceHashes, retained.sourceHashes, 'source pins');
mkdirSync(dir, { recursive: true });
const pin688 = JSON.parse(readFileSync('docs/reports/issue-688/manifest.json'));
const summary = [], details = [], timings = [];
const timed = (label, fn) => { const start = performance.now(); const value = fn(); timings.push({ label, ms: performance.now() - start }); return value; };
const summarize = samples => Object.fromEntries([...new Set(samples.map(s => `${s.category}/${s.stratum}`))].sort().map(k => [k, summarizeRoutes(samples.filter(s => `${s.category}/${s.stratum}` === k))]));
const { release } = await acquireMachineLock('bench');
try {
  for (const width of [12, 24, 36]) {
    console.error(`Static barrier: size-${width}-1`);
    const pin = pin688.maps.find(m => m.seed === `size-${width}-1`);
    const bytes = gunzipSync(readFileSync(pin.mapFile)), metricBytes = gunzipSync(readFileSync(pin.metricsFile)), oldMetrics = JSON.parse(metricBytes);
    assert.equal(hash(bytes), pin.mapSha256, '688 map pin');
    assert.equal(hash(metricBytes), pin.metricsSha256, '688 metric pin');
    const before = readMap(JSON.parse(bytes)), original = chainMapToJson(before);
    const site = timed(`${width}/siting`, () => placeBottle(before));
    assert.ok(site.ok, JSON.stringify(site));
    const owner = before.results[site.index];
    const validation = timed(`${width}/final-thorough-owner`, () => validateBottle(owner, site.element));
    assert.ok(validation.valid, JSON.stringify(validation));
    const after = structuredClone(before); after.results[site.index].elements.push(site.element);
    assert.deepEqual(after.results.map(r => r.loot), before.results.map(r => r.loot), 'exact retained loot');
    assert.deepEqual(after.results.map(r => r.coreElements), before.results.map(r => r.coreElements), 'exact retained core sites');
    const beforeCheck = timed(`${width}/before-map-report`, () => checkMap(before));
    const afterCheck = timed(`${width}/after-map-report`, () => checkMap(after));
    assert.ok(beforeCheck.valid && afterCheck.valid, 'complete-map composition, proof and core reports');
    const origin = builtMapFrame(composeRegions(before.results)).origin, s = owner.brief.cellSize;
    const focused = targetPairs(site.element, s, origin);
    // Include every existing loot candidate near the new walls, including ones that
    // become invalid. This exposes the overlay's siting limitation, without retuning loot.
    const nearbyLoot = owner.loot.filter(p => p.x >= site.element.x - s && p.x <= site.element.x + 15*s && p.y >= site.element.y - s && p.y <= site.element.y + 15*s);
    const lootPairs = nearbyLoot.map(p => ({ category: 'retained-local-loot', from: focused.at(-1).from, to: { x: p.x + origin.x, y: p.y + origin.y } }));
    const pairs = Object.fromEntries(oldMetrics.roles.map(role => [role.body, [...focused, ...lootPairs,
      ...role.samples.filter(p => p.category !== 'within-region').map(p => ({ category: p.category, stratum: p.stratum, from: p.from, to: p.to }))]]));
    const fixedBefore = timed(`${width}/fixed-before`, () => measureFixedRoutes(before, pairs));
    const fixedAfter = timed(`${width}/fixed-after`, () => measureFixedRoutes(after, pairs));
    // Definitions stay identical to #688. Geometry-dependent pair samples from the
    // new report are descriptive only; all causal route comparisons use pairs above.
    const metrics = timed(`${width}/structure-after`, () => measureNavigationStructure(after));
    for (const result of [fixedBefore, fixedAfter]) for (const role of result.roles) role.samples.forEach((sample, i) => { sample.stratum = pairs[role.body][i].stratum ?? 'focused'; });
    const roles = metrics.roles.map(role => {
      const old = oldMetrics.roles.find(r => r.body === role.body), b = fixedBefore.roles.find(r => r.body === role.body), a = fixedAfter.roles.find(r => r.body === role.body);
      assert.deepEqual(a.samples.map(p => [p.from,p.to]), b.samples.map(p => [p.from,p.to]), 'matched endpoints');
      const focus = a.samples.filter(p => p.category === 'barrier-target');
      assert.equal(focus.length, 9);
      assert.ok(focus.every(p => p.status === 'complete' && p.ratio > 1.5), 'usable target-relative detour for both bodies');
      assert.ok(b.samples.filter(p => p.category === 'barrier-target').every(p => p.status === 'complete' && p.ratio < 1.01), 'straight matched baseline');
      const region = role.regions.find(r => r.id === site.owner), prev = old.regions.find(r => r.id === site.owner);
      assert.ok(region.deadEndArea - prev.deadEndArea > 100*s*s, 'substantial added accessible pocket');
      const compact = r => ({ walkableArea: r.walkableArea, deadEndArea: r.deadEndArea, emptyShare: r.emptyShare, emptyAreaEstimate: r.emptyAreaEstimate, impassableBoundaryShare: r.impassableBoundaryShare });
      return { body: role.body, before: summarize(b.samples), after: summarize(a.samples), ownerBefore: compact(prev), ownerAfter: compact(region),
        mapBefore: { walkableArea: old.walkableArea, deadEndArea: old.deadEndArea, components: old.components },
        mapAfter: { walkableArea: role.walkableArea, deadEndArea: role.deadEndArea, components: role.components },
        changedRoutes: a.samples.filter((p,i) => p.status !== b.samples[i].status || (p.length !== null && b.samples[i].length !== null && Math.abs(p.length-b.samples[i].length)>1e-6)).length };
    });
    assert.equal(chainMapToJson(before), original, 'input mutation');
    const record = { width, inputSha256: pin.mapSha256, resultSha256: hash(chainMapToJson(after)), site, validation, beforeCheck, afterCheck, pairs, fixedBefore, fixedAfter, structureAfter: metrics };
    details.push(record); summary.push({ width, owner: site.owner, candidates: site.candidates, refusals: site.refusals, retainedLocalLoot: nearbyLoot.length, roles });
    const reportJson = JSON.stringify(record);
    if (verify) assert.equal(hash(reportJson), retained.reports.find(r => r.width === width).sha256, 'deterministic full report');
    else writeFileSync(`${dir}/size-${width}.json.gz`, gzipSync(reportJson));
  }
} finally { await release(); }

function panel(record, changed, body) {
  const { site, validation } = record, s = 48, pad = 4*s;
  const x = site.element.x-pad, y = site.element.y-pad, w = site.bounds.w+2*pad, h=site.bounds.h+2*pad;
  const map = readMap(JSON.parse(gunzipSync(readFileSync(`docs/reports/issue-688/size-${record.width}-1.json.gz`))));
  const region = map.results[site.index], origin = builtMapFrame(composeRegions(map.results)).origin;
  const shapeSvg = (shape, color) => shape.kind === 'rect' ? `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" fill="${color}"/>` : shape.kind === 'circle' ? `<circle cx="${shape.x}" cy="${shape.y}" r="${shape.r}" fill="${color}"/>` : `<polygon points="${shape.points.map(p=>`${shape.x+p.x},${shape.y+p.y}`).join(' ')}" fill="${color}"/>`;
  const routes = (changed ? record.fixedAfter : record.fixedBefore).roles.find(r=>r.body===body).samples;
  const points = ps => ps.map(p=>`${p.x-origin.x},${p.y-origin.y}`).join(' ');
  return `<figure><figcaption>${record.width}: ${site.owner}, ${body}, ${changed?'after':'before'}</figcaption><svg viewBox="${x} ${y} ${w} ${h}">
  ${region.brief.cells.map(c=>`<rect x="${c.x*s}" y="${c.y*s}" width="48" height="48" fill="#e1ebed" stroke="#cedadd"/>`).join('')}
  ${region.elements.flatMap(e=>elementShapes(e,true)).map(sh=>shapeSvg(sh,'#647078')).join('')}
  ${changed?elementShapes(site.element).map(sh=>shapeSvg(sh,'#253a50')).join(''):''}
  ${region.brief.portals.map(p=>`<line x1="${p.x*s}" y1="${p.y*s}" x2="${(p.x+(p.axis==='h'?p.length:0))*s}" y2="${(p.y+(p.axis==='v'?p.length:0))*s}" stroke="#169a60" stroke-width="9"/>`).join('')}
  ${routes.filter(r=>r.category==='barrier-target').map(r=>`<polyline points="${points(r.points)}" fill="none" stroke="#c14c25" stroke-width="3" opacity=".65"/>`).join('')}
  ${changed?`<polyline points="${validation.pocketRoute.map(p=>`${p.x},${p.y}`).join(' ')}" fill="none" stroke="#7a3caf" stroke-width="5" stroke-dasharray="10 7"/>`:''}
  ${routes.filter(r=>r.category==='retained-local-loot').map(r=>`<circle cx="${r.to.x-origin.x}" cy="${r.to.y-origin.y}" r="6" fill="${r.status==='complete'?'#268579':'#df2535'}"/>`).join('')}
  </svg></figure>`;
}
const html = `<!doctype html><meta charset="utf-8"><title>Connected static barrier #694</title><style>body{font:16px system-ui;margin:24px;color:#253a50}section{display:grid;grid-template-columns:1fr 1fr}figure{margin:8px}svg{width:100%;background:#f5f7f8}pre{white-space:pre-wrap}select{font:inherit}</style><h1>Connected static barrier · #694</h1><p>Lab geometry only. Same fixed endpoints before/after. Orange: nine target routes. Purple dashed: independent full-radius SDK hunter pocket access. Green boundary: promised portal. Teal dots: retained local loot reached; red: failed/blocked loot. Existing geometry grey; new connected wall dark blue. Zoom uses the real owner mask; outside its cells is unshaded. No exploration simulation.</p><label>Body <select id="body"><option>contestant</option><option>hunter</option></select></label>${['contestant','hunter'].map(body=>`<div class="body" data-body="${body}">${details.map(r=>`<section>${panel(r,false,body)}${panel(r,true,body)}</section>`).join('')}</div>`).join('')}<h2>Matched distributions and failures</h2><pre>${JSON.stringify(summary,null,2)}</pre><script>function show(){document.querySelectorAll('.body').forEach(e=>e.hidden=e.dataset.body!==document.querySelector('#body').value)}document.querySelector('#body').onchange=show;show()</script>`;
if (!verify) {
  writeFileSync(`${dir}/summary.json`, JSON.stringify(summary,null,2)+'\n');
  writeFileSync(`${dir}/timing.json`, JSON.stringify({ node: process.version, machine: { platform:platform(), release:osRelease(), cpu:cpus()[0]?.model, logicalCpus:cpus().length, memoryBytes:totalmem() }, timings, note: 'Single sequential run under shared machine lock; observations, not latency guarantees. Includes standalone final proof, not general growth or per-piece preflight.' },null,2)+'\n');
  writeFileSync(`${dir}/index.html`, html);
  writeFileSync(`${dir}/manifest.json`,JSON.stringify({ sourceRevision: git('rev-parse','HEAD'), node:process.version, pattern:PATTERN, sourceHashes,
    inputs: pin688.maps.map(m=>({ file:m.mapFile,sha256:m.mapSha256,metricsFile:m.metricsFile,metricsSha256:m.metricsSha256 })),
    reports: details.map(r=>({ width:r.width, file:`size-${r.width}.json.gz`, sha256:hash(JSON.stringify(r)) })), previewSha256:hash(html) },null,2)+'\n');
} else { assert.equal(hash(html),retained.previewSha256,'preview reproducibility'); }
console.error(`${verify?'Verified':'Recorded'} static barrier evidence in ${dir}`);
