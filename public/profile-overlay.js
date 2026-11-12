import * as profiler from '/shared/profiler.ts';
import { HZ } from '/ui.js';

// The profiling readout: the P key and `?profile` turn the shared profiler on, and an overlay shows its
// series under a few headline lines. Profiling is opt-in so instrumented hot paths cost nothing during
// normal play. `status` supplies the lines only the application can state (buffer, input, round trip).
export function createProfileOverlay({ toast, status }) {
  let overlay = null;
  function render() {
    if (!profiler.profiling()) { overlay?.remove(); overlay = null; return; }
    if (!overlay) {
      overlay = Object.assign(document.createElement('pre'), { id: 'profile-overlay' });
      overlay.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:60;margin:0;padding:10px 12px;max-height:52vh;overflow:auto;font:11px/1.35 ui-monospace,monospace;color:#d9f2c8;background:rgba(12,26,24,.86);border:1px solid #35564a;border-radius:8px;pointer-events:none;white-space:pre';
      document.body.append(overlay);
    }
    const rows = profiler.report(), find = name => rows.find(r => r.name === name);
    const delta = find('render.delta'), gap = find('net.stateGap'), bytes = find('net.stateBytes');
    const head = [`frames ${profiler.frameCount()}`,
      delta ? `fps ${(1000 / Math.max(0.001, delta.mean)).toFixed(0)} (p95 frame ${delta.p95.toFixed(1)} ms)` : 'fps --',
      gap ? `state gap ${gap.mean.toFixed(1)} ms mean / ${gap.p95.toFixed(1)} p95 (server ${HZ} Hz = ${(1000 / HZ).toFixed(0)} ms)` : 'state gap --',
      bytes ? `state ${(bytes.mean / 1024).toFixed(1)} KiB` : '',
      ...status()].filter(Boolean);
    overlay.textContent = head.join('\n') + '\n' + profiler.format(rows.filter(r => r !== delta && r !== gap && r !== bytes));
  }
  function setProfiling(value) {
    profiler.enable(value);
    render();
    toast(value ? 'Profiling on. Press P to stop.' : 'Profiling off.');
  }
  setInterval(render, 500);
  addEventListener('keydown', e => { if (e.key === 'p' || e.key === 'P') if (!e.target.closest('input, textarea')) setProfiling(!profiler.profiling()); });
  if (new URLSearchParams(location.search).has('profile')) profiler.enable(true);
  return { setProfiling };
}
