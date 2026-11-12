import { finite, safeInteger } from './numbers.ts';
import { ROLES } from './simulation/rules.ts';
import { sanitizeInput } from './simulation/input.ts';
import type { WaitingMap } from './simulation/waiting.ts';
import type { ContentPresentation, GameMap, Kit, PlayerId, PlayerInput, Projected, Role, Snapshot, Tick } from './types.ts';

/**
 * Single source of truth for the live wire formats between server and browser (docs/24-networking-privacy.md).
 *
 * Linked contracts (owned in their own modules, not restated here):
 * - Live frame and entity field projections: `shared/simulation/projection-contract.ts`
 * - Keyframe-delta layer encoding (`items`, `gates`, `bodies`, `tethers`): `shared/frame-layers.ts`
 * - Contestant room discovery delta encoding (`me.discovered`): `shared/discovery.ts`
 * - Content display descriptor (`presentation`): `shared/presentation.ts`
 * - Replay archive schema and compatibility (`SCHEMA`, `MIN_SCHEMA`): `shared/recording.ts` (docs/26)
 * - Pregenerated map chain binary artifact (`CHAIN_WIRE_VERSION`): `map/macro/src/chain/saving.ts` (docs/53)
 */

/** Wire protocol version for server<->client WebSocket and HTTP messages (bumped on breaking shape changes). */
export const WIRE_VERSION = 2;

export const MAX_MESSAGE_BYTES = 2048;
export const MAX_BUFFERED_BYTES = 512 * 1024;
export const MAX_MESSAGES_PER_SECOND = 70;
export const MAX_ROOM_NAME = 24;
export const DEFAULT_PLAYER_NAME = 'Player';

export const MAX_DIAGNOSTIC_LAG_TICKS = 150;
export const MAX_DIAGNOSTICS_PER_SESSION = 64;
export const MIN_DIAGNOSTIC_INTERVAL_MS = 250;
export const REJECT_LOG_INTERVAL_MS = 5000;

export const CLOSE_CODE = Object.freeze({
  NORMAL: 1000,
  POLICY_VIOLATION: 1008,
} as const);
export type CloseCode = typeof CLOSE_CODE[keyof typeof CLOSE_CODE];

export const CLOSE_REASON = Object.freeze({
  ORIGIN_REJECTED: 'Origin rejected',
  RATE_EXCEEDED: 'Input rate exceeded',
  INVALID_MESSAGE: 'Invalid message',
  SESSION_RESUMED: 'Session resumed',
} as const);
export type CloseReason = typeof CLOSE_REASON[keyof typeof CLOSE_REASON];

export const HTTP_ENDPOINT = Object.freeze({
  HEALTH: '/api/health',
  PROFILE: '/api/profile',
  CLIENT_CONFIG: '/api/client-config',
  ROOMS: '/api/rooms',
  REPLAYS: '/api/replays',
} as const);
export type HttpEndpoint = typeof HTTP_ENDPOINT[keyof typeof HTTP_ENDPOINT];

export const CLIENT_MESSAGE = Object.freeze({
  JOIN: 'join',
  MATCH: 'match',
  START: 'start',
  CHOOSE: 'choose',
  INPUT: 'input',
  PONG: 'pong',
  DEV: 'dev',
  DIAGNOSTIC: 'diagnostic',
  FINISH: 'finish',
} as const);
export type ClientMessageType = typeof CLIENT_MESSAGE[keyof typeof CLIENT_MESSAGE];
export const CLIENT_MESSAGE_TYPES: readonly ClientMessageType[] = Object.freeze(Object.values(CLIENT_MESSAGE));

export const SERVER_MESSAGE = Object.freeze({
  WELCOME: 'welcome',
  READY: 'ready',
  STATE: 'state',
  LOBBY: 'lobby',
  CHOOSE: 'choose',
  TELEPORT: 'teleport',
  PAUSED: 'paused',
  SAVED: 'saved',
  REPLAY_STATUS: 'replay-status',
  ERROR: 'error',
  PING: 'ping',
} as const);
export type ServerMessageType = typeof SERVER_MESSAGE[keyof typeof SERVER_MESSAGE];
export const SERVER_MESSAGE_TYPES: readonly ServerMessageType[] = Object.freeze(Object.values(SERVER_MESSAGE));

export const JOIN_MODES = Object.freeze(['player', 'spectator', 'dev'] as const);
export type JoinMode = typeof JOIN_MODES[number];

export const JOIN_ROLES = Object.freeze(['contestant', 'gladiator', 'any'] as const);
export type JoinRole = typeof JOIN_ROLES[number];

export const DEV_ACTIONS = Object.freeze(['pause', 'resume', 'teleport'] as const);
export type DevAction = typeof DEV_ACTIONS[number];

export const DEV_TOOLS_POLICIES = Object.freeze(['none', 'owner', 'all'] as const);
export type DevToolsPolicy = typeof DEV_TOOLS_POLICIES[number];

export const DIAGNOSTIC_KINDS = Object.freeze(['frame-drop', 'packet-gap', 'manual'] as const);
export type ClientDiagnosticKind = typeof DIAGNOSTIC_KINDS[number];

export const REPLAY_STATUSES = Object.freeze(['partial', 'failed'] as const);
export type ReplayStatusKind = typeof REPLAY_STATUSES[number];

// --- Client -> Server WebSocket messages ---

export interface JoinMessage {
  type: typeof CLIENT_MESSAGE.JOIN;
  room: string;
  mode: JoinMode;
  role: JoinRole;
  kit?: Kit;
  name: string;
  ownerKey: string | null;
  resumeKey: string | null;
}

export interface MatchMessage {
  type: typeof CLIENT_MESSAGE.MATCH;
  role: JoinRole;
  kit?: Kit;
  name: string;
}

export interface StartMessage {
  type: typeof CLIENT_MESSAGE.START;
}

export interface ChooseMessage {
  type: typeof CLIENT_MESSAGE.CHOOSE;
  role: Role;
  kit?: Kit;
}

export type InputMessage = PlayerInput & {
  type: typeof CLIENT_MESSAGE.INPUT;
  seq: number;
};

export interface PongMessage {
  type: typeof CLIENT_MESSAGE.PONG;
  token: string;
}

export interface DevPauseMessage {
  type: typeof CLIENT_MESSAGE.DEV;
  action: 'pause' | 'resume';
}

export interface DevTeleportMessage {
  type: typeof CLIENT_MESSAGE.DEV;
  action: 'teleport';
  id: PlayerId;
  x: number;
  y: number;
}

export type DevMessage = DevPauseMessage | DevTeleportMessage;

export interface DiagnosticMessage {
  type: typeof CLIENT_MESSAGE.DIAGNOSTIC;
  kind: ClientDiagnosticKind;
  tick: number;
  startTick?: number;
  count?: number;
  worstMs?: number;
}

export interface FinishMessage {
  type: typeof CLIENT_MESSAGE.FINISH;
}

export type ClientMessage =
  | JoinMessage
  | MatchMessage
  | StartMessage
  | ChooseMessage
  | InputMessage
  | PongMessage
  | DevMessage
  | DiagnosticMessage
  | FinishMessage;

// --- Server -> Client WebSocket messages ---

export interface WelcomeBase {
  type: typeof SERVER_MESSAGE.WELCOME;
  room: string;
  owner: boolean;
  devTools: boolean;
  ready: boolean;
  paused: boolean;
  contentId: string;
  presentation: ContentPresentation;
  map: GameMap | WaitingMap | null;
  state: Projected<Snapshot> | Record<string, unknown> | null;
}

export interface PlayerWelcomeMessage extends WelcomeBase {
  id: PlayerId;
  resumeKey: string;
  started: boolean;
  matchmade: boolean;
  startsAt: number | null;
}

export interface SpectatorWelcomeMessage extends WelcomeBase {
  id: null;
  spectator: true;
  spectatorDelayTicks: number;
}

export interface DevWelcomeMessage extends WelcomeBase {
  id: null;
  spectator: true;
  dev: true;
  started: boolean;
}

export type WelcomeMessage = PlayerWelcomeMessage | SpectatorWelcomeMessage | DevWelcomeMessage;

export interface ReadyMessage {
  type: typeof SERVER_MESSAGE.READY;
  contentId: string;
  presentation: ContentPresentation;
  map: GameMap | null;
  state: Projected<Snapshot> | null;
}

export interface StateMessage {
  type: typeof SERVER_MESSAGE.STATE;
  state: Projected<Snapshot> | Record<string, unknown>;
}

export interface LobbyPlayerSummary {
  id: PlayerId;
  name: string;
  role: Role;
  kit: Kit;
}

export interface LobbyMessage {
  type: typeof SERVER_MESSAGE.LOBBY;
  room: string;
  name: string | null;
  started: boolean;
  matchmade: boolean;
  size: string;
  startsAt: number | null;
  ready: boolean;
  starting: boolean;
  capacity: { contestant: number; gladiator: number };
  players: LobbyPlayerSummary[];
}

export interface ChooseReplyMessage {
  type: typeof SERVER_MESSAGE.CHOOSE;
  ok: false;
  message: string;
}

export interface TeleportReplyMessage {
  type: typeof SERVER_MESSAGE.TELEPORT;
  ok: boolean;
  id: PlayerId | null;
}

export interface PausedMessage {
  type: typeof SERVER_MESSAGE.PAUSED;
  paused: boolean;
}

export interface ReplayMeta {
  id: string;
  seed: number;
  createdAt: number;
  ticks: Tick;
  frames: number;
  sha256: string;
  escaped: number;
  recording?: { complete: false; droppedFrames: number; endTick: Tick };
}

export interface SavedMessage {
  type: typeof SERVER_MESSAGE.SAVED;
  replay: ReplayMeta;
}

export interface ReplayStatusMessage {
  type: typeof SERVER_MESSAGE.REPLAY_STATUS;
  status: ReplayStatusKind;
  message: string;
}

export interface ErrorMessage {
  type: typeof SERVER_MESSAGE.ERROR;
  message: string;
}

export interface PingMessage {
  type: typeof SERVER_MESSAGE.PING;
  token: string;
  rtt: number | null;
}

export type ServerMessage =
  | WelcomeMessage
  | ReadyMessage
  | StateMessage
  | LobbyMessage
  | ChooseReplyMessage
  | TeleportReplyMessage
  | PausedMessage
  | SavedMessage
  | ReplayStatusMessage
  | ErrorMessage
  | PingMessage;

// --- HTTP Endpoint Payloads ---

export interface HealthResponse {
  ok: true;
  rulesVersion: string;
  physicsVersion: string;
  wireVersion: number;
  tickRate: number;
  profiling: boolean;
  devTools: DevToolsPolicy;
  liveRooms: number;
  emptyLiveRooms: number;
  mapPool: Record<string, number> | null;
}

export interface ClientConfigResponse {
  wireVersion: number;
  devTools: DevToolsPolicy;
  presentation: ContentPresentation;
  seed: { min: number; max: number };
  roomNameMaxLength: number;
  playerNameMaxLength: number;
  sizes: string[];
  defaultSize: string;
  matchmakingCountdownMs: number;
}

export interface RoomSummary {
  id: string;
  name: string | null;
  kind: 'matchmade' | 'private';
  phase: 'lobby' | 'live';
  ready: boolean;
  size: string;
  createdAt: number;
  players: { contestant: number; gladiator: number };
  open: { contestant: number; gladiator: number };
}

export interface CreateRoomRequest {
  seed?: number | string;
  size?: string;
  name?: string | null;
}

export interface CreateRoomResponse {
  id: string;
  name: string | null;
  ownerKey: string;
  seed: number;
  size: string;
}

export interface ErrorResponse {
  error: string;
}

// --- Transport-free Envelope & Message Validation ---

// A state frame is superseded by the next, so a backed-up socket skips it. Anything else (a pause, a
// lobby change, a saved replay) is said once and must arrive, however far behind the socket is.
export const deliverable = (bufferedBytes: number, droppable?: boolean): boolean =>
  !droppable || bufferedBytes < MAX_BUFFERED_BYTES;

export function parseMessage(raw: string | Buffer): Record<string, unknown> | null {
  const data = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
}

export function acceptMessageRate(window: { start: number; messages: number }, now: number): boolean {
  if (now - window.start > 1000) { window.start = now; window.messages = 0; }
  return ++window.messages <= MAX_MESSAGES_PER_SECOND;
}

export function devToolsPolicy(value: unknown): DevToolsPolicy {
  if (value === undefined || value === '') return 'none';
  if (typeof value !== 'string' || !(DEV_TOOLS_POLICIES as readonly string[]).includes(value)) {
    throw new Error(`DEV_TOOLS must be one of ${DEV_TOOLS_POLICIES.join(', ')}, not ${JSON.stringify(value)}.`);
  }
  return value as DevToolsPolicy;
}

export type ClientMessageValidation =
  | { ok: true; message: ClientMessage }
  | { ok: false; type: ClientMessageType | null; reason: string };

const cleanPlayerName = (name: unknown): string =>
  typeof name === 'string' ? name.trim() || DEFAULT_PLAYER_NAME : DEFAULT_PLAYER_NAME;

/**
 * Validate and normalize one decoded client->server message. Transport-free: takes any parsed value
 * and returns either a normalized message with only permitted fields or a structured rejection reason.
 */
export function validateClientMessage(raw: unknown): ClientMessageValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, type: null, reason: 'Message must be a JSON object.' };
  }
  const data = raw as Record<string, unknown>;
  if (typeof data.type !== 'string' || !(CLIENT_MESSAGE_TYPES as readonly string[]).includes(data.type)) {
    return { ok: false, type: null, reason: `Unknown message type ${JSON.stringify(data.type)}.` };
  }
  const type = data.type as ClientMessageType;
  switch (type) {
    case CLIENT_MESSAGE.JOIN: {
      if (typeof data.room !== 'string' || !data.room.trim()) {
        return { ok: false, type, reason: 'A room id is required to join.' };
      }
      if (data.mode !== undefined && !(JOIN_MODES as readonly unknown[]).includes(data.mode)) {
        return { ok: false, type, reason: 'Join mode must be player, spectator, or dev.' };
      }
      if (data.role !== undefined && !(JOIN_ROLES as readonly unknown[]).includes(data.role)) {
        return { ok: false, type, reason: 'Join role must be contestant, gladiator, or any.' };
      }
      if (data.kit !== undefined && typeof data.kit !== 'string') {
        return { ok: false, type, reason: 'Join kit must be a string.' };
      }
      if (data.name !== undefined && typeof data.name !== 'string') {
        return { ok: false, type, reason: 'Player name must be a string.' };
      }
      if (data.ownerKey !== undefined && data.ownerKey !== null && typeof data.ownerKey !== 'string') {
        return { ok: false, type, reason: 'Owner key must be a string.' };
      }
      if (data.resumeKey !== undefined && data.resumeKey !== null && typeof data.resumeKey !== 'string') {
        return { ok: false, type, reason: 'Resume key must be a string.' };
      }
      return {
        ok: true,
        message: {
          type: CLIENT_MESSAGE.JOIN,
          room: data.room,
          mode: (data.mode as JoinMode | undefined) ?? 'player',
          role: (data.role as JoinRole | undefined) ?? 'contestant',
          ...(data.kit !== undefined ? { kit: data.kit as Kit } : {}),
          name: cleanPlayerName(data.name),
          ownerKey: typeof data.ownerKey === 'string' ? data.ownerKey : null,
          resumeKey: typeof data.resumeKey === 'string' ? data.resumeKey : null,
        },
      };
    }
    case CLIENT_MESSAGE.MATCH: {
      if (data.role !== undefined && !(JOIN_ROLES as readonly unknown[]).includes(data.role)) {
        return { ok: false, type, reason: 'Match role must be contestant, gladiator, or any.' };
      }
      if (data.kit !== undefined && typeof data.kit !== 'string') {
        return { ok: false, type, reason: 'Match kit must be a string.' };
      }
      if (data.name !== undefined && typeof data.name !== 'string') {
        return { ok: false, type, reason: 'Player name must be a string.' };
      }
      return {
        ok: true,
        message: {
          type: CLIENT_MESSAGE.MATCH,
          role: (data.role as JoinRole | undefined) ?? 'any',
          ...(data.kit !== undefined ? { kit: data.kit as Kit } : {}),
          name: cleanPlayerName(data.name),
        },
      };
    }
    case CLIENT_MESSAGE.START:
      return { ok: true, message: { type: CLIENT_MESSAGE.START } };
    case CLIENT_MESSAGE.CHOOSE: {
      if (!(ROLES as readonly unknown[]).includes(data.role)) {
        return { ok: false, type, reason: 'Choose contestant or gladiator.' };
      }
      if (data.kit !== undefined && typeof data.kit !== 'string') {
        return { ok: false, type, reason: 'Choose kit must be a string.' };
      }
      return {
        ok: true,
        message: {
          type: CLIENT_MESSAGE.CHOOSE,
          role: data.role as Role,
          ...(data.kit !== undefined ? { kit: data.kit as Kit } : {}),
        },
      };
    }
    case CLIENT_MESSAGE.INPUT: {
      if (!safeInteger(data.seq) || data.seq < 0) {
        return { ok: false, type, reason: 'Input seq must be a non-negative safe integer.' };
      }
      return {
        ok: true,
        message: {
          type: CLIENT_MESSAGE.INPUT,
          ...sanitizeInput(data as unknown as PlayerInput, data.seq),
          seq: data.seq,
        },
      };
    }
    case CLIENT_MESSAGE.PONG: {
      if (typeof data.token !== 'string' || !data.token) {
        return { ok: false, type, reason: 'Pong token must be a non-empty string.' };
      }
      return { ok: true, message: { type: CLIENT_MESSAGE.PONG, token: data.token } };
    }
    case CLIENT_MESSAGE.DEV: {
      if (data.action === 'pause' || data.action === 'resume') {
        return { ok: true, message: { type: CLIENT_MESSAGE.DEV, action: data.action } };
      }
      if (data.action === 'teleport') {
        if (typeof data.id !== 'string' || !data.id || !finite(data.x) || !finite(data.y)) {
          return { ok: false, type, reason: 'Teleport requires a player id and finite x, y coordinates.' };
        }
        return { ok: true, message: { type: CLIENT_MESSAGE.DEV, action: 'teleport', id: data.id as PlayerId, x: data.x, y: data.y } };
      }
      return { ok: false, type, reason: `Unknown dev action ${JSON.stringify(data.action)}.` };
    }
    case CLIENT_MESSAGE.DIAGNOSTIC: {
      if (!(DIAGNOSTIC_KINDS as readonly unknown[]).includes(data.kind)) {
        return { ok: false, type, reason: `Unknown diagnostic kind ${JSON.stringify(data.kind)}.` };
      }
      const reported = wholeNumber(data.tick, Number.MAX_SAFE_INTEGER);
      if (reported === undefined) {
        return { ok: false, type, reason: 'Diagnostic tick must be a non-negative finite number.' };
      }
      if (data.startTick !== undefined && !finite(data.startTick)) {
        return { ok: false, type, reason: 'Diagnostic startTick must be a finite number.' };
      }
      if (data.count !== undefined && !finite(data.count)) {
        return { ok: false, type, reason: 'Diagnostic count must be a finite number.' };
      }
      if (data.worstMs !== undefined && !finite(data.worstMs)) {
        return { ok: false, type, reason: 'Diagnostic worstMs must be a finite number.' };
      }
      return {
        ok: true,
        message: {
          type: CLIENT_MESSAGE.DIAGNOSTIC,
          kind: data.kind as ClientDiagnosticKind,
          tick: data.tick as number,
          ...(data.startTick !== undefined ? { startTick: data.startTick as number } : {}),
          ...(data.count !== undefined ? { count: data.count as number } : {}),
          ...(data.worstMs !== undefined ? { worstMs: data.worstMs as number } : {}),
        },
      };
    }
    case CLIENT_MESSAGE.FINISH:
      return { ok: true, message: { type: CLIENT_MESSAGE.FINISH } };
  }
}

const wholeNumber = (value: unknown, max: number): number | undefined =>
  finite(value) ? Math.min(max, Math.max(0, Math.round(value))) : undefined;

// Client-reported diagnostics end up in a recording others download, so every field is checked
// and clamped here. A report names the tick the client was rendering, which lags the server by
// the receive buffer and round trip, so it is held within a bound of the tick it arrived at.
export function normalizeDiagnostic(
  data: { kind?: unknown; tick?: unknown; startTick?: unknown; count?: unknown; worstMs?: unknown } | null | undefined,
  arrivalTick: Tick,
  playerId: PlayerId
) {
  if (!data || !(DIAGNOSTIC_KINDS as readonly unknown[]).includes(data.kind) || !Number.isInteger(arrivalTick)) return null;
  const clampTick = (value: number) => Math.min(arrivalTick, Math.max(arrivalTick - MAX_DIAGNOSTIC_LAG_TICKS, 0, Math.round(value)));
  const reported = wholeNumber(data.tick, Number.MAX_SAFE_INTEGER);
  if (reported === undefined) return null;
  const mark: {
    tick: Tick;
    kind: ClientDiagnosticKind;
    playerId: PlayerId;
    reportedTick: number;
    arrivalTick: Tick;
    startTick?: Tick;
    count?: number;
    worstMs?: number;
  } = { tick: clampTick(reported), kind: data.kind as ClientDiagnosticKind, playerId, reportedTick: reported, arrivalTick };
  const start = wholeNumber(data.startTick, Number.MAX_SAFE_INTEGER);
  if (start !== undefined) mark.startTick = clampTick(Math.min(start, reported));
  const count = wholeNumber(data.count, 100000), worstMs = wholeNumber(data.worstMs, 600000);
  if (count !== undefined) mark.count = count;
  if (worstMs !== undefined) mark.worstMs = worstMs;
  return mark;
}
