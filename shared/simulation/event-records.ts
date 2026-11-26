import { KEPT_EVENTS } from './rules.ts';
import { playerIndex } from './relations.ts';
import type { EffectKind, EventParticipant, Game, GameEventPayload, Player, Vec2, World } from '../types.ts';

// The match's event and effect records, each taking its ID from `serial`. A leaf, so the core's adapters can build
// the records their facts name without importing the rules that call them. The writers take only the fields they write,
// so a `Game` and the frame store's stage (`tick-frame.ts`) are both one.
/** Where events and effects are written: their lists, the serial their IDs come from, and the tick events are stamped with. */
export type Stage = Pick<Game, 'tick' | 'serial' | 'effects' | 'events'>;
export function participant(s: Pick<Game, 'players'>, p: Player): EventParticipant { return { playerIdx: playerIndex(s, p), name: p.name }; }
export function event(s: Pick<Stage, 'tick' | 'serial' | 'events'>, payload: GameEventPayload): void { s.events.push({ id: s.serial++, tick: s.tick, ...payload }); s.events = s.events.slice(-KEPT_EVENTS); }
export function effect(s: Pick<Stage, 'serial' | 'effects'>, p: Vec2, kind: EffectKind, radius: World = 60): void { s.effects.push({ id: s.serial++, x: p.x, y: p.y, kind, radius, life: 12 }); }
