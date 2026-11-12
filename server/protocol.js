// Transport limits, envelope decoding, HTTP room parameters, and session-scoped inbound message validation.
// Wire message definitions and transport-free validation live in `shared/protocol.ts`.
import { randomInt } from 'node:crypto';
import { MAX_ARENA_SEED, isArenaSeed } from '../shared/simulation/rules.ts';
import { DEFAULT_LIVE_ZONE_SIZE, LIVE_ZONE_SIZES, zoneSizeName } from '../map/live.ts';
import {
  WIRE_VERSION,
  MAX_MESSAGE_BYTES,
  MAX_BUFFERED_BYTES,
  MAX_MESSAGES_PER_SECOND,
  MAX_ROOM_NAME,
  DEFAULT_PLAYER_NAME,
  MAX_DIAGNOSTIC_LAG_TICKS,
  MAX_DIAGNOSTICS_PER_SESSION,
  MIN_DIAGNOSTIC_INTERVAL_MS,
  REJECT_LOG_INTERVAL_MS,
  CLOSE_CODE,
  CLOSE_REASON,
  HTTP_ENDPOINT,
  CLIENT_MESSAGE,
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE,
  SERVER_MESSAGE_TYPES,
  JOIN_MODES,
  JOIN_ROLES,
  DEV_ACTIONS,
  DEV_TOOLS_POLICIES,
  DIAGNOSTIC_KINDS,
  REPLAY_STATUSES,
  deliverable,
  parseMessage,
  acceptMessageRate,
  devToolsPolicy,
  validateClientMessage,
  validateServerMessage,
  assertServerMessage,
  playerWelcomeMessage,
  spectatorWelcomeMessage,
  devWelcomeMessage,
  readyMessage,
  stateMessage,
  lobbyMessage,
  chooseReplyMessage,
  teleportReplyMessage,
  pausedMessage,
  savedMessage,
  replayStatusMessage,
  errorMessage,
  pingMessage,
  healthResponse,
  profileResponse,
  profileToggleResponse,
  clientConfigResponse,
  roomsResponse,
  createRoomResponse,
  replaysResponse,
  httpErrorResponse,
  normalizeDiagnostic,
} from '../shared/protocol.ts';

export {
  WIRE_VERSION,
  MAX_MESSAGE_BYTES,
  MAX_BUFFERED_BYTES,
  MAX_MESSAGES_PER_SECOND,
  MAX_ROOM_NAME,
  DEFAULT_PLAYER_NAME,
  MAX_DIAGNOSTIC_LAG_TICKS,
  MAX_DIAGNOSTICS_PER_SESSION,
  MIN_DIAGNOSTIC_INTERVAL_MS,
  REJECT_LOG_INTERVAL_MS,
  CLOSE_CODE,
  CLOSE_REASON,
  HTTP_ENDPOINT,
  CLIENT_MESSAGE,
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE,
  SERVER_MESSAGE_TYPES,
  JOIN_MODES,
  JOIN_ROLES,
  DEV_ACTIONS,
  DEV_TOOLS_POLICIES,
  DIAGNOSTIC_KINDS,
  REPLAY_STATUSES,
  deliverable,
  parseMessage,
  acceptMessageRate,
  devToolsPolicy,
  validateClientMessage,
  validateServerMessage,
  assertServerMessage,
  playerWelcomeMessage,
  spectatorWelcomeMessage,
  devWelcomeMessage,
  readyMessage,
  stateMessage,
  lobbyMessage,
  chooseReplyMessage,
  teleportReplyMessage,
  pausedMessage,
  savedMessage,
  replayStatusMessage,
  errorMessage,
  pingMessage,
  healthResponse,
  profileResponse,
  profileToggleResponse,
  clientConfigResponse,
  roomsResponse,
  createRoomResponse,
  replaysResponse,
  httpErrorResponse,
  normalizeDiagnostic,
};

/**
 * Validate an inbound client message for a session. Counts and rate-limit-logs every rejection
 * on the session without closing it, and throws in strict mode so browser/integration tests fail on drift.
 */
export function acceptClientMessage(session, raw, { strict = false, log = console.warn, now = Date.now() } = {}) {
  const result = validateClientMessage(raw);
  if (result.ok) return result;
  if (session) session.rejectedMessages = (session.rejectedMessages || 0) + 1;
  if (log && (!session || now - (session.lastRejectLogAt ?? -Infinity) >= REJECT_LOG_INTERVAL_MS)) {
    if (session) session.lastRejectLogAt = now;
    log(`protocol reject (${session?.connectionId ?? 'session'}, count=${session?.rejectedMessages ?? 1}): ${result.reason}`);
  }
  if (strict) throw new Error(`Protocol reject (${result.type ?? 'unknown'}): ${result.reason}`);
  return result;
}

export const randomSeed = () => randomInt(1, MAX_ARENA_SEED + 1);
// The seed a request names, which reproduces a map. Undefined when it names none: the directory then gives
// the room a fresh one, from the map pool when it can (#266), so general play varies. Null when invalid.
export function roomSeed(body) {
  if (body?.seed == null) return undefined;
  const seed = Number(body.seed);
  return isArenaSeed(seed) ? seed : null;
}
export const ROOM_SIZE_NAMES = LIVE_ZONE_SIZES.map(zoneSizeName);
// The size a room is created at, written like `24x12`; null when the request names one that isn't authored.
export function roomSize(body) {
  if (body?.size === undefined) return DEFAULT_LIVE_ZONE_SIZE;
  return LIVE_ZONE_SIZES.find(size => zoneSizeName(size) === body.size) ?? null;
}
// A room's name (17.4 #9): free text, trimmed, at most MAX_ROOM_NAME characters. Null when the request
// names none, false when the one it names is not a string, too long, or holds control characters.
export function roomName(body) {
  if (body?.name == null) return null;
  if (typeof body.name !== 'string') return false;
  const name = body.name.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  return [...name].length <= MAX_ROOM_NAME && !/\p{Cc}/u.test(name) ? name : false;
}
