import { KEPT_EVENTS } from './rules.ts';
import { playerIndex } from './relations.ts';
import type { EffectKind, EventParticipant, Game, GameEventPayload, Player, Vec2, World } from '../types.ts';

// The match's event and effect records, each taking its ID from `serial`. A leaf, so the core's adapters can build
// the records their facts name without importing the rules that call them.
export function participant(s: Game, p: Player): EventParticipant { return { playerIdx: playerIndex(s, p), name: p.name }; }
export function event(s: Game, payload: GameEventPayload): void { s.events.push({ id: s.serial++, tick: s.tick, ...payload }); s.events = s.events.slice(-KEPT_EVENTS); }
export function effect(s: Game, p: Vec2, kind: EffectKind, radius: World = 60): void { s.effects.push({ id: s.serial++, x: p.x, y: p.y, kind, radius, life: 12 }); }
