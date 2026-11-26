import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { createGame, disposePhysics } from '../../shared/simulation.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { startGame } from '../../shared/simulation/tick.ts';
import { stepTick } from '../../shared/simulation/tick-step.ts';
import { playerView } from '../../shared/simulation/visibility.ts';
import { checkFrame, checkKnowledge, checkProjection, checkRecords } from '../helpers/tick-frame.js';

// A whole bot match on the new tick's path (27.2 "Node adapter (3d.2)"), on a chain arena stored in the frozen fixture, so no
// map is generated here. The match runs on an in-process session with today's default content to its end. Each tick's
// frame (27.2 "Frames (3d.3)") is held to the snapshot's poses and projected for one player in turn, the frame store's
// records to the snapshot every tenth tick, and the knowledge the core sends with its decisions to its cues every tick and
// to its memory wherever a tick's discovery changed it. The cheap witness is ../tick-adapter.test.js.

const { arenas } = deserialize(gunzipSync(readFileSync(new URL('../fixtures/behavior-physics-1.v8.gz', import.meta.url))));

/** One whole match on arena 9, checked every tick; the count of each fact kind. Run once, shared by the cases below. */
let played;
function play() {
  return played ??= (async () => {
    const arena = arenas[9], map = structuredClone(arena.map);
    attachPortalGraph(map, structuredClone(arena.graph));
    const s = await createGame(9, map, defaultContent());
    try {
      const session = startGame(s), { match, frames, projection } = session, facts = new Map();
      let views = checkProjection(s, session.projection, frames.frame(), 0);
      const words = s.players.map(p => match.ids.actorOfPlayer.get(p.id));
      let t;
      while ((t = stepTick({ s, ...session }))) {
        for (const e of t.changes.events) facts.set(e.fact.kind, (facts.get(e.fact.kind) ?? 0) + 1);
        // Memory is decoded for those the tick's discovery names, and for everyone every hundredth tick and at the end.
        const learned = new Set([...t.discovery.gates, ...t.discovery.samples].map(x => x.actor));
        const whole = t.tick % 100 === 0 || s.phase !== 'live';
        const snap = match.snapshot();
        checkKnowledge(s, match, projection, t.tick, p => whole || learned.has(match.ids.actorOfPlayer.get(p.id)));
        const frame = frames.frame();
        checkFrame(frame, snap, t.tick, words);
        // The frame store's records are folded from the change lists; a drift persists, so every tenth tick catches it.
        if (whole || t.tick % 10 === 0) checkRecords(frames, snap, t.tick);
        // One player's view a tick, in turn: every player is projected hundreds of times over the match.
        const i = t.tick % s.players.length;
        assert.equal(playerView(s, frame, s.players[i].id).self.playerIdx, i);
        // Every player's view from the core's decision equals the TypeScript rules', every tick (#1357).
        views += checkProjection(s, session.projection, frame, t.tick);
      }
      return { phase: s.phase, facts, views };
    } finally { disposePhysics(s); }
  })();
}

test('a whole bot match on the new path keeps its frames and knowledge equal to the match', async () => {
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
