import { finite, safeInteger } from './numbers.ts';
import { ROLES } from './simulation/rules.ts';
import { sanitizeInput } from './simulation/input.ts';
import type { SanitizedInput } from './simulation/input.ts';
import type { WaitingMap } from './simulation/waiting.ts';
import type { PredictionConstants } from './simulation/physics-presentation.ts';
import type { ContentPresentation, GameMap, Kit, PlayerId, PlayerInput, Projected, Role, SeatMetadata, Snapshot, Tick } from './types.ts';

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
export const WIRE_VERSION = 14;

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
  TRANSPORT: '/api/transport',
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
  // A player session with datagrams is sent fast state as `fast` and its slow layers as `slow` (24.5 stage 3).
  FAST: 'fast',
  SLOW: 'slow',
  SEATS: 'seats',
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

/**
 * How the server writes `state` messages to one connection (24.1, #1131). A client names the one it reads
 * when it joins, and the welcome confirms it. `binary` is the descriptor codec (`shared/wire-schema.ts`) and
 * the default. `json` is a debug encoding of the same projection, granted only to a connection the server's
 * dev-tools policy authorizes; a join that asks for it otherwise is refused, never quietly given binary.
 * Every other message stays JSON, with `welcome` and `ready` envelopes compressed as gzip JSON frames (#1201).
 */
export const STATE_ENCODINGS = Object.freeze(['binary', 'json'] as const);
export type StateEncoding = typeof STATE_ENCODINGS[number];

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
  stateEncoding: StateEncoding;
}

export interface MatchMessage {
  type: typeof CLIENT_MESSAGE.MATCH;
  role: JoinRole;
  kit?: Kit;
  name: string;
  stateEncoding: StateEncoding;
}

export interface StartMessage {
  type: typeof CLIENT_MESSAGE.START;
}

export interface ChooseMessage {
  type: typeof CLIENT_MESSAGE.CHOOSE;
  role: Role;
  kit?: Kit;
}

export type InputMessage = SanitizedInput & {
  type: typeof CLIENT_MESSAGE.INPUT;
  seq: number;
  /** The tick the input is for (#1096, `shared/simulation/input.ts`). */
  tick: Tick;
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
  roster: SeatMetadata[];
  /** The revision of `roster` (#1131): the client holds it until a `seats` names another. */
  rosterRevision: number;
  /** The map's prediction constants, null with no map (24.3 proposal 3): no frame repeats them. */
  constants: PredictionConstants | null;
  /** How this connection's `state` messages are written, as its join asked. */
  stateEncoding: StateEncoding;
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
  roster: SeatMetadata[];
  rosterRevision: number;
  constants: PredictionConstants | null;
}

/**
 * A seat roster and its revision (#1131, 24.4). Each `state` names the revision it was projected against as
 * `rosterRevision`, so a client can tell when it lacks the matching roster rather than assume arrival order.
 */
export interface SeatsMessage { type: typeof SERVER_MESSAGE.SEATS; roster: SeatMetadata[]; revision: number; }

export interface StateMessage {
  type: typeof SERVER_MESSAGE.STATE;
  state: Projected<Snapshot> | Record<string, unknown>;
}

/**
 * A frame's fast part (24.5 "Stage 3's contracts"): whole, or a delta against a baseline the reader holds, which
 * only the codec writes and reads. It names the roster and the slow layers' version it was projected with.
 */
export interface FastMessage {
  type: typeof SERVER_MESSAGE.FAST;
  rosterRevision: number;
  slowVersion: number;
  state: Record<string, unknown>;
}

/** A player view's slow layers (items, gates, own discovery) as keyframe layers, and their version. */
export interface SlowMessage {
  type: typeof SERVER_MESSAGE.SLOW;
  slowVersion: number;
  items: unknown;
  gates: unknown;
  discovered?: unknown;
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
  | FastMessage
  | SlowMessage
  | SeatsMessage
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
  /** `fast` messages sent on datagrams since the server started (24.5 "Delivery"). */
  fastDatagrams: number;
  /** Of those, deltas over one of the edge's fragments: 24.2's cue for priority packing. */
  fastFragmentedDeltas: number;
  /** `fast` messages sent on the stream instead, too large for the edge's fragments: the overflow 24.2 counts. */
  fastStreamed: number;
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
  /** Where the WebTransport edge is, or null while none is linked (24.5). */
  webTransport: { port: number; certificateHash: string | null } | null;
  /** Where the edge's WebSocket listener is, or null while none is linked (24.5 stage 4). */
  webSocket: { port: number; tls: boolean } | null;
}

export interface TransportResponse {
  webTransport: { port: number; certificateHash: string | null } | null;
  webSocket: { port: number; tls: boolean } | null;
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

export interface ProfileResponse {
  enabled: boolean;
  tickRate: number;
  budgetMs: number;
  effectiveHz: number | null;
  frames: number;
  rooms: number;
  series: unknown[];
  /** Each threaded room's own series (#1115); rooms run on the host thread report in `series`. */
  roomProfiles: RoomProfile[];
}

export interface RoomProfile {
  id: string;
  frames: number;
  effectiveHz: number | null;
  series: unknown[];
}

export interface ProfileToggleResponse {
  enabled: boolean;
}

// --- Outbound Server Message & HTTP Payload Validation and Checked Builders ---

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const nonNegativeInt = (value: unknown): value is number =>
  safeInteger(value) && value >= 0;

const hasExactKeys = (obj: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(obj);
  return keys.length === expected.length && expected.every(k => Object.hasOwn(obj, k));
};

const WELCOME_PLAYER_KEYS = [
  'type', 'id', 'resumeKey', 'room', 'owner', 'devTools', 'paused',
  'started', 'ready', 'matchmade', 'startsAt', 'contentId', 'presentation', 'map', 'state', 'roster', 'rosterRevision', 'constants', 'stateEncoding',
] as const;

const WELCOME_SPECTATOR_KEYS = [
  'type', 'id', 'spectator', 'spectatorDelayTicks', 'room', 'owner', 'devTools',
  'ready', 'paused', 'contentId', 'presentation', 'map', 'state', 'roster', 'rosterRevision', 'constants', 'stateEncoding',
] as const;

const WELCOME_DEV_KEYS = [
  'type', 'id', 'spectator', 'dev', 'devTools', 'room', 'owner',
  'started', 'ready', 'paused', 'contentId', 'presentation', 'map', 'state', 'roster', 'rosterRevision', 'constants', 'stateEncoding',
] as const;

const READY_KEYS = ['type', 'contentId', 'presentation', 'map', 'state', 'roster', 'rosterRevision', 'constants'] as const;

/** A map's prediction constants (PredictionConstants), or null when there is no map yet. */
const validConstants = (value: unknown): boolean => value === null || isRecord(value) && hasExactKeys(value, ['physicsProfile', 'predictionMotor']) &&
  nonEmptyString(value.physicsProfile) && isRecord(value.predictionMotor) &&
  hasExactKeys(value.predictionMotor, ['acceleration', 'braking', 'maxSpeed', 'surfaces']) && value.predictionMotor.surfaces === true &&
  finite(value.predictionMotor.acceleration) && finite(value.predictionMotor.braking) && finite(value.predictionMotor.maxSpeed);
const STATE_KEYS = ['type', 'state'] as const;
const FAST_KEYS = ['type', 'rosterRevision', 'slowVersion', 'state'] as const;
const SLOW_KEYS = ['type', 'slowVersion', 'items', 'gates', 'discovered'] as const;
const LOBBY_KEYS = [
  'type', 'room', 'name', 'started', 'matchmade', 'size',
  'startsAt', 'ready', 'starting', 'capacity', 'players',
] as const;
const CHOOSE_REPLY_KEYS = ['type', 'ok', 'message'] as const;
const TELEPORT_REPLY_KEYS = ['type', 'ok', 'id'] as const;
const PAUSED_KEYS = ['type', 'paused'] as const;
const SAVED_KEYS = ['type', 'replay'] as const;
const REPLAY_STATUS_KEYS = ['type', 'status', 'message'] as const;
const ERROR_KEYS = ['type', 'message'] as const;
const PING_KEYS = ['type', 'token', 'rtt'] as const;

/** Slots strictly increase: a match roster is dense, a waiting yard's has gaps where people left (24.4). */
const validRoster = (value: unknown): value is SeatMetadata[] => Array.isArray(value) && value.every((entry, i) =>
  isRecord(entry) && hasExactKeys(entry, ['playerIdx', 'id', 'name', 'role', 'kit', ...(entry.seat === undefined ? [] : ['seat'])]) &&
  nonNegativeInt(entry.playerIdx) && (i === 0 || entry.playerIdx > (value[i - 1] as SeatMetadata).playerIdx) && nonEmptyString(entry.id) && typeof entry.name === 'string' &&
  (ROLES as readonly unknown[]).includes(entry.role) && nonEmptyString(entry.kit) &&
  (entry.seat === undefined || nonNegativeInt(entry.seat)));

const validWelcomeCommon = (data: Record<string, unknown>): boolean =>
  validRoster(data.roster) && nonNegativeInt(data.rosterRevision) &&
  nonEmptyString(data.room) &&
  typeof data.owner === 'boolean' &&
  typeof data.devTools === 'boolean' &&
  typeof data.ready === 'boolean' &&
  typeof data.paused === 'boolean' &&
  nonEmptyString(data.contentId) &&
  (STATE_ENCODINGS as readonly unknown[]).includes(data.stateEncoding) &&
  validConstants(data.constants) &&
  isRecord(data.presentation) &&
  (data.map === null || isRecord(data.map)) &&
  (data.state === null || isRecord(data.state));

const validRoleCounts = (value: unknown): value is { contestant: number; gladiator: number } =>
  isRecord(value) &&
  hasExactKeys(value, ['contestant', 'gladiator']) &&
  nonNegativeInt(value.contestant) &&
  nonNegativeInt(value.gladiator);

const validLobbyPlayer = (value: unknown): value is LobbyPlayerSummary =>
  isRecord(value) &&
  hasExactKeys(value, ['id', 'name', 'role', 'kit']) &&
  nonEmptyString(value.id) &&
  typeof value.name === 'string' &&
  (ROLES as readonly unknown[]).includes(value.role) &&
  nonEmptyString(value.kit);

export type ServerMessageValidation =
  | { ok: true; message: ServerMessage }
  | { ok: false; type: ServerMessageType | null; reason: string };

/**
 * Validate one outbound server->client WebSocket message against its declared wire contract.
 */
export function validateServerMessage(raw: unknown): ServerMessageValidation {
  if (!isRecord(raw)) {
    return { ok: false, type: null, reason: 'Server message must be a JSON object.' };
  }
  if (typeof raw.type !== 'string' || !(SERVER_MESSAGE_TYPES as readonly string[]).includes(raw.type)) {
    return { ok: false, type: null, reason: `Unknown server message type ${JSON.stringify(raw.type)}.` };
  }
  const type = raw.type as ServerMessageType;
  switch (type) {
    case SERVER_MESSAGE.WELCOME: {
      if (!validWelcomeCommon(raw)) {
        return { ok: false, type, reason: 'Welcome message is missing required common fields.' };
      }
      if (raw.dev === true) {
        if (
          !hasExactKeys(raw, WELCOME_DEV_KEYS) ||
          raw.id !== null ||
          raw.spectator !== true ||
          raw.devTools !== true ||
          typeof raw.started !== 'boolean'
        ) {
          return { ok: false, type, reason: 'Dev welcome message does not match DevWelcomeMessage contract.' };
        }
        return { ok: true, message: raw as unknown as DevWelcomeMessage };
      }
      if (raw.spectator === true) {
        if (
          !hasExactKeys(raw, WELCOME_SPECTATOR_KEYS) ||
          raw.id !== null ||
          !nonNegativeInt(raw.spectatorDelayTicks)
        ) {
          return { ok: false, type, reason: 'Spectator welcome message does not match SpectatorWelcomeMessage contract.' };
        }
        return { ok: true, message: raw as unknown as SpectatorWelcomeMessage };
      }
      if (
        !hasExactKeys(raw, WELCOME_PLAYER_KEYS) ||
        !nonEmptyString(raw.id) ||
        !nonEmptyString(raw.resumeKey) ||
        typeof raw.started !== 'boolean' ||
        typeof raw.matchmade !== 'boolean' ||
        (raw.startsAt !== null && !finite(raw.startsAt))
      ) {
        return { ok: false, type, reason: 'Player welcome message does not match PlayerWelcomeMessage contract.' };
      }
      return { ok: true, message: raw as unknown as PlayerWelcomeMessage };
    }
    case SERVER_MESSAGE.READY: {
      if (
        !hasExactKeys(raw, READY_KEYS) || !validRoster(raw.roster) || !nonNegativeInt(raw.rosterRevision) || !validConstants(raw.constants) ||
        !nonEmptyString(raw.contentId) ||
        !isRecord(raw.presentation) ||
        (raw.map !== null && !isRecord(raw.map)) ||
        (raw.state !== null && !isRecord(raw.state))
      ) {
        return { ok: false, type, reason: 'Ready message does not match ReadyMessage contract.' };
      }
      return { ok: true, message: raw as unknown as ReadyMessage };
    }
    case SERVER_MESSAGE.SEATS: {
      if (!hasExactKeys(raw, ['type', 'roster', 'revision']) || !validRoster(raw.roster) || !nonNegativeInt(raw.revision)) return { ok: false, type, reason: 'Invalid seat metadata.' };
      return { ok: true, message: raw as unknown as SeatsMessage };
    }
    case SERVER_MESSAGE.STATE: {
      if (!hasExactKeys(raw, STATE_KEYS) || !isRecord(raw.state)) {
        return { ok: false, type, reason: 'State message does not match StateMessage contract.' };
      }
      return { ok: true, message: raw as unknown as StateMessage };
    }
    case SERVER_MESSAGE.FAST: {
      if (!hasExactKeys(raw, FAST_KEYS) || !nonNegativeInt(raw.rosterRevision) || !nonNegativeInt(raw.slowVersion) || !isRecord(raw.state)) {
        return { ok: false, type, reason: 'Fast message does not match FastMessage contract.' };
      }
      return { ok: true, message: raw as unknown as FastMessage };
    }
    case SERVER_MESSAGE.SLOW: {
      // `discovered` is a contestant's own discovery, and absent for a gladiator.
      if (!Object.keys(raw).every(key => (SLOW_KEYS as readonly string[]).includes(key)) || !nonNegativeInt(raw.slowVersion) || raw.items === undefined || raw.gates === undefined) {
        return { ok: false, type, reason: 'Slow message does not match SlowMessage contract.' };
      }
      return { ok: true, message: raw as unknown as SlowMessage };
    }
    case SERVER_MESSAGE.LOBBY: {
      if (
        !hasExactKeys(raw, LOBBY_KEYS) ||
        !nonEmptyString(raw.room) ||
        (raw.name !== null && typeof raw.name !== 'string') ||
        typeof raw.started !== 'boolean' ||
        typeof raw.matchmade !== 'boolean' ||
        !nonEmptyString(raw.size) ||
        (raw.startsAt !== null && !finite(raw.startsAt)) ||
        typeof raw.ready !== 'boolean' ||
        typeof raw.starting !== 'boolean' ||
        !validRoleCounts(raw.capacity) ||
        !Array.isArray(raw.players) ||
        !raw.players.every(validLobbyPlayer)
      ) {
        return { ok: false, type, reason: 'Lobby message does not match LobbyMessage contract.' };
      }
      return { ok: true, message: raw as unknown as LobbyMessage };
    }
    case SERVER_MESSAGE.CHOOSE: {
      if (!hasExactKeys(raw, CHOOSE_REPLY_KEYS) || raw.ok !== false || !nonEmptyString(raw.message)) {
        return { ok: false, type, reason: 'Choose reply does not match ChooseReplyMessage contract.' };
      }
      return { ok: true, message: raw as unknown as ChooseReplyMessage };
    }
    case SERVER_MESSAGE.TELEPORT: {
      if (
        !hasExactKeys(raw, TELEPORT_REPLY_KEYS) ||
        typeof raw.ok !== 'boolean' ||
        (raw.id !== null && !nonEmptyString(raw.id))
      ) {
        return { ok: false, type, reason: 'Teleport reply does not match TeleportReplyMessage contract.' };
      }
      return { ok: true, message: raw as unknown as TeleportReplyMessage };
    }
    case SERVER_MESSAGE.PAUSED: {
      if (!hasExactKeys(raw, PAUSED_KEYS) || typeof raw.paused !== 'boolean') {
        return { ok: false, type, reason: 'Paused message does not match PausedMessage contract.' };
      }
      return { ok: true, message: raw as unknown as PausedMessage };
    }
    case SERVER_MESSAGE.SAVED: {
      if (!hasExactKeys(raw, SAVED_KEYS) || !isRecord(raw.replay)) {
        return { ok: false, type, reason: 'Saved message does not match SavedMessage contract.' };
      }
      return { ok: true, message: raw as unknown as SavedMessage };
    }
    case SERVER_MESSAGE.REPLAY_STATUS: {
      if (
        !hasExactKeys(raw, REPLAY_STATUS_KEYS) ||
        !(REPLAY_STATUSES as readonly unknown[]).includes(raw.status) ||
        !nonEmptyString(raw.message)
      ) {
        return { ok: false, type, reason: 'Replay status message does not match ReplayStatusMessage contract.' };
      }
      return { ok: true, message: raw as unknown as ReplayStatusMessage };
    }
    case SERVER_MESSAGE.ERROR: {
      if (!hasExactKeys(raw, ERROR_KEYS) || !nonEmptyString(raw.message)) {
        return { ok: false, type, reason: 'Error message does not match ErrorMessage contract.' };
      }
      return { ok: true, message: raw as unknown as ErrorMessage };
    }
    case SERVER_MESSAGE.PING: {
      if (
        !hasExactKeys(raw, PING_KEYS) ||
        !nonEmptyString(raw.token) ||
        (raw.rtt !== null && !finite(raw.rtt))
      ) {
        return { ok: false, type, reason: 'Ping message does not match PingMessage contract.' };
      }
      return { ok: true, message: raw as unknown as PingMessage };
    }
  }
}

export function assertServerMessage<T extends ServerMessage>(message: T): T {
  const verdict = validateServerMessage(message);
  if (!verdict.ok) {
    throw new TypeError(`Invalid server message (${verdict.type ?? 'unknown'}): ${verdict.reason}`);
  }
  return message;
}

export const playerWelcomeMessage = (fields: Omit<PlayerWelcomeMessage, 'type'>): PlayerWelcomeMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.WELCOME, ...fields });

export const spectatorWelcomeMessage = (fields: Omit<SpectatorWelcomeMessage, 'type' | 'id' | 'spectator'>): SpectatorWelcomeMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.WELCOME, id: null, spectator: true, ...fields });

export const devWelcomeMessage = (fields: Omit<DevWelcomeMessage, 'type' | 'id' | 'spectator' | 'dev' | 'devTools'>): DevWelcomeMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.WELCOME, id: null, spectator: true, dev: true, devTools: true, ...fields });

export const readyMessage = (fields: Omit<ReadyMessage, 'type'>): ReadyMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.READY, ...fields });

export const seatsMessage = (roster: SeatMetadata[], revision: number): SeatsMessage => assertServerMessage({ type: SERVER_MESSAGE.SEATS, roster, revision });

export const stateMessage = (state: StateMessage['state']): StateMessage => {
  if (!isRecord(state)) throw new TypeError('Invalid server message (state): StateMessage requires a state object.');
  return { type: SERVER_MESSAGE.STATE, state };
};

/** A `fast` message; its `state` may be a codec delta (`against`), which only the codec reads. */
export const fastMessage = (fields: Omit<FastMessage, 'type'>): FastMessage => assertServerMessage({ type: SERVER_MESSAGE.FAST, ...fields });
export const slowMessage = (fields: Omit<SlowMessage, 'type'>): SlowMessage => assertServerMessage({ type: SERVER_MESSAGE.SLOW, ...fields });

export const lobbyMessage = (fields: Omit<LobbyMessage, 'type'>): LobbyMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.LOBBY, ...fields });

export const chooseReplyMessage = (message: string): ChooseReplyMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.CHOOSE, ok: false, message });

export const teleportReplyMessage = (ok: boolean, id: PlayerId | null): TeleportReplyMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.TELEPORT, ok, id });

export const pausedMessage = (paused: boolean): PausedMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.PAUSED, paused });

export const savedMessage = (replay: ReplayMeta): SavedMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.SAVED, replay });

export const replayStatusMessage = (status: ReplayStatusKind, message: string): ReplayStatusMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.REPLAY_STATUS, status, message });

export const errorMessage = (message: string): ErrorMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.ERROR, message });

export const pingMessage = (token: string, rtt: number | null): PingMessage =>
  assertServerMessage({ type: SERVER_MESSAGE.PING, token, rtt });

const HEALTH_KEYS = [
  'ok', 'rulesVersion', 'physicsVersion', 'wireVersion', 'tickRate',
  'profiling', 'devTools', 'liveRooms', 'emptyLiveRooms', 'fastDatagrams', 'fastFragmentedDeltas', 'fastStreamed', 'mapPool',
] as const;

const PROFILE_KEYS = ['enabled', 'tickRate', 'budgetMs', 'effectiveHz', 'frames', 'rooms', 'series', 'roomProfiles'] as const;
const ROOM_PROFILE_KEYS = ['id', 'frames', 'effectiveHz', 'series'] as const;
const CLIENT_CONFIG_KEYS = [
  'wireVersion', 'devTools', 'presentation', 'seed', 'roomNameMaxLength',
  'playerNameMaxLength', 'sizes', 'defaultSize', 'matchmakingCountdownMs', 'webTransport', 'webSocket',
] as const;
const TRANSPORT_KEYS = ['webTransport', 'webSocket'] as const;
const ROOM_SUMMARY_KEYS = ['id', 'name', 'kind', 'phase', 'ready', 'size', 'createdAt', 'players', 'open'] as const;
const CREATE_ROOM_KEYS = ['id', 'name', 'ownerKey', 'seed', 'size'] as const;

export function healthResponse(fields: Omit<HealthResponse, 'ok' | 'wireVersion'>): HealthResponse {
  const payload: HealthResponse = { ok: true, wireVersion: WIRE_VERSION, ...fields };
  const raw = payload as unknown as Record<string, unknown>;
  if (
    !hasExactKeys(raw, HEALTH_KEYS) ||
    raw.ok !== true ||
    !nonEmptyString(raw.rulesVersion) ||
    !nonEmptyString(raw.physicsVersion) ||
    raw.wireVersion !== WIRE_VERSION ||
    !finite(raw.tickRate) ||
    raw.tickRate <= 0 ||
    typeof raw.profiling !== 'boolean' ||
    !(DEV_TOOLS_POLICIES as readonly unknown[]).includes(raw.devTools) ||
    !nonNegativeInt(raw.liveRooms) ||
    !nonNegativeInt(raw.emptyLiveRooms) ||
    !nonNegativeInt(raw.fastDatagrams) ||
    !nonNegativeInt(raw.fastFragmentedDeltas) ||
    !nonNegativeInt(raw.fastStreamed) ||
    (raw.mapPool !== null && (!isRecord(raw.mapPool) || !Object.values(raw.mapPool).every(nonNegativeInt)))
  ) {
    throw new TypeError('Invalid /api/health response payload.');
  }
  return payload;
}

export function profileResponse(fields: ProfileResponse): ProfileResponse {
  const raw = fields as unknown as Record<string, unknown>;
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, PROFILE_KEYS) ||
    typeof raw.enabled !== 'boolean' ||
    !finite(raw.tickRate) ||
    !finite(raw.budgetMs) ||
    (raw.effectiveHz !== null && !finite(raw.effectiveHz)) ||
    !nonNegativeInt(raw.frames) ||
    !nonNegativeInt(raw.rooms) ||
    !Array.isArray(raw.series) ||
    !Array.isArray(raw.roomProfiles) ||
    !raw.roomProfiles.every(room => isRecord(room) && hasExactKeys(room, ROOM_PROFILE_KEYS) && typeof room.id === 'string'
      && nonNegativeInt(room.frames) && (room.effectiveHz === null || finite(room.effectiveHz)) && Array.isArray(room.series))
  ) {
    throw new TypeError('Invalid /api/profile response payload.');
  }
  return fields;
}

export function profileToggleResponse(enabled: boolean): ProfileToggleResponse {
  if (typeof enabled !== 'boolean') throw new TypeError('Invalid /api/profile toggle response payload.');
  return { enabled };
}

/**
 * The edge's offer as the browser is given it (24.5): its UDP port, and the hex SHA-256 of a self-signed
 * certificate or null for a CA-issued one. The edge link checks what the edge reports against this too.
 */
export function isWebTransportOffer(value: unknown): value is { port: number; certificateHash: string | null } {
  if (!isRecord(value) || !hasExactKeys(value, ['port', 'certificateHash'])) return false;
  const { port, certificateHash } = value;
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535 &&
    (certificateHash === null || (typeof certificateHash === 'string' && /^[0-9a-f]{64}$/i.test(certificateHash)));
}

/**
 * The edge's WebSocket offer as the browser is given it (24.5 stage 4): its TCP port, and whether TLS is used.
 */
export function isWebSocketOffer(value: unknown): value is { port: number; tls: boolean } {
  if (!isRecord(value) || !hasExactKeys(value, ['port', 'tls'])) return false;
  const { port, tls } = value;
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535 && typeof tls === 'boolean';
}

export function transportResponse(fields: TransportResponse): TransportResponse {
  const raw = fields as unknown as Record<string, unknown>;
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, TRANSPORT_KEYS) ||
    (raw.webTransport !== null && !isWebTransportOffer(raw.webTransport)) ||
    (raw.webSocket !== null && !isWebSocketOffer(raw.webSocket))
  ) {
    throw new TypeError('Invalid /api/transport response payload.');
  }
  return fields;
}

export function clientConfigResponse(fields: Omit<ClientConfigResponse, 'wireVersion'>): ClientConfigResponse {
  const payload: ClientConfigResponse = { wireVersion: WIRE_VERSION, ...fields };
  const raw = payload as unknown as Record<string, unknown>;
  if (
    !hasExactKeys(raw, CLIENT_CONFIG_KEYS) ||
    raw.wireVersion !== WIRE_VERSION ||
    !(DEV_TOOLS_POLICIES as readonly unknown[]).includes(raw.devTools) ||
    !isRecord(raw.presentation) ||
    !nonEmptyString(raw.presentation.contentId) ||
    !isRecord(raw.seed) ||
    !hasExactKeys(raw.seed, ['min', 'max']) ||
    !nonNegativeInt(raw.seed.min) ||
    !nonNegativeInt(raw.seed.max) ||
    !nonNegativeInt(raw.roomNameMaxLength) ||
    !nonNegativeInt(raw.playerNameMaxLength) ||
    !Array.isArray(raw.sizes) ||
    raw.sizes.length === 0 ||
    !raw.sizes.every(nonEmptyString) ||
    !nonEmptyString(raw.defaultSize) ||
    !nonNegativeInt(raw.matchmakingCountdownMs) ||
    (raw.webTransport !== null && !isWebTransportOffer(raw.webTransport)) ||
    (raw.webSocket !== null && !isWebSocketOffer(raw.webSocket))
  ) {
    throw new TypeError('Invalid /api/client-config response payload.');
  }
  return payload;
}

const validRoomSummary = (raw: unknown): raw is RoomSummary =>
  isRecord(raw) &&
  hasExactKeys(raw, ROOM_SUMMARY_KEYS) &&
  nonEmptyString(raw.id) &&
  (raw.name === null || typeof raw.name === 'string') &&
  (raw.kind === 'matchmade' || raw.kind === 'private') &&
  (raw.phase === 'lobby' || raw.phase === 'live') &&
  typeof raw.ready === 'boolean' &&
  nonEmptyString(raw.size) &&
  finite(raw.createdAt) &&
  validRoleCounts(raw.players) &&
  validRoleCounts(raw.open);

export function roomsResponse(rooms: RoomSummary[]): RoomSummary[] {
  if (!Array.isArray(rooms) || !rooms.every(validRoomSummary)) {
    throw new TypeError('Invalid /api/rooms response payload.');
  }
  return rooms;
}

export function createRoomResponse(fields: CreateRoomResponse): CreateRoomResponse {
  const raw = fields as unknown as Record<string, unknown>;
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, CREATE_ROOM_KEYS) ||
    !nonEmptyString(raw.id) ||
    (raw.name !== null && typeof raw.name !== 'string') ||
    !nonEmptyString(raw.ownerKey) ||
    !nonNegativeInt(raw.seed) ||
    raw.seed < 1 ||
    !nonEmptyString(raw.size)
  ) {
    throw new TypeError('Invalid POST /api/rooms response payload.');
  }
  return fields;
}

export function replaysResponse(replays: ReplayMeta[]): ReplayMeta[] {
  if (!Array.isArray(replays) || !replays.every(r => isRecord(r) && nonEmptyString(r.id))) {
    throw new TypeError('Invalid /api/replays response payload.');
  }
  return replays;
}

export function httpErrorResponse(error: string): ErrorResponse {
  if (!nonEmptyString(error)) {
    throw new TypeError('Invalid HTTP error response payload.');
  }
  return { error };
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

/**
 * How many inputs one input datagram carries (24.5 "Stage 2's contracts"): the newest and the two sent before
 * it, so a lost datagram's input still arrives with the next.
 */
export const INPUT_DATAGRAM_INPUTS = 3;
const datagramText = new TextDecoder('utf-8', { fatal: true });

/** An input datagram's contents: the acknowledged tick, when there is one, and its inputs, oldest first. */
export interface InputDatagram { ack: number | null; inputs: Record<string, unknown>[] }

/**
 * Reads an input datagram (24.5 "Stage 2's contracts", acknowledgements from stage 3): a JSON object
 * `{ ack?, inputs }`. `ack` is the newest fast frame's tick the client holds whole, a non-negative safe integer.
 * `inputs` is zero to `INPUT_DATAGRAM_INPUTS` `input` messages, oldest first, whose `seq` values are non-negative
 * safe integers and strictly increase; it may be empty only beside an `ack`. Null for anything else. It checks
 * only the envelope; each message is still validated as any client message is (`validateClientMessage`). Throws
 * on bad JSON.
 */
export function parseInputDatagram(raw: string | Uint8Array): InputDatagram | null {
  const data: unknown = JSON.parse(typeof raw === 'string' ? raw : datagramText.decode(raw));
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { ack = null, inputs, ...rest } = data as Record<string, unknown>;
  if (Object.keys(rest).length || ('ack' in data && (!Number.isSafeInteger(ack) || (ack as number) < 0))) return null;
  if (!Array.isArray(inputs) || inputs.length > INPUT_DATAGRAM_INPUTS || (!inputs.length && ack === null)) return null;
  let last = -1;
  for (const item of inputs as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { type, seq } = item as Record<string, unknown>;
    if (type !== CLIENT_MESSAGE.INPUT || !Number.isSafeInteger(seq) || (seq as number) <= last) return null;
    last = seq as number;
  }
  return { ack: ack as number | null, inputs: inputs as Record<string, unknown>[] };
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

/** Read when a page joins this server's build: the server reads what it may send, never guesses it later. */
export const STALE_CLIENT_REASON = 'This page is out of date with the arena. Reload to play.';
/** Why a join or match request asking for JSON state was refused: the debug encoding needs dev tools. */
export const JSON_STATE_REFUSED = 'JSON state is a debug encoding this arena grants only with its dev tools.';
/**
 * A join's or match request's negotiation (24.1): the wire version the page was built for, when it says, and
 * the state encoding it reads. A page built for another wire version is refused before anything is sent to it.
 */
function negotiation(data: Record<string, unknown>): { ok: true; stateEncoding: StateEncoding } | { ok: false; reason: string } {
  if (data.wireVersion !== undefined && data.wireVersion !== WIRE_VERSION) return { ok: false, reason: STALE_CLIENT_REASON };
  if (data.stateEncoding !== undefined && !(STATE_ENCODINGS as readonly unknown[]).includes(data.stateEncoding)) {
    return { ok: false, reason: 'State encoding must be binary or json.' };
  }
  return { ok: true, stateEncoding: (data.stateEncoding as StateEncoding | undefined) ?? 'binary' };
}

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
      // Negotiation first: a stale page is told to reload, whatever else its join gets wrong for this version.
      const negotiated = negotiation(data);
      if (!negotiated.ok) return { ok: false, type, reason: negotiated.reason };
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
          stateEncoding: negotiated.stateEncoding,
        },
      };
    }
    case CLIENT_MESSAGE.MATCH: {
      const negotiated = negotiation(data);
      if (!negotiated.ok) return { ok: false, type, reason: negotiated.reason };
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
          stateEncoding: negotiated.stateEncoding,
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
      if (!safeInteger(data.tick) || data.tick < 0) {
        return { ok: false, type, reason: 'Input tick must be a non-negative safe integer.' };
      }
      return {
        ok: true,
        message: {
          type: CLIENT_MESSAGE.INPUT,
          ...sanitizeInput(data as unknown as PlayerInput, data.seq),
          seq: data.seq,
          tick: data.tick,
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
