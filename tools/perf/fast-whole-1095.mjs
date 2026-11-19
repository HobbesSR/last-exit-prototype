// #1095 (24.5 stage 3): how large is a live player's whole fast frame on a generated map, against the edge's
// 1,100-byte fragment? Recovery and joins send one: a session that has acknowledged nothing the history still holds
// gets whole frames until it does (24.5 "Delivery"). 42.59 measured only one eliminated view's (176 B), and 24.2's
// 0.66–2.4 KB was an estimate.
//
// A room of the shipped content on a generated map, every seat played by a bot, run on the fake clock as
// tests/helpers/room-sizes.js runs it. Each tick, for every seat's player view, as `deliverSplit` would build it:
// - **whole:** the `fast` message of its fast part through that view's 32-tick event window;
// - **delta:** the same against the previous tick's frame, the steady case on a clean path.
// Sizes are the encoded message's bytes, before the edge's 4-byte fragment headers. A view that is waiting or has
// no fast part yet is skipped. Bytes only: no clock, so it takes no machine lock.
//
// Usage: node tools/perf/fast-whole-1095.mjs [--sizes=12x6,24x12] [--seed=9] [--ticks=N] [--out=FILE]
// `--ticks` stops early; by default the match plays to its end. 36x18 takes several minutes of one core.
import { writeFile } from 'node:fs/promises';
import { cliArgs } from '../../tests/helpers/args.js';
import { roomHarness } from '../../tests/helpers/room-harness.js';
import { LIVE_ZONE_SIZES, zoneSizeName } from '../../map/live.ts';
import { TICK_MS } from '../../server/scheduler.js';
import { fastMessage } from '../../shared/protocol.ts';
import { wireCodec } from '../../shared/wire-schema.ts';
import { against } from '../../shared/wire-codec.ts';
import { createEventWindow, fastFrame, DATAGRAM_PAYLOAD_BYTES, MAX_FAST_DATAGRAM_BYTES } from '../../shared/fast-state.ts';

const args = cliArgs();
const wanted = (args.get('sizes') ?? '12x6,24x12').split(',');
const seed = Number(args.get('seed') ?? 9), tickLimit = args.has('ticks') ? Number(args.get('ticks')) : Infinity;
const codec = wireCodec();

const summarize = list => {
  const sorted = [...list].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    samples: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1),
    overOneFragment: sorted.filter(n => n > DATAGRAM_PAYLOAD_BYTES).length,
    overFour: sorted.filter(n => n > MAX_FAST_DATAGRAM_BYTES).length,
  };
};

async function measure(size) {
  // A writer that keeps nothing, as tests/helpers/room-sizes.js's: the default keeps every frame, which a 36x18 match exhausts.
  const h = roomHarness({ startWriter: head => ({ append() {}, mark() { return true; }, async finish(result) { return { id: head.id, ...result }; } }) });
  const whole = [], delta = [], wholeByPhase = { live: [], finished: [] };
  let largest = null, ticks = 0;
  try {
    const created = h.service.makeRoom(seed, false, size), room = h.service.rooms.get(created.id);
    const owner = h.joined(created, { ownerKey: created.ownerKey });
    await created.ready;
    owner.send({ type: 'start' });
    h.joined(room, { mode: 'spectator', ownerKey: room.ownerKey });
    h.service.disconnect(owner.session);
    const windows = new Map(), previous = new Map();
    const limit = Math.min(room.content.durationTicks, tickLimit);
    for (; ticks <= limit && !room.finished; ticks++) {
      h.wake(TICK_MS);
      const frame = room.match.snapshot();
      for (const player of room.game.players) {
        const view = room.match.project(frame, player.id);
        if (!view || view.phase === 'waiting') continue;
        let window = windows.get(player.id);
        if (!window) windows.set(player.id, window = createEventWindow());
        const fast = window(fastFrame(view));
        const message = state => codec.encode(fastMessage({ rosterRevision: 1, slowVersion: 1, state })).length;
        const bytes = message(fast);
        whole.push(bytes);
        (wholeByPhase[fast.phase] ??= []).push(bytes);
        if (!largest || bytes > largest.bytes) {
          largest = { bytes, tick: fast.tick, player: player.id, bot: !!player.bot, bodies: fast.bodies?.length ?? 0, players: fast.players?.length ?? 0, events: fast.events?.length ?? 0 };
        }
        const before = previous.get(player.id);
        if (before && before.tick < fast.tick) delta.push(message(against(before.tick, before, fast)));
        previous.set(player.id, fast);
      }
    }
    return {
      size: zoneSizeName(size), seed, ticks, seats: room.game.players.length,
      whole: summarize(whole), delta: summarize(delta),
      wholeByPhase: Object.fromEntries(Object.entries(wholeByPhase).filter(([, l]) => l.length).map(([k, l]) => [k, summarize(l)])),
      largest,
    };
  } finally { await h.service.close(); }
}

const results = [];
for (const size of LIVE_ZONE_SIZES.filter(s => wanted.includes(zoneSizeName(s)))) {
  const started = Date.now();
  const result = await measure(size);
  result.seconds = Math.round((Date.now() - started) / 1000);
  results.push(result);
  console.log(JSON.stringify(result));
}
const out = args.get('out');
if (out) await writeFile(out, JSON.stringify({ date: new Date().toISOString().slice(0, 10), fragment: DATAGRAM_PAYLOAD_BYTES, limit: MAX_FAST_DATAGRAM_BYTES, results }, null, 2));
