import { DEFAULT_KIT, HZ, INTERPOLATION_DELAY_TICKS } from '/shared/simulation/rules.ts';
import { defaultContent } from '/shared/simulation/content.ts';
import { describeContent } from '/shared/presentation.ts';

// Presentation vocabulary shared by the client modules. Names and abilities come from the displayed
// match's content descriptor (22.7), passed by whoever chose the context: the live room, the dev feed
// or a recording. Leaving it out means this build's shipped content, for standalone callers; an
// explicit `null` is content this build cannot describe, which shows raw ids rather than guessing.
export const $ = id => document.getElementById(id);
export { HZ, INTERPOLATION_DELAY_TICKS };
export const SHIPPED_PRESENTATION = describeContent(defaultContent());
/** A display value, or this when it is unavailable. */
export const UNAVAILABLE = '—';
const kitEntry = (kit, presentation) => presentation?.kits.find(k => k.id === kit);
export const kitName = (kit, presentation = SHIPPED_PRESENTATION) => kitEntry(kit, presentation)?.name ?? kit;
export const kitSkill = (kit, presentation = SHIPPED_PRESENTATION) => kit == null ? 'No innate ability' : kitEntry(kit, presentation)?.skill ?? UNAVAILABLE;
/** A positive whole tick rate, or the historical `HZ`. */
export const tickRate = hz => Number.isSafeInteger(hz) && hz > 0 ? hz : HZ;
/** Ticks as mm:ss. The match clock, the replay playhead and the archive all show the same shape. */
export const time = (ticks, hz = HZ) => {
  const seconds = Math.max(0, Math.floor(ticks / tickRate(hz)));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
/** Fill a camera-focus select: the whole arena, then the roster grouped by role. Replay and dev view share it. */
export function fillFollowOptions(select, roster = [], presentation = SHIPPED_PRESENTATION) {
  const whole = document.createElement('option'); whole.value = ''; whole.textContent = 'Whole arena';
  const groups = [['contestant', 'Contestants'], ['gladiator', 'Gladiators']].map(([role, label]) => {
    const group = document.createElement('optgroup'); group.label = label;
    for (const player of roster.filter(p => p.role === role)) {
      const option = document.createElement('option'); option.value = player.id;
      option.textContent = player.role === 'gladiator' ? `${player.name} / ${kitName(player.kit, presentation)}` : player.name;
      group.append(option);
    }
    return group;
  }).filter(group => group.childElementCount);
  select.replaceChildren(whole, ...groups);
}
/**
 * Offer a descriptor's kits in a select, keeping the selection when it is still offered, otherwise
 * the default kit when offered, otherwise the first. With none the select is disabled. Never sends a
 * choice: rebuilding controls is not the player choosing.
 */
export function fillKitOptions(select, presentation, preferred = select.value) {
  const kits = presentation?.kits ?? [];
  select.replaceChildren(...kits.map(kit => {
    const option = document.createElement('option'); option.value = kit.id; option.textContent = `${kit.name} / ${kit.skill}`;
    return option;
  }));
  const offered = id => kits.some(kit => kit.id === id);
  select.value = offered(preferred) ? preferred : offered(DEFAULT_KIT) ? DEFAULT_KIT : kits[0]?.id ?? '';
  select.disabled = !kits.length;
  return select.value;
}
