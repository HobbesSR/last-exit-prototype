import type { HeardCue, Player, Tick } from '../types.ts';

// Heard gunfire (#684, 14 "Heard gunfire", 15). A shot reveals an area, not an actor: each hearer learns the
// centre of the discovery cell the shooter stood in, which passes walls and roofs and fades after the
// content's `hearing.ticks`. The core records the cues (`rust/core/src/tick/hearing.rs`); this reads what a player holds.

/** The cues `p` still hears at `tick`, oldest first. */
export function heardBy(p: Pick<Player, 'heard'>, tick: Tick): HeardCue[] {
  return p.heard?.filter(cue => cue.until > tick) ?? [];
}
