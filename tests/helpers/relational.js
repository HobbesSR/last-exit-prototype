// Feature tests consume the same hydrated view as the browser. Wire-contract tests
// import playerView directly and assert the compact relational records themselves.
import { playerView } from '../../shared/simulation.ts';
import { seatMetadata } from '../../shared/simulation/relations.ts';
import { createFrameNormalizer } from '../../shared/relational-frame.ts';
import { predictionConstants } from '../../shared/simulation/physics-presentation.ts';
/** A view as the browser renders it: its welcome's roster, map and match constants joined in (24.3 proposal 3). */
export function renderedPlayerView(game, frame, id) {
  const frames = createFrameNormalizer();
  frames.envelope({ roster: seatMetadata(frame), map: game.map, constants: predictionConstants(game.version, game.content.actorPhysics) });
  return frames.normalize(playerView(game, frame, id));
}
export function renderedSnapshot(map, frame) {
  return createFrameNormalizer(map).normalize(frame);
}
