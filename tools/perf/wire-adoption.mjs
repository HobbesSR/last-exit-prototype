// #1131 stage 2 (42.55): the production descriptor codec (shared/wire-schema.ts) against JSON on a live room's
// own state messages, as the server now sends them. One room on the harness's pregenerated seed-9 arena: a
// contestant, a gladiator, the dev view and a delayed spectator. Bytes come from every state message; encode and
// decode times are Node's, per message, steady frames apart from keyframes. Chrome's decode was measured for
// the same design in 42.54, and tests/wire-codec.browser.mjs keeps Chrome's bytes equal to Node's.
// Usage: node tools/perf/wire-adoption.mjs [--ticks=1200] [--rounds=5] [--min-batch-ms=200] [--out=FILE]
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { roomHarness } from '../../tests/helpers/room-harness.js';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { wireCodec } from '../../shared/wire-schema.ts';
import { WIRE_VERSION } from '../../shared/protocol.ts';
import { DEFAULT_LIVE_ZONE_SIZE, zoneSizeName } from '../../map/live.ts';

const args = cliArgs(), ticks = Number(args.get('ticks') ?? 1200), rounds = Number(args.get('rounds') ?? 5);
const minBatchMs = Number(args.get('min-batch-ms') ?? 200);
const LAYERS = ['items', 'gates', 'bodies', 'tethers'];
const isKeyframe = message => LAYERS.some(layer => message.state[layer] && 'all' in message.state[layer]);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Microseconds per message for `fn` over `list`: batches of at least `minBatchMs`, the median of `rounds`. */
function perMessage(fn, list) {
  if (!list.length) return null;
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    let reps = 1, elapsed = 0;
    for (;;) {
      const start = performance.now();
      for (let r = 0; r < reps; r++) for (const item of list) fn(item);
      elapsed = performance.now() - start;
      if (elapsed >= minBatchMs) break;
      reps *= 2;
    }
    samples.push(elapsed * 1000 / (reps * list.length));
  }
  return median(samples);
}

const lock = await acquireMachineLock('bench', { mode: 'exclusive' });
let report;
try {
  // ---- Corpus: every state message each view was sent, as it went on the wire -----------------------------
  const h = roomHarness({ devTools: 'all', reuseMaps: true }), made = await h.room();
  const peers = { contestant: h.joined(made, { ownerKey: made.ownerKey }), gladiator: h.joined(made, { role: 'gladiator' }) };
  peers.contestant.send({ type: 'start' });
  peers.dev = h.joined(made, { mode: 'dev' }); peers.spectator = h.joined(made, { mode: 'spectator', ownerKey: made.ownerKey });
  try { for (let i = 0; i < ticks; i++) h.wake(50); } finally { await h.service.close(); }

  const codec = wireCodec(), views = {};
  for (const [view, peer] of Object.entries(peers)) {
    assert.deepEqual([...new Set(peer.binary)], ['state'], `${view}: the server sent its state as binary`);
    const messages = peer.rawMessages.filter(m => m.type === 'state' && m.state.phase !== 'waiting');
    const rows = messages.map(message => {
      const text = JSON.stringify(message), bytes = codec.encode(message);
      assert.deepEqual(codec.decode(bytes), JSON.parse(text), `${view} tick ${message.state.tick} decodes as JSON gives it`);
      return { message, text, bytes, keyframe: isKeyframe(message) };
    });
    const summarize = list => {
      const json = list.reduce((sum, r) => sum + Buffer.byteLength(r.text), 0), binary = list.reduce((sum, r) => sum + r.bytes.length, 0);
      const encode = { json: perMessage(r => JSON.stringify(r.message), list), binary: perMessage(r => codec.encode(r.message), list) };
      const decode = { json: perMessage(r => JSON.parse(r.text), list), binary: perMessage(r => codec.decode(r.bytes), list) };
      return {
        messages: list.length, jsonBytes: json, binaryBytes: binary, ratio: list.length ? +(binary / json).toFixed(4) : null,
        meanJsonBytes: list.length ? Math.round(json / list.length) : null, meanBinaryBytes: list.length ? Math.round(binary / list.length) : null,
        encodeUs: encode, decodeUs: decode,
        encodeRatio: encode.json ? +(encode.binary / encode.json).toFixed(3) : null, decodeRatio: decode.json ? +(decode.binary / decode.json).toFixed(3) : null,
      };
    };
    views[view] = { steady: summarize(rows.filter(r => !r.keyframe)), keyframes: summarize(rows.filter(r => r.keyframe)) };
  }
  report = {
    issue: 1131, doc: '42.55', wireVersion: WIRE_VERSION, ticks, rounds, minBatchMs, size: zoneSizeName(DEFAULT_LIVE_ZONE_SIZE), seed: 9,
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain', '--', 'shared', 'server', 'tools/perf/wire-adoption.mjs'], { encoding: 'utf8' }).trim().length > 0,
    node: process.version, cpu: os.cpus()[0]?.model, views,
  };
} finally { await lock.release(); }

const line = (view, kind, s) => `${view.padEnd(10)} ${kind.padEnd(9)} n=${String(s.messages).padStart(4)}  bytes ${String(s.meanJsonBytes).padStart(6)} -> ${String(s.meanBinaryBytes).padStart(6)} (${(s.ratio * 100).toFixed(1)}%)  encode ${s.encodeUs.json?.toFixed(1)} -> ${s.encodeUs.binary?.toFixed(1)} us  decode ${s.decodeUs.json?.toFixed(1)} -> ${s.decodeUs.binary?.toFixed(1)} us`;
for (const [view, { steady, keyframes }] of Object.entries(report.views)) {
  console.log(line(view, 'steady', steady));
  if (keyframes.messages) console.log(line(view, 'keyframes', keyframes));
}
if (args.has('out')) await writeFile(args.get('out'), JSON.stringify(report, null, 2) + '\n');
