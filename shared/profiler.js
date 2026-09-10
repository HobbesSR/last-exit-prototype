// Accumulating sampling profiler shared by the server loop, the headless bench, and the client.
// Off by default: every hook returns before reading the clock, so instrumentation can live in hot
// paths without taxing normal play. Coarse phases are timed and leaf calls are only counted, because
// a performance.now() pair around lineClear would cost more than the work it is meant to measure.
//
// Two scopes, because averaging them the same way lies. Frame series (start/stop, count) accumulate
// within a frame and bank one sample per frame, including the frames they sat idle. Event series
// (observe) bank one sample per occurrence, so a gap between arriving packets is not diluted by the
// render frames that happened to pass in between.
const WINDOW = 600; // Samples retained per series: 30 s of server ticks at 20 Hz.
let on = false, frames = 0;
const open = new Map(), pending = new Map(), pendingCalls = new Map(), series = new Map();
const clock = () => performance.now();
function track(name, unit, scope) {
  let s = series.get(name);
  if (!s) series.set(name, s = { name, unit, scope, values: [], callSamples: [], calls: 0 });
  return s;
}
function push(s, value) { s.values.push(value); if (s.values.length > WINDOW) s.values.shift(); }
export const profiling = () => on;
export const frameCount = () => frames;
export function enable(value = true) { if (!value) reset(); on = !!value; return on; }
export function reset() { open.clear(); pending.clear(); pendingCalls.clear(); series.clear(); frames = 0; }
export function start(name) { if (on) open.set(name, clock()); }
export function stop(name) {
  if (!on) return;
  const started = open.get(name);
  if (started === undefined) return;
  open.delete(name); track(name, 'ms', 'frame').calls++;
  pendingCalls.set(name, (pendingCalls.get(name) || 0) + 1);
  pending.set(name, (pending.get(name) ?? 0) + (clock() - started));
}
export function count(name, amount = 1) {
  if (!on) return;
  track(name, 'n', 'frame');
  pending.set(name, (pending.get(name) ?? 0) + amount);
}
export function observe(name, value, unit = 'ms') { if (on) { const s = track(name, unit, 'event'); s.calls++; push(s, value); } }
export function frame() {
  if (!on) return;
  frames++;
  for (const s of series.values()) if (s.scope === 'frame') {
    push(s, pending.get(s.name) ?? 0);
    s.callSamples.push(pendingCalls.get(s.name) || 0);
    if (s.callSamples.length > WINDOW) s.callSamples.shift();
  }
  pending.clear(); pendingCalls.clear(); open.clear();
}
export function report() {
  return [...series.values()].map(s => {
    const sorted = [...s.values].sort((a, b) => a - b), n = sorted.length || 1;
    const at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
    return { name: s.name, unit: s.unit, scope: s.scope, samples: sorted.length, calls: s.scope === 'event' ? s.calls : s.callSamples.reduce((a, b) => a + b, 0) / n,
      mean: sorted.reduce((a, b) => a + b, 0) / n, p50: at(0.5), p95: at(0.95), max: sorted.length ? sorted[sorted.length - 1] : 0 };
  }).sort((a, b) => b.mean - a.mean);
}
export function format(rows = report()) {
  const groups = [['frame', 'ms', 'per frame, milliseconds'], ['frame', 'n', 'per frame, counts'], ['event', 'ms', 'per event, milliseconds'], ['event', 'n', 'per event, counts']];
  const round = (v, unit) => unit === 'ms' ? v.toFixed(3) : Math.round(v).toString();
  return groups.flatMap(([scope, unit, label]) => {
    const group = rows.filter(r => r.scope === scope && r.unit === unit);
    if (!group.length) return [];
    const head = ['series', 'mean', 'p50', 'p95', 'max', scope === 'event' ? 'events' : 'calls'];
    const table = group.map(r => [r.name, round(r.mean, unit), round(r.p50, unit), round(r.p95, unit), round(r.max, unit),
      scope === 'event' ? String(r.calls) : unit === 'ms' ? r.calls.toFixed(1) : '']);
    const width = head.map((h, i) => Math.max(h.length, ...table.map(row => row[i].length)));
    const line = row => row.map((cell, i) => i ? cell.padStart(width[i]) : cell.padEnd(width[0])).join('  ');
    return ['', label, line(head), width.map(w => '-'.repeat(w)).join('  '), ...table.map(line)];
  }).join('\n');
}
