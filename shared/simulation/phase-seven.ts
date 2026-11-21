import { PLAYER_STATUSES } from '../enum-tables.ts';
import type { Game } from '../types.ts';
import { event } from './event-records.ts';
import type { ActionsCore } from './phase-three.ts';
import { physicsRuntime } from './physics-runtime.ts';

// Phase 7's rules run in the core (`rust/core/src/phase_seven.rs`, #1245, docs/27 "The state flip", step 5e.2): `finishMatch`
// and `recordRewind`. The body syncs and discovery around them were already the core's. The match's phase, the stranded
// statuses and the `match_finished` event stay Node's records until the flip (#1214), so `finishMatch` reports and this
// writes. The rewind frames are the core's own: phase 5's casters read them there.
interface SevenExports {
  phase_seven_input(world: number, words: number): number;
  phase_seven_run(world: number): number;
}
type Core = ActionsCore & SevenExports;
const MODE_FINISH = 0, MODE_REWIND = 1, HEADER = 6, OUT_HEADER = 4;

function call(s: Game, data: number[]): Float64Array {
  const r = physicsRuntime(s);
  if (!r) throw new Error("phase 7 needs the game's physics world");
  const native = r.world.boundaryCall(), core = native.core as Core, world = native.world;
  const ptr = core.phase_seven_input(world, data.length) >>> 0;
  new Float64Array(core.memory.buffer, ptr, data.length).set(data);
  const outPtr = core.phase_seven_run(world) >>> 0;
  return new Float64Array(core.memory.buffer, outPtr, new Float64Array(core.memory.buffer, outPtr, 1)[0]!).slice();
}

/** `finishMatch`: on no slots left, no contestant active or the match's time up, finish and strand the active contestants. */
export function finishMatch(s: Game): void {
  const data = [MODE_FINISH, s.tick, s.serial, s.players.length, s.slots, s.content.durationTicks];
  for (const p of s.players) data.push(p.role === 'contestant' ? 0 : 1, PLAYER_STATUSES.indexOf(p.status));
  const out = call(s, data);
  if (!out[1]) return;
  s.phase = 'finished';
  for (let i = 0; i < out[3]!; i++) s.players[out[OUT_HEADER + i]!]!.status = 'stranded';
  s.serial = out[2]!;
  event(s, { kind: 'match_finished' });
}

/** `recordRewind`: where everyone finished this tick, the state the snapshot carries, kept in the core for phase 5's casters. */
export function recordRewind(s: Game): void {
  const data = new Array<number>(HEADER + s.players.length * 2);
  data[0] = MODE_REWIND; data[1] = s.tick; data[2] = s.serial; data[3] = s.players.length; data[4] = 0; data[5] = 0;
  s.players.forEach((p, i) => { data[HEADER + i * 2] = p.x; data[HEADER + i * 2 + 1] = p.y; });
  call(s, data);
}
