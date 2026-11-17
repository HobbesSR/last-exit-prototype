import type { EventParticipant, GameEventPayload } from './types.ts';

export const DEFAULT_LOCALE = 'en';
type Templates = { [K in GameEventPayload['kind']]: (event: Extract<GameEventPayload, { kind: K }>) => string };
const name = (participant: EventParticipant | undefined): string => participant?.name || 'Unknown';

/** Each locale supplies a template for every event kind. */
export const EVENT_TEMPLATES: Record<string, Templates> = {
  en: {
    pod_powered: e => `${name(e.actor)} powered an escape pod. ${e.slotsRemaining} slots remain`,
    cell_charged: e => `${name(e.actor)} charged a power cell`,
    eliminated: e => `${name(e.target)} ${e.source ? `eliminated by ${name(e.source)}` : 'lost to the arena'}`,
    respawned: e => `${name(e.actor)} returned to the hunt`,
    match_finished: () => 'Broadcast complete',
  },
};

/** Format current events and schema 10-19 recording events without consulting the roster. */
export function formatEvent(event: GameEventPayload | { text: string; kind?: undefined }, locale: string = DEFAULT_LOCALE): string {
  if (!event.kind) return event.text;
  const templates = EVENT_TEMPLATES[locale] ?? EVENT_TEMPLATES[DEFAULT_LOCALE]!;
  switch (event.kind) {
    case 'pod_powered': return templates.pod_powered(event);
    case 'cell_charged': return templates.cell_charged(event);
    case 'eliminated': return templates.eliminated(event);
    case 'respawned': return templates.respawned(event);
    case 'match_finished': return templates.match_finished(event);
  }
}
