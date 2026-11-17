// Feature tests consume the same hydrated view as the browser. Wire-contract tests
// import playerView directly and assert the compact relational records themselves.
import { playerView } from '../../shared/simulation.ts';
import { seatMetadata } from '../../shared/simulation/relations.ts';
import { createFrameNormalizer } from '../../shared/relational-frame.ts';
export function renderedPlayerView(game, frame, id) {
  return createFrameNormalizer(game.map, seatMetadata(frame)).normalize(playerView(game, frame, id));
}
export function renderedSnapshot(map, frame) {
  return createFrameNormalizer(map).normalize(frame);
}
