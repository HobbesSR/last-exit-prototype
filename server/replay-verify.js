import { isDeepStrictEqual } from 'node:util';
import { botCommandDigest } from './bot-recording.js';
import { reconstructReplayStart } from './replay-start.js';

const spentTypes = new Set(['command', 'observation', 'carried']);
// Compare in the archive's JSON representation, which omits undefined fields and normalizes -0.
const recorded = value => JSON.parse(JSON.stringify(value));

/**
 * Resimulate a decoded archive from tick zero and check each committed tick's `botCommandDigest` (#1284, docs/26
 * "Schema 25"). Each frame's spent command and observation rows go back into the core in recorded order; the core
 * regenerates its carry and the first-class bots' commands. The recorded inbound queue, carry included, is a witness the
 * regenerated one must equal before the digest is compared. Reports the number of ticks checked, or throws a RangeError
 * naming the first tick that cannot be reconstructed or differs. An archive with missing frames is refused: the bots'
 * commands depend on complete history.
 */
export async function verifyBotCommands(archive) {
  if (archive?.recording?.complete === false) throw new RangeError('Replay history has missing frames');
  const match = await reconstructReplayStart(archive);
  try {
    const { frames } = archive;
    let tick = 0, ticks = 0;
    for (let i = 1; i < frames.length; i++) {
      const frame = frames[i], at = frame?.state?.tick;
      // A finish or abandonment adds a last frame at the last tick without advancing; it has no digest.
      if (frame?.botCommandDigest === undefined && at === tick && i === frames.length - 1) break;
      if (at !== tick + 1) throw new RangeError(`Replay history is gapped: tick ${at} follows ${tick}`);
      if (typeof frame.botCommandDigest !== 'string') throw new RangeError(`Missing replay bot command digest at tick ${at}`);
      if (!Array.isArray(frame.commands)) throw new RangeError(`Missing replay commands at tick ${at}`);
      if (!match.replay(frame.commands)) throw new RangeError(`Reconstructed replay ended before tick ${at}`);
      if (!isDeepStrictEqual(recorded(match.spent()), frame.commands.filter(command => spentTypes.has(command?.type)))) {
        throw new RangeError(`Reconstructed replay inbound queue differs at tick ${at}`);
      }
      if (botCommandDigest(match.botCommands()) !== frame.botCommandDigest) {
        throw new RangeError(`Reconstructed replay bot commands differ at tick ${at}`);
      }
      tick = at; ticks++;
    }
    return { ticks };
  } finally {
    match.dispose();
  }
}
