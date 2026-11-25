// #1344: an end-to-end witness that a replay gives a rejoined seat's bot the live label. A seat relabel (a late join)
// gives the seat's bot a new lexical rank and a new temperament: `botLabel` in `shared/simulation/tick-match.ts`, where a
// label whose last character code is a multiple of three is opportunistic. An opportunistic contestant follows heard
// gunfire and, after tick 600, goes for nearby contestants; a cautious one avoids the gunfire (`rust/core/src/tick/bots.rs`).
// So the witness needs a seat whose new label changes its temperament, handed back to its bot, in a match long enough
// with gunfire for that to decide something.
//
// It plays a room on the stored room arena (seed 9, tests/fixtures README) with the shipped content. Contestants join
// late, each staying connected so the next takes another seat, until `CHANGED` seats have a joined label whose temperament
// differs from the seat's original label. Then all of them disconnect, so each seat's bot plays on under its joined label. The match runs `TICKS` ticks, the owner
// finishes it, and the recording is resimulated twice with `verifyBotCommands` (`server/replay-verify.js`):
// - as recorded, which must verify every committed tick;
// - with `labels: false`, which replays the relabels without their ranks, which must fail at the first tick a
//   label-dependent decision diverges.
// It exits non-zero unless both hold. Not part of any test tier or CI (Corey, 2026-11-25): run it by hand after a change
// to the bot planner's use of labels, to the relabel path in `server/match.js`, or to `inboundOfRecorded`.
// Usage: node tools/bot-label-witness.mjs [--ticks=1500] [--changed=2]
// Joined labels are random, so each run finds different seats; three runs at its introduction verified about 1,500 ticks
// as recorded and diverged without labels at ticks 635, 662 and 662, in about 10 s each (#1344).
import { roomHarness, generatedMap } from '../tests/helpers/room-harness.js';
import { verifyBotCommands } from '../server/replay-verify.js';
import { botLabel } from '../shared/simulation/tick-match.ts';
import { defaultContent } from '../shared/simulation/content.ts';

const option = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const TICKS = option('ticks', 1500), CHANGED = option('changed', 2), MAX_JOINS = 12;
const opportunistic = id => botLabel([], id).opportunistic;

const content = defaultContent();
const h = roomHarness({ content: () => content, generateMap: seed => generatedMap(seed) });
const started = performance.now();
let failed = false;
try {
  const room = await h.created(9), owner = h.joined(room, { ownerKey: room.ownerKey, role: 'gladiator' });
  owner.send({ type: 'start' });
  const writer = h.writers.get(room.id);
  const run = ms => { for (let elapsed = 0; elapsed < ms; elapsed += 50) h.wake(50); };
  run(500);
  // Without its label, a seat's bot keeps the temperament of the seat's original label, so that is what a join must change.
  const original = room.match.frame().players.map(p => p.id);
  const changed = [], joiners = [];
  // Joiners stay connected until the last join, so each takes the next open contestant seat.
  for (let joins = 0; changed.length < CHANGED && joins < MAX_JOINS; joins++) {
    const joined = h.joined(room, { role: 'contestant', name: `Witness ${joins}` });
    const welcome = joined.messages.find(m => m.type === 'welcome');
    if (!welcome?.id || room.match.frame().players[welcome.state.self.playerIdx]?.role !== 'contestant') { console.log(`join ${joins}: no contestant seat open`); break; }
    joiners.push(joined);
    const slot = welcome.state.self.playerIdx, previous = original[slot], id = welcome.id;
    const turned = opportunistic(previous) !== opportunistic(id);
    const temperament = label => opportunistic(label) ? 'opportunistic' : 'cautious';
    console.log(`join ${joins}: seat ${slot} ${previous} (${temperament(previous)}) -> ${id} (${temperament(id)})${turned ? ', temperament changed' : ''}`);
    if (turned) changed.push({ slot, previous, id });
    run(50);
  }
  run(200);
  for (const joined of joiners) h.service.disconnect(joined.session);
  if (changed.length < CHANGED) throw new Error(`only ${changed.length} of ${CHANGED} joins changed a seat's temperament`);
  while (room.match.tick < TICKS && room.match.frame().phase === 'live') run(1000);
  console.log(`played to tick ${room.match.tick}`);
  owner.send({ type: 'finish' });
  await room.finalization;
  const archive = JSON.parse(JSON.stringify({ ...writer.header, frames: writer.frames }));

  const verified = await verifyBotCommands(archive);
  console.log(`as recorded: ${verified.ticks} committed ticks verify`);
  try {
    const unlabelled = await verifyBotCommands(archive, { labels: false });
    failed = true;
    console.log(`without labels: ${unlabelled.ticks} ticks still verify, so no bot decision depended on a label; witness FAILED`);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    console.log(`without labels: refused as expected: ${error.message}`);
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await h.service.close();
}
console.log(`${failed ? 'FAILED' : 'witness holds'} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exitCode = failed ? 1 : 0;
