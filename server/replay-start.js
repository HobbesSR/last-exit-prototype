import { isDeepStrictEqual } from 'node:util';
import { TICK_RECORDING_SCHEMA } from '../shared/recording.ts';
import { contentById } from '../shared/simulation/content.ts';
import { PHYSICS_VERSION } from '../shared/simulation/physics-runtime.ts';
import { HZ } from '../shared/simulation/rules.ts';
import { BOT_PLANNER_VERSION, createMatch } from './match.js';

const seatCommands = new Set(['join', 'resume', 'choose', 'leave']);

/**
 * Rebuild an already-started match at tick zero from a decoded archive. The caller owns
 * the match and must dispose it. Subsequent ticks require replaying the spent inbound queue.
 */
export async function reconstructReplayStart(archive) {
  if (archive.setup?.items === undefined) throw new RangeError('Missing replay setup.items');
  if (!Array.isArray(archive.setup.items)) throw new RangeError('Invalid replay setup.items');
  if (archive.setup.portalGraph === undefined) throw new RangeError('Missing replay setup.portalGraph');
  if (archive.schema !== TICK_RECORDING_SCHEMA) throw new RangeError(`Unsupported replay schema: ${archive.schema}`);
  if (archive.version !== PHYSICS_VERSION) throw new RangeError(`Unsupported replay rules: ${archive.version}`);
  if (archive.botPlannerVersion !== BOT_PLANNER_VERSION) {
    throw new RangeError(`Unsupported replay bot planner: ${archive.botPlannerVersion}`);
  }
  if (archive.hz !== HZ) throw new RangeError(`Unsupported replay tick rate: ${archive.hz}`);
  if (!Number.isSafeInteger(archive.seed)) throw new RangeError('Missing or invalid replay seed');
  if (!archive.map || !Array.isArray(archive.map.gates) || !Array.isArray(archive.map.traps)) {
    throw new RangeError('Missing or invalid replay map');
  }
  const content = contentById(archive.contentId);
  const first = archive.frames?.[0];
  if (first?.state?.tick !== 0 || first.state.phase !== 'live') throw new RangeError('Missing replay opening frame');
  const { commands } = first;
  if (!Array.isArray(commands) || commands.at(-1)?.type !== 'start' ||
      !commands.slice(0, -1).every(command => seatCommands.has(command?.type))) {
    throw new RangeError('Missing or invalid replay opening roster commands');
  }
  if (!Array.isArray(first.state.players)) throw new RangeError('Missing replay opening roster');
  const measurements = first.state.players.filter(player => player.viewLagTicks !== undefined || player.inputLeadTicks !== undefined);
  const map = structuredClone({ ...archive.map, items: archive.setup.items });
  const match = await createMatch(archive.seed, undefined, map, content, { archivedGraph: archive.setup.portalGraph });
  try {
    match.seat(commands.slice(0, -1));
    match.start({ measurements });
    // Compare in the archive's JSON representation, which omits undefined fields and normalizes -0.
    const rebuilt = JSON.parse(JSON.stringify(match.frame()));
    const fields = new Set([...Object.keys(rebuilt), ...Object.keys(first.state)]);
    for (const field of fields) {
      if (!isDeepStrictEqual(rebuilt[field], first.state[field])) {
        throw new RangeError(`Reconstructed replay opening frame differs at ${field}`);
      }
    }
    return match;
  } catch (error) {
    match.dispose();
    throw error;
  }
}
