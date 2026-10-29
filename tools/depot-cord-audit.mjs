// Tool-only #663 comparison; retained inputs can be replayed without regenerating maps.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { buildDepot, buildDepotExperiment } from '../map/micro/strategies/depot.ts';
import { createAccessMask, elementShapes, findRegionRoute, shapesOverlap, shapesShareArea } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { measureFill } from '../map/micro/fill.ts';
import { protectedRoutes } from '../map/micro/strategies/scatter.ts';
import { rect } from '../shared/shape.ts';
import { chainBrief, reorderedBrief } from '../tests/helpers/chain-briefs.js';
import { cellsOf } from '../tests/helpers/cells.js';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';

const args = new Map(process.argv.slice(2).map(a => {
  const [key, ...value] = a.replace(/^--/, '').split('=');
  if (!['input', 'out', 'timing', 'direct', 'capture'].includes(key)) throw Error(`Unknown option ${a}`);
  return [key, value.join('=') || true];
}));
const dir = resolve(args.get('out') || 'test-results/depot-cords');
await mkdir(dir, { recursive: true });
const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const modes = ['production', 'fixed', 'movable'];
const build = (b, mode, observe) => mode === 'production' ? { result: buildDepot(b, observe), diagnostics: null } : buildDepotExperiment(b, mode, observe);
async function provenance() {
  const paths = git('ls-files', '--cached', '--others', '--exclude-standard', 'map/micro', 'map/kernel', 'shared').split(/\r?\n/).filter(p => /\.ts$/.test(p));
  for (const p of ['map/micro/experiments/depot-canvas.ts', 'tools/depot-cord-audit.mjs']) if (!paths.includes(p)) paths.push(p);
  const sourceHashes = Object.fromEntries(await Promise.all(paths.sort().map(async p => [p, hash(await readFile(p))])));
  return { commit: git('rev-parse', 'HEAD'), node: process.version, platform: `${process.platform}/${process.arch}`,
    dirty: git('status', '--porcelain', '--untracked-files=no'), sourceHashes };
}
const source = await provenance();
const unchangedSources = async () => assert.deepEqual((await provenance()).sourceHashes, source.sourceHashes, 'source changed during audit; rerun');
const direct = seed => ({ name: `crossing-${seed}`, source: 'isolated 24x18 opposite portals', brief: chainBrief({
  id: `crossing-${seed}`, type: 'depot', seed, cells: cellsOf(24, 18),
  portals: [{ id: 'west', axis: 'v', x: 0, y: 8, length: 2 }, { id: 'east', axis: 'v', x: 24, y: 8, length: 2 }],
}) });
let input;
if (args.has('input')) {
  const bytes = await readFile(resolve(args.get('input')));
  const saved = JSON.parse((String(args.get('input')).endsWith('.gz') ? gunzipSync(bytes) : bytes).toString());
  input = saved.input ?? saved;
} else {
  input = { maps: [], workloads: Array.from({ length: 6 }, (_, i) => direct(i + 1)) };
  if (!args.has('direct')) for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
    const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
    console.log(`Collecting ${seed}`);
    const views = mapViews(generate(seed, { mode: 'game', zoneWidth, zoneHeight }), GAME_ENGINES.compose);
    const depots = views.briefs.filter(b => b.type === 'depot');
    input.maps.push({ seed, zoneWidth, zoneHeight, depots: depots.length, defects: views.report.defects });
    for (const brief of depots) input.workloads.push({ name: `${seed}/${brief.id}`, source: seed, brief });
  }
}
const inputHash = hash(input);
await writeFile(resolve(dir,'inputs.json.gz'),gzipSync(JSON.stringify(input)));
if (args.has('capture')) { console.log(`Captured ${input.workloads.length} workloads, ${inputHash}`); process.exit(0); }
if (args.has('timing')) {
  const rounds = [], expected = new Map(), lock = await acquireMachineLock('bench');
  try {
    for (const w of input.workloads) for (const mode of modes) expected.set(`${w.name}/${mode}`, hash(build(w.brief, mode).result));
    for (let round = 0; round < 3; round++) {
      const rows = [];
      // Rotate policy order each round; each build is sequential, no validation/rendering in timings.
      for (const w of input.workloads) {
        const row = { name: w.name, milliseconds: {} };
        for (const mode of [...modes.slice(round), ...modes.slice(0, round)]) {
          const start = performance.now(); const built = build(w.brief, mode);
          row.milliseconds[mode] = performance.now() - start;
          row[`${mode}Hash`] = hash(built.result);
        }
        rows.push(row);
      }
      rounds.push({ round: round + 1, rows, totals: Object.fromEntries(modes.map(mode => [mode, rows.reduce((n, r) => n + r.milliseconds[mode], 0)])) });
      console.log(JSON.stringify(rounds.at(-1).totals));
    }
  } finally { lock.release(); }
  for (const round of rounds) for (const row of round.rows) for (const mode of modes) assert.equal(row[`${mode}Hash`], expected.get(`${row.name}/${mode}`), 'timed output drift');
  await unchangedSources();
  await writeFile(resolve(dir, 'timing.json'), JSON.stringify({ audit: 'depot-cord-comparison-1', inputHash, ...source, rounds,
    limits: 'Three sequential paired rounds after one warmup under machine benchmark lock. No competing agent tests launched; external load not sampled. Detached replay overhead is part of the experiment.' }, null, 2) + '\n');
} else {
  const rows = [];
  for (const w of input.workloads) {
    console.log(`Audit ${w.name} (${w.brief.cells.length} cells, ${w.brief.portals.length} portals)`);
    const row = { name: w.name, briefHash: hash(w.brief), builds: {} };
    const frozen = protectedRoutes(w.brief, 'Depot', 'nearby');
    row.frozenRoutes = frozen;
    for (const mode of modes) {
      const traces = [];
      const v = build(w.brief, mode, trace => traces.push(trace)), b = w.brief, r = v.result;
      const blockers = r.elements.flatMap(e => elementShapes(e));
      const closedBlockers = r.elements.flatMap(e => elementShapes(e, true));
      const mask = createAccessMask(b), stands = portalStands(b).flatMap(s => s.points);
      const errors = [...validateFillConstraints(b, r.elements.flatMap(e => elementShapes(e, true))),
        ...validatePortalReach({ ...b, blockers }, { search: 'thorough' }).errors];
      const doors = [], doorsteps = [], rooms = [], bypassErrors = [], spacingErrors = [];
      for (const [index, e] of r.elements.entries()) {
        if (mode !== 'production') {
          if (!mask.contains(rect(e.x - 2*b.cellSize, e.y - 2*b.cellSize, e.template.w + 4*b.cellSize, e.template.h + 4*b.cellSize))) bypassErrors.push(e.label);
          const grown = rect(e.x - 2*b.cellSize, e.y - 2*b.cellSize, e.template.w + 4*b.cellSize, e.template.h + 4*b.cellSize);
          for (const other of r.elements.slice(index+1)) if (shapesOverlap(grown, rect(other.x, other.y, other.template.w, other.template.h))) spacingErrors.push([e.label, other.label]);
        }
        if (!e.label.startsWith('depot-warehouse')) continue;
        const trace = traces.find(t => t.label === e.label);
        for (const door of trace.realization.openings.filter(o => o.kind === 'door' && (o.a === 'outside' || o.b === 'outside'))) {
          const { run, center } = door, horizontal = run.axis === 'h';
          const start = (horizontal ? run.x : run.y) + center - 1;
          for (const along of new Set([Math.floor(start), Math.ceil(start)])) {
            const point = horizontal ? { x:e.x+(along+1)*b.cellSize, y:e.y+(run.y===0?-1:e.template.h/b.cellSize+1)*b.cellSize }
              : { x:e.x+(run.x===0?-1:e.template.w/b.cellSize+1)*b.cellSize, y:e.y+(along+1)*b.cellSize };
            const square = rect(point.x-b.cellSize, point.y-b.cellSize, 2*b.cellSize, 2*b.cellSize);
            const near = [...stands].sort((a,c) => Math.hypot(a.x-point.x,a.y-point.y)-Math.hypot(c.x-point.x,c.y-point.y))[0];
            const reached = near ? !!findRegionRoute(mask, blockers, near, point, hunterClearance(b.cellSize)) : null;
            doorsteps.push({ label:e.label, point, contained:mask.contains(square), clear:!closedBlockers.some(s=>shapesShareArea(s,square)), reached });
          }
        }
        const outside = doorsteps.find(d=>d.label===e.label)?.point;
        for (const space of trace.allocation.spaces) {
          const reached = !!outside && space.cells.some(c=>findRegionRoute(mask,blockers,outside,
            {x:e.x+(c.x+0.5)*b.cellSize,y:e.y+(c.y+0.5)*b.cellSize},microMetrics({cellSize:b.cellSize,bodyProfile:'cell'}).clearance.contestant));
          rooms.push({label:e.label,space:space.id,reached});
        }
        for (const gate of e.template.parts.filter(p => p.part === 'gate')) {
          // Exterior gates sit on the template perimeter. Interior doors are a separate contestant check.
          const p = { x: e.x + gate.x, y: e.y + gate.y };
          const external = gate.x === 0 || gate.y === 0 || gate.x === e.template.w || gate.y === e.template.h;
          const near = [...stands].sort((a,c) => Math.hypot(a.x-p.x,a.y-p.y)-Math.hypot(c.x-p.x,c.y-p.y))[0];
          const radius = external ? hunterClearance(b.cellSize) : microMetrics({cellSize:b.cellSize,bodyProfile:'cell'}).clearance.contestant;
          const reached = near ? !!findRegionRoute(mask, blockers, near, p, radius) : null;
          doors.push({ label: e.label, point: p, external, reached });
        }
      }
      // Reordering is checked on owning geometry/output; the input brief remains an ordered record.
      const shuffled = build(reorderedBrief(b, 663), mode).result;
      assert.deepEqual([shuffled.elements, shuffled.loot, shuffled.manifest], [r.elements, r.loot, r.manifest], `${w.name}/${mode} reordered`);
      const crossed = r.elements.filter(e => frozen.some(s => shapesOverlap(rect(e.x,e.y,e.template.w,e.template.h),s))).map(e=>e.label);
      row.builds[mode] = { ...v, outputHash: hash(r), fill: measureFill(b,r.elements), doors, doorsteps, rooms, errors, bypassErrors, spacingErrors, crossesFrozenRoute: crossed };
      if (mode !== 'production') assert.deepEqual([...errors, ...bypassErrors, ...spacingErrors, ...doors.filter(d=>d.reached===false), ...doorsteps.filter(d=>d.reached===false||!d.contained||!d.clear), ...rooms.filter(d=>d.reached===false)], [], `${w.name}/${mode} final access`);
    }
    rows.push(row);
  }
  await unchangedSources();
  const report = { audit: 'depot-cord-comparison-1', createdAt: new Date().toISOString(), ...source, inputHash, input, rows,
    limits: 'Production reference is unchanged. Fixed/movable controls share seed, ordering, quota and stronger local two-cell bypass/doorstep rules, and both omit secondary crate infill to isolate primary composition. Candidates can diverge after an admission difference. No child ownership or default content changes. Grid door checks may conservatively miss routes; thorough portal validation independently discovers final geometry paths. Six isolated seeds plus all top-level depots in one authored map per supported size; not exhaustive. Detached replay is intentionally simple and measured, not a proposed production optimization.' };
  await writeFile(resolve(dir, 'results.json.gz'), gzipSync(JSON.stringify(report)));
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ inputHash, maps: input.maps, rows: rows.map(r=>({name:r.name, builds:Object.fromEntries(modes.map(m=>[m,{manifest:r.builds[m].result.manifest, errors:r.builds[m].errors, doorsFailed:r.builds[m].doors.filter(d=>d.reached===false), doorstepsFailed:r.builds[m].doorsteps.filter(d=>d.reached===false||!d.contained||!d.clear), roomsFailed:r.builds[m].rooms.filter(d=>d.reached===false), crossesFrozenRoute:r.builds[m].crossesFrozenRoute, attempts:r.builds[m].diagnostics?.attempts, refusals:r.builds[m].diagnostics?.refusals}]))})) }, null, 2)+'\n');
  const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  function svg(b, v) {
    const size=b.cellSize, xs=b.cells.map(c=>c.x),ys=b.cells.map(c=>c.y), x=Math.min(...xs)*size,y=Math.min(...ys)*size;
    let s=`<svg viewBox="${x-size} ${y-size} ${(Math.max(...xs)+1)*size-x+2*size} ${(Math.max(...ys)+1)*size-y+2*size}">`;
    for(const c of b.cells)s+=`<rect x="${c.x*size}" y="${c.y*size}" width="${size}" height="${size}" fill="#ece8da" stroke="#ccc"/>`;
    for(const sh of protectedRoutes(b,'Depot','nearby')) { if(sh.kind==='rect')s+=`<rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" fill="#d47b72" opacity=".25"/>`; else if(sh.kind==='polygon')s+=`<polygon points="${sh.points.map(p=>`${p.x+sh.x},${p.y+sh.y}`).join(' ')}" fill="#d47b72" opacity=".25"/>`; }
    for(const e of v.result.elements){s+=`<rect x="${e.x}" y="${e.y}" width="${e.template.w}" height="${e.template.h}" fill="${e.label.startsWith('depot-warehouse')?'#bdc6d4':'#8ba78e'}" opacity=".65"/>`;for(const sh of elementShapes(e,true)){
      if(sh.kind==='rect')s+=`<rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" fill="#343b40"/>`;
      else if(sh.kind==='circle')s+=`<circle cx="${sh.x}" cy="${sh.y}" r="${sh.r}" fill="#343b40"/>`;
      else s+=`<polygon points="${sh.points.map(p=>`${p.x+sh.x},${p.y+sh.y}`).join(' ')}" fill="#343b40"/>`;
    }}
    for(const p of b.portals)s+=`<line x1="${p.x*size}" y1="${p.y*size}" x2="${(p.x+(p.axis==='h'?p.length:0))*size}" y2="${(p.y+(p.axis==='v'?p.length:0))*size}" stroke="#bc1d89" stroke-width="8"/>`;
    for(const path of v.diagnostics?.finalWitness.paths??[])s+=`<polyline points="${path.map(p=>`${p.x},${p.y}`).join(' ')}" stroke="#287bb0" stroke-width="3" fill="none"/>`;
    for(const d of v.doors)s+=`<circle cx="${d.point.x}" cy="${d.point.y}" r="7" fill="${d.reached?'#13a13a':'red'}"/>`;
    return s+'</svg>';
  }
  await writeFile(resolve(dir,'index.html'),`<!doctype html><meta charset="utf-8"><title>Depot cord comparison</title><style>body{font:15px system-ui;margin:24px;background:#f7f6f2;color:#252d31}.pair{display:flex;gap:16px}figure{margin:0;flex:1;min-width:0}svg{width:100%;max-height:500px}section{border-top:1px solid #999;padding:16px 0}pre{white-space:pre-wrap}h2{font-size:18px}</style><h1>Depot cord comparison #663</h1><p>Same inputs. Production reference; matched fixed and movable experiments. Warehouses blue-grey, containers green, collision dark, portal seams magenta, doors green/red, frozen route bands pale red, swept proofs blue. Full source/input-bound evidence: results.json.gz. ${esc(report.limits)}</p>${rows.map(r=>`<section><h2>${esc(r.name)}</h2><div class="pair">${modes.map(m=>`<figure><figcaption>${m}: ${r.builds[m].result.manifest.warehouses} warehouses, ${r.builds[m].result.manifest.rows} rows</figcaption>${svg(input.workloads.find(w=>w.name===r.name).brief,r.builds[m])}<pre>${esc(JSON.stringify({crossesFrozenRoute:r.builds[m].crossesFrozenRoute, errors:r.builds[m].errors, failedDoors:r.builds[m].doors.filter(d=>d.reached===false)}))}</pre></figure>`).join('')}</div></section>`).join('')}`);
  console.log(`Retained ${rows.length} paired workloads in ${dir}`);
}
