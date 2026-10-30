import { cellCenter, cellIndexAt } from '../discovery.ts';
import type { Game, HeardCue, Player, Tick, WeaponType } from '../types.ts';

// Heard gunfire (#684, 14 "Heard gunfire", 15). A shot reveals an area, not an actor: each hearer learns the
// centre of the discovery cell the shooter stood in, which passes walls and roofs and fades after the
// content's `hearing.ticks`. It draws no RNG and takes no id, so a content without `hearing` runs as before.

/** The cues a player holds, attached like discovery: non-enumerable, so snapshots and recordings never carry them. */
function cuesOf(p: Player): HeardCue[] {
  if (!p.heard) Object.defineProperty(p, 'heard', { value: [], writable: true, configurable: true, enumerable: false });
  return p.heard!;
}

/** Tell every other active player within the weapon's hearing range that `shooter` fired from its cell. */
export function hearShot(s: Game, shooter: Player, weapon: WeaponType): void {
  const range = s.content.hearing?.ranges[weapon];
  if (!range) return;
  const cell = cellIndexAt(s.map, shooter.x, shooter.y);
  if (cell === -1) return;
  const at = cellCenter(s.map, cell), until = s.tick + s.content.hearing!.ticks, reach = range * range;
  for (const hearer of s.players) {
    if (hearer === shooter || hearer.status !== 'active') continue;
    const dx = hearer.x - shooter.x, dy = hearer.y - shooter.y;
    if (dx * dx + dy * dy >= reach) continue;
    // One cue per cell: a repeat refreshes it and moves it last, so the newest is always at the end.
    const cues = cuesOf(hearer).filter(cue => cue.until > s.tick && (cue.x !== at.x || cue.y !== at.y));
    cues.push({ x: at.x, y: at.y, tick: s.tick, until });
    hearer.heard = cues;
  }
}

/** The cues `p` still hears at `tick`, oldest first. */
export function heardBy(p: Pick<Player, 'heard'>, tick: Tick): HeardCue[] {
  return p.heard?.filter(cue => cue.until > tick) ?? [];
}
