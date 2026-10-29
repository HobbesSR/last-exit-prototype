// Reads a directory of tests/bench-stages.mjs --out files and prints the stage tables, ladder exponents, over-budget
// classification, views/rooms and memory of 42.22 (#637). Usage: node tools/perf/stage-report.mjs <dir> [summary.json.gz]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
const dir = process.argv[2], summaryOut = process.argv[3];
const runs = {};
for (const file of (await readdir(dir)).filter(f => f.endsWith('.json'))) runs[file.slice(0, -5)] = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
const STAGES = ['sim.bots', 'sim.repath', 'sim.move', 'sim.solve', 'sim.poses', 'sim.sync', 'sim.itemSync', 'sim.actions', 'sim.pickups', 'sim.projectiles',
  'sim.environment', 'sim.discovery', 'sim.rewind', 'step.other', 'sim.snapshot.world', 'sim.snapshot.presentation', 'sim.snapshot.clone',
  'sim.playerView', 'loop.encode', 'loop.serialize', 'loop.record', 'loop.remember', 'untimed'];
const STEP_CHILDREN = ['sim.bots', 'sim.move', 'sim.solve', 'sim.poses', 'sim.sync', 'sim.actions', 'sim.pickups', 'sim.projectiles', 'sim.environment', 'sim.discovery', 'sim.rewind'];
const pct = (v, q) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = v => v.reduce((a, b) => a + b, 0) / (v.length || 1);
function stageSeries(run, name) {
  const { series, untimed } = run.raw;
  if (name === 'untimed') return untimed;
  if (name === 'step.other') return series['sim.step'].map((t, i) => t - STEP_CHILDREN.reduce((s, c) => s + (series[c]?.[i] ?? 0), 0));
  return series[name];
}
function table(run) {
  const tickMean = run.tick.mean;
  return Object.fromEntries(STAGES.filter(n => n === 'untimed' || n === 'step.other' || run.raw.series[n]).map(n => {
    const v = stageSeries(run, n); return [n, { mean: mean(v), p99: pct(v, 0.99), share: mean(v) / tickMean }];
  }));
}
const f = v => v === undefined ? '-' : v.toFixed(2);
const summary = {};
for (const [name, run] of Object.entries(runs).sort()) {
  summary[name] = { meta: run.meta, tick: run.tick, stages: table(run), over: run.over, gc: run.gc, memory: run.memory, recorder: run.recorder };
  if (!run.recorder) throw new Error(`${name} predates recorder draining; rerun it`);
  if (run.recorder.droppedFrames.some(Boolean)) throw new Error(`${name} dropped recorder frames`);
}
// 1. Stage tables, real sizes whole match (r1 for physics) and averaged over physics repeats.
const show = (names) => {
  console.log(`| Stage | ${names.join(' | ')} |`); console.log(`| --- | ${names.map(() => '---:').join(' | ')} |`);
  console.log(`| tick mean / p99 | ${names.map(n => `${f(summary[n].tick.mean)} / ${f(summary[n].tick.p99)}`).join(' | ')} |`);
  for (const s of STAGES) {
    if (!names.some(n => summary[n].stages[s])) continue;
    console.log(`| ${s} | ${names.map(n => { const r = summary[n].stages[s]; return r ? `${f(r.mean)} / ${f(r.p99)} (${(r.share * 100).toFixed(0)}%)` : '-'; }).join(' | ')} |`);
  }
};
const present = names => names.filter(n => summary[n]);
console.log('\n## Real sizes, whole match'); show(present(['real-12x6-legacy', 'real-12x6-physics-r1', 'real-24x12-legacy', 'real-24x12-physics-r1', 'real-36x18-legacy', 'real-36x18-physics-r1']));
console.log('\n## Repeats (tick mean / p99 / max / over)');
for (const n of Object.keys(summary).filter(n => n.startsWith('real-'))) console.log(`${n}: ${f(summary[n].tick.mean)} / ${f(summary[n].tick.p99)} / ${f(summary[n].tick.max)} / ${summary[n].tick.over} of ${summary[n].meta.ticks}; gc ${summary[n].gc.count} ${f(summary[n].gc.ms)} ms max ${f(summary[n].gc.max)}; recorder drain mean ${f(summary[n].recorder?.drainMs.mean)} max ${f(summary[n].recorder?.drainMs.max)} ms, dropped ${summary[n].recorder?.droppedFrames.join("/")}`);
// 2. Exponents along the constant-density ladder, against items.
const fit = points => { const xs = points.map(p => Math.log(p[0])), ys = points.map(p => Math.log(Math.max(p[1], 1e-4))); const mx = mean(xs), my = mean(ys);
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0); };
for (const engine of ['legacy', 'physics']) {
  const ladder = Object.keys(summary).filter(n => n.startsWith('ladder-') && n.endsWith(engine)).sort((a, b) => summary[a].meta.items[0] - summary[b].meta.items[0]);
  if (!ladder.length) continue;
  console.log(`\n## Ladder ${engine} (first 1200 ticks): mean ms by items; exponent vs items`);
  console.log(`| Stage | ${ladder.map(n => `${summary[n].meta.size.split(' ')[0]} (${summary[n].meta.items[0]})`).join(' | ')} | exponent |`);
  console.log(`| --- | ${ladder.map(() => '---:').join(' | ')} | ---: |`);
  for (const s of ['tick', ...STAGES]) {
    const vals = ladder.map(n => s === 'tick' ? summary[n].tick.mean : summary[n].stages[s]?.mean);
    if (vals.every(v => v === undefined)) continue;
    const pts = ladder.map((n, i) => [summary[n].meta.items[0], vals[i]]).filter(p => p[1] !== undefined);
    const tail = pts.length >= 3 ? fit(pts.slice(1)) : NaN;
    console.log(`| ${s} | ${vals.map(f).join(' | ')} | ${fit(pts).toFixed(2)} (from 2nd: ${tail.toFixed(2)}) |`);
  }
}
// 3. Over-budget ticks, every run.
console.log('\n## Over 50 ms');
for (const [n, s] of Object.entries(summary)) {
  if (!s.over.length) continue;
  const ticks = s.over.map(o => o.tick);
  const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
  const byStage = {};
  for (const o of s.over) { const top = o.largest[0][0]; byStage[top] = (byStage[top] ?? 0) + 1; }
  const rekeyed = s.over.filter(o => Object.keys(o.rekeys).length).length, gcd = s.over.filter(o => o.gcMs > 5).length;
  console.log(`${n}: ${s.over.length} ticks; largest stage ${JSON.stringify(byStage)}; with rekey ${rekeyed}; gc>5ms ${gcd}; ticks ${ticks.slice(0, 40).join(',')}${ticks.length > 40 ? '…' : ''}; gaps median ${pct(gaps, 0.5) ?? '-'}`);
  for (const o of s.over.slice(0, 6)) console.log(`   tick ${o.tick} ${o.ms.toFixed(1)}: ${o.largest.map(([a, b]) => `${a} ${b.toFixed(1)}`).join(', ')} gc ${o.gcMs.toFixed(1)} ${JSON.stringify(o.rekeys)}`);
}
// 4. Views and rooms.
console.log('\n## Views and rooms');
for (const n of Object.keys(summary).filter(n => /^(views|rooms|early)-/.test(n))) {
  const s = summary[n];
  console.log(`${n}: rooms ${s.meta.rooms} clients ${s.meta.clients}+${s.meta.spectators}; tick ${f(s.tick.mean)}/${f(s.tick.p99)}/${f(s.tick.max)} over ${s.tick.over}/${s.meta.ticks}; playerView ${f(s.stages['sim.playerView']?.mean)} encode ${f(s.stages['loop.encode']?.mean)} serialize ${f(s.stages['loop.serialize']?.mean)} record ${f(s.stages['loop.record']?.mean)} snapshot.clone ${f(s.stages['sim.snapshot.clone']?.mean)}`);
}
console.log('\n## Memory');
for (const [n, s] of Object.entries(summary)) console.log(`${n}: state ${s.memory.stateBytes.map(b => (b / 1024).toFixed(0)).join('/')} KiB, history ${s.memory.historyBytes.map(b => (b / 2 ** 20).toFixed(1)).join('/')} MiB, heap last ${f(s.memory.samples.at(-1)?.heapMB)} MiB max ${f(Math.max(...s.memory.samples.map(m => m.heapMB)))}`);
if (summaryOut) await writeFile(summaryOut, zlib.gzipSync(JSON.stringify(summary)));
