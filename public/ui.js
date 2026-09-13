import { HZ, KITS } from '/shared/simulation/rules.ts';

// Presentation vocabulary shared by the client modules. Names and abilities come from the
// authoritative kit table rather than a second copy: the client had transcribed them twice, which
// meant a content change had to be made in three places, and carried a third field nothing read.
export const $ = id => document.getElementById(id);
export { HZ };
export const kitName = kit => KITS[kit]?.name ?? kit;
export const kitSkill = kit => KITS[kit]?.skill ?? 'No innate ability';
/** Ticks as mm:ss. The match clock, the replay playhead and the archive all show the same shape. */
export const time = ticks => {
  const seconds = Math.max(0, Math.floor(ticks / HZ));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
