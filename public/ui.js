import { HZ, INTERPOLATION_DELAY_TICKS, KITS } from '/shared/simulation/rules.ts';

// Presentation vocabulary shared by the client modules. Names and abilities come from the
// authoritative kit table rather than a second copy: the client had transcribed them twice, which
// meant a content change had to be made in three places, and carried a third field nothing read.
export const $ = id => document.getElementById(id);
export { HZ, INTERPOLATION_DELAY_TICKS };
export const kitName = kit => KITS[kit]?.name ?? kit;
export const kitSkill = kit => KITS[kit]?.skill ?? 'No innate ability';
/** Ticks as mm:ss. The match clock, the replay playhead and the archive all show the same shape. */
export const time = ticks => {
  const seconds = Math.max(0, Math.floor(ticks / HZ));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
/** Fill a camera-focus select: the whole arena, then the roster grouped by role. Replay and dev view share it. */
export function fillFollowOptions(select, roster = []) {
  const whole = document.createElement('option'); whole.value = ''; whole.textContent = 'Whole arena';
  const groups = [['contestant', 'Contestants'], ['gladiator', 'Gladiators']].map(([role, label]) => {
    const group = document.createElement('optgroup'); group.label = label;
    for (const player of roster.filter(p => p.role === role)) {
      const option = document.createElement('option'); option.value = player.id;
      option.textContent = player.role === 'gladiator' ? `${player.name} / ${kitName(player.kit)}` : player.name;
      group.append(option);
    }
    return group;
  }).filter(group => group.childElementCount);
  select.replaceChildren(whole, ...groups);
}
