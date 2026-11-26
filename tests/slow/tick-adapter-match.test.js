import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { createGame, disposePhysics } from '../../shared/simulation.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { createTickMatch } from '../../shared/simulation/tick-match.ts';
import { TickMirror } from '../../shared/simulation/tick-mirror.ts';
import { stepMirror } from '../../shared/simulation/tick-step.ts';
import { TickFrames } from '../../shared/simulation/tick-frame.ts';
import { playerView } from '../../shared/simulation/visibility.ts';
import { checkFrame, checkRecords } from '../helpers/tick-frame.js';

// A whole bot match on the new tick's path (27.2 "Node adapter (3d.2)"), on a chain arena stored in the frozen fixture, so no
// map is generated here. The match runs with today's default content to its end, and the mirror the applier keeps is held
// equal to the match's snapshot and cues on every tick, and to its memory wherever a tick's discovery changed it. Each tick's frame (27.2 "Frames (3d.3)") is held to the
// snapshot's poses and projected for one player in turn. The cheap witness is ../tick-adapter.test.js.

const { arenas } = deserialize(gunzipSync(readFileSync(new URL('../fixtures/behavior-physics-1.v8.gz', import.meta.url))));

/** One whole match on arena 9, checked every tick; the count of each fact kind. Run once, shared by the cases below. */
let played;
function play() {
  return played ??= (async () => {
    const arena = arenas[9], map = structuredClone(arena.map);
    attachPortalGraph(map, structuredClone(arena.graph));
    const s = await createGame(9, map, defaultContent());
    let match;
    try {
      match = createTickMatch(s);
      const mirror = new TickMirror(s, match), frames = new TickFrames(s, match), facts = new Map();
      const words = s.players.map(p => match.ids.actorOfPlayer.get(p.id));
      let t;
      while ((t = stepMirror(mirror))) {
        for (const e of t.changes.events) facts.set(e.fact.kind, (facts.get(e.fact.kind) ?? 0) + 1);
        // Memory is decoded for those the tick's discovery names, and for everyone every hundredth tick and at the end.
        const learned = new Set([...t.discovery.gates, ...t.discovery.samples].map(x => x.actor));
        const whole = t.tick % 100 === 0 || s.phase !== 'live';
        const snap = match.snapshot(), expected = mirror.mirrorOf(snap, p => whole || learned.has(match.ids.actorOfPlayer.get(p.id)));
        assert.deepEqual(mirror.view(expected), expected, `tick ${t.tick}`);
        const frame = frames.frame();
        checkFrame(frame, snap, t.tick, words);
        // The frame store's records are folded from the change lists; a drift persists, so every tenth tick catches it.
        if (whole || t.tick % 10 === 0) checkRecords(frames, snap, t.tick);
        // One player's view a tick, in turn: every player is projected hundreds of times over the match.
        const i = t.tick % s.players.length;
        assert.equal(playerView(s, frame, s.players[i].id).self.playerIdx, i);
      }
      return { phase: s.phase, facts };
    } finally { match?.dispose(); disposePhysics(s); }
  })();
}

test('a whole bot match on the new path keeps the mirror equal to the match on every tick', async () => {
  const { phase, facts } = await play();
  // It ran to its end, and the bots played: they picked up loot, charged cells and reached the pods.
  assert.equal(phase, 'finished');
  assert.ok(facts.get('pickup') && facts.get('cellCharged') && facts.get('escaped'), JSON.stringify([...facts]));
});

// The body ceiling leaves most of this arena's loot at its stored spot. Claims read those records (#1301).
test('contestants arm themselves and fire', async () => {
  const { facts } = await play();
  assert.ok(facts.get('shotFired'), JSON.stringify([...facts]));
});
