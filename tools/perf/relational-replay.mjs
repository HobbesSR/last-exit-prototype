// Synthetic retained replay load witness. Run with node --expose-gc; --root selects production modules.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (!match) throw new Error(`Expected --name=value: ${arg}`);
  return [match[1], match[2]];
}));
if (!global.gc) throw new Error('Run with node --expose-gc');
const root = resolve(options.root || '.');
const mode = options.mode || 'relational';
if (!['legacy', 'relational'].includes(mode)) throw new Error('mode must be legacy or relational');
const { createReplayTimeline } = await import(pathToFileURL(resolve(root, 'public/replay-timeline.js')).href);
const lock = await acquireMachineLock('bench');
try {
  const items = Array.from({ length: 920 }, (_, i) => ({ id: mode === 'legacy' ? `item:${i + 1}` : i + 1, kind: 'ammo', x: i % 100, y: Math.floor(i / 100), count: 1, family: 'light' }));
  const gates = Array.from({ length: 90 }, (_, i) => ({ gateIdx: i, id: `gate:${i}`, kind: 'door', x: i * 4, y: 30, w: 4, h: 10, open: false, locked: false }));
  const roster = Array.from({ length: 12 }, (_, i) => ({ playerIdx: i, id: `p${i}`, name: `Player ${i}`, role: 'contestant' }));
  let dynamic = gates.map((g, i) => mode === 'legacy' ? g : { gateIdx: i, open: false, locked: false });
  const frames = Array.from({ length: 3500 }, (_, tick) => {
    // The recording reader keeps records and arrays until a delta replaces them.
    if (tick > 0 && tick % 50 === 0) {
      const i = (tick / 50 - 1) % gates.length;
      dynamic = dynamic.slice();
      dynamic[i] = { ...dynamic[i], open: !dynamic[i].open };
    }
    const players = roster.map((p, i) => mode === 'legacy' ? { id: p.id, name: p.name, role: p.role, status: 'active', x: tick + i, y: i } : { ...p, status: 'active' });
    const bodies = roster.map((p, i) => mode === 'legacy' ? { id: `actor:${p.id}`, actorId: p.id, kind: 'actor', x: tick + i, y: i } : { id: i + 1, owner: { kind: 'actor', playerIdx: i }, kind: 'actor', x: tick + i, y: i });
    return { state: { tick, players, bodies, items, gates: dynamic, tethers: [], hookFlights: [] } };
  });
  const recording = { map: { gates }, roster, frames };
  globalThis.replayProbeSource = recording;
  global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now(), cpuStart = process.cpuUsage();
  globalThis.replayProbeRoot = createReplayTimeline(recording);
  const wallMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
  global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const timeline = globalThis.replayProbeRoot;
  if (globalThis.replayProbeSource.frames.length !== 3500 || timeline.frames.length !== 3500 || timeline.at(3499)?.state.tick !== 3499) throw new Error('Unexpected timeline');
  console.log(JSON.stringify({ root, mode, frames: timeline.frames.length, items: items.length, gates: gates.length, players: roster.length,
    wallMs, cpuMs: (cpu.user + cpu.system) / 1000, heapBefore, heapAfter, retainedHeapDelta: heapAfter - heapBefore,
    contention: lock.contention() }, null, 2));
} finally { lock.release(); }
