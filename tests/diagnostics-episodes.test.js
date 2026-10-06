import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = [];
globalThis.document = { hidden: false, addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); } };
const setHidden = hidden => { document.hidden = hidden; listeners.forEach(fn => fn()); };
const { noteFrame, notePacket, reportDiagnostics, manualMark, resetDiagnostics } = await import('../public/diagnostics.js');

const withClock = run => {
  const real = performance.now; let now = 1000;
  performance.now = () => now;
  try { run(ms => { now += ms; }); } finally { performance.now = real; }
};

test('a run of long frames is one episode, closed by a quiet stretch, with the ticks it spanned', () => {
  withClock(advance => {
    const reports = []; let tick = 100;
    reportDiagnostics(() => tick, report => reports.push(report)); resetDiagnostics();
    noteFrame();
    for (const ms of [80, 120, 60]) { advance(ms); tick += 2; noteFrame(); }
    assert.deepEqual(reports, [], 'still open while the stretch could continue');
    for (let i = 0; i < 30; i++) { advance(16); tick++; noteFrame(); }
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0], { kind: 'frame-drop', tick: 106, startTick: 102, count: 3, worstMs: 120 });
  });
});

test('a hidden tab closes the episode instead of reporting the time away', () => {
  withClock(advance => {
    const reports = [];
    reportDiagnostics(() => 5, report => reports.push(report)); resetDiagnostics();
    noteFrame(); advance(90); noteFrame();
    document.hidden = true; noteFrame(); document.hidden = false;
    assert.equal(reports.length, 1);
    noteFrame(); advance(16); noteFrame();
    assert.equal(reports.length, 1);
  });
});

test('packet gaps report on their own and a manual mark needs a tick to name', () => {
  withClock(advance => {
    const reports = []; let tick = 40;
    reportDiagnostics(() => tick, report => reports.push(report)); resetDiagnostics();
    notePacket(10); advance(300); notePacket(10);
    for (let i = 0; i < 30; i++) { advance(50); notePacket(10); }
    assert.deepEqual(reports.map(r => [r.kind, r.count, r.worstMs]), [['packet-gap', 1, 300]]);
    assert.equal(manualMark(), true); assert.deepEqual(reports.at(-1), { kind: 'manual', tick: 40 });
    tick = null; assert.equal(manualMark(), false);
  });
});

test('returning to a tab whose frames stopped while hidden reports nothing for the time away', () => {
  withClock(advance => {
    const reports = [];
    reportDiagnostics(() => 5, report => reports.push(report)); resetDiagnostics();
    noteFrame(); advance(16); noteFrame(); notePacket(10);
    setHidden(true); advance(10000); setHidden(false);
    noteFrame(); notePacket(10);
    for (let i = 0; i < 30; i++) { advance(16); noteFrame(); advance(50); notePacket(10); }
    assert.deepEqual(reports, []);
  });
});
