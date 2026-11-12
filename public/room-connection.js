import { notePacket } from '/diagnostics.js';
import * as profiler from '/shared/profiler.ts';
import { createLayerDecoder } from '/shared/frame-layers.ts';
import { createDiscoveryDecoder } from '/shared/discovery.ts';
import { readPresentation } from '/shared/presentation.ts';
import { CLIENT_MESSAGE, SERVER_MESSAGE } from '/shared/protocol.ts';
import { DEFAULT_KIT } from '/shared/simulation/rules.ts';
import { DEFAULT_CALLSIGN } from '/ui.js';

/**
 * A welcome or ready's descriptor, validated against its content id before anything of it is installed.
 * Every live envelope carries both, since the server ships with this browser; one without is refused.
 */
export function envelopePresentation(data) {
  return typeof data.contentId === 'string' && data.contentId ? readPresentation(data.presentation, data.contentId) : null;
}

// The room this page is joined to: its socket, who this page is in it, and the room facts only that
// socket delivers (the live map, frame and descriptor, this player's discovery, pause, the saved replay).
// It keeps them current whatever is on screen, and tells the application of each message in arrival
// order; the application decides what is shown. It also keeps the room-keyed recovery records in session
// storage, which outlive a connection: the owner record and the resume key.
export function createRoomConnection({
  toast, showStatus, onJoining, onWelcome, onReady, onState, onLobby, onTeleport, onPaused, onSaved, onError, onClose,
}) {
  let ws, disconnecting = false;
  let roomId, ownerKey, playerId, owner = false;
  // This connection is the dev view (24): undelayed and unfogged, with the director's free camera.
  let dev = false;
  let liveMap, liveState, presentation = null;
  const discovery = createDiscoveryDecoder();
  // When this socket last delivered a frame. It is the network's own measure, kept by the socket that
  // receives the frames rather than by whatever is being drawn: a replay or the dev feed showing in its
  // place must neither stall it nor stand in for it.
  let lastStateAt = 0;
  // What the server last measured for this connection, for display only.
  let roundTripMs = null;
  // A dev pause has stopped this room's clock (24): no frames arrive and no input is sent.
  let paused = false;
  let savedReplay, recordingFailed = false;
  // What lets this browser reclaim a room it created.
  function ownerRecord(room) {
    try { return JSON.parse(sessionStorage.getItem(`last-exit:owner:${room}`)); } catch { return null; /* Storage may be unavailable. */ }
  }
  function setPaused(value) {
    if (paused === value) return;
    paused = value; onPaused(paused);
  }
  // Only this player's own discovery payloads are read, whatever view is showing.
  function learn(frame) {
    const me = frame?.players?.find(p => p.id === playerId);
    if (me?.discovered) discovery.decode(me.discovered);
  }
  function join({ room, key, mode = 'player', role = 'contestant', kit = DEFAULT_KIT, name = DEFAULT_CALLSIGN, matchmake = false }) {
    const saved = ownerRecord(room);
    // A dev view borrows the owner key for an `owner` policy, but never the owner's player slot.
    if (!key && saved?.key) { key = saved.key; if (mode === 'player') { role = saved.role; kit = saved.kit; name = saved.name; } }
    if (ws) { disconnecting = true; ws.close(); }
    // Nothing of the previous room carries over: a room still generating sends no state until `ready`,
    // and an error before then must find this room stateless, not the last one's frame.
    savedReplay = null; recordingFailed = false; playerId = null;
    liveMap = null; liveState = null; presentation = null; roundTripMs = null; lastStateAt = 0;
    owner = false; dev = false;
    onJoining({ kit });
    setPaused(false);
    discovery.reset();
    roomId = room; ownerKey = key;
    showStatus('CONNECTING');
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    // Items and gates arrive as changes against a keyframe this socket was sent (shared/frame-layers.ts).
    ws = socket; const layers = createLayerDecoder();
    socket.addEventListener('open', () => {
      disconnecting = false;
      let resumeKey;
      try { if (room) resumeKey = sessionStorage.getItem(`last-exit:resume:${room}`); } catch { /* Optional recovery. */ }
      socket.send(JSON.stringify(matchmake
        ? { type: CLIENT_MESSAGE.MATCH, role, kit, name }
        : { type: CLIENT_MESSAGE.JOIN, room, ownerKey: key, resumeKey, mode, ...(mode === 'player' ? { role, kit, name } : {}) }));
    });
    socket.addEventListener('message', event => {
      if (ws !== socket) return;
      const data = JSON.parse(event.data);
      if (data.type === SERVER_MESSAGE.WELCOME || data.type === SERVER_MESSAGE.READY) {
        const described = envelopePresentation(data);
        if (!described) { toast('The arena sent a match this browser cannot read.'); showStatus('UNAVAILABLE'); disconnecting = true; socket.close(); return; }
        presentation = described;
      }
      if (data.type === SERVER_MESSAGE.WELCOME) {
        room = data.room; roomId = room;
        try { if (data.resumeKey) sessionStorage.setItem(`last-exit:resume:${room}`, data.resumeKey); } catch { /* Optional recovery. */ }
        playerId = data.id; owner = data.owner; liveMap = data.map; liveState = data.state; dev = !!data.dev;
        learn(data.state);
        if (owner && !dev) {
          try { sessionStorage.setItem(`last-exit:owner:${room}`, JSON.stringify({ key, role, kit, name })); }
          catch { toast('Owner recovery is unavailable in this browser session. Keep this tab open.'); }
        }
        setPaused(!!data.paused);
        onWelcome(data);
      } else if (data.type === SERVER_MESSAGE.READY) {
        liveMap = data.map; liveState = data.state;
        onReady(data);
      } else if (data.type === SERVER_MESSAGE.STATE) {
        notePacket(event.data.length); layers.decode(data.state);
        learn(data.state);
        // Gap between authoritative frames: separates server pacing from client render cost.
        const receivedAt = performance.now();
        if (lastStateAt) profiler.observe('net.stateGap', receivedAt - lastStateAt);
        lastStateAt = receivedAt;
        profiler.observe('net.stateBytes', event.data.length, 'n');
        liveState = data.state;
        onState(data.state);
      } else if (data.type === SERVER_MESSAGE.PING) {
        // Echoed immediately and unmodified. The server times its own round trip; this end
        // states nothing about latency, it only returns a token it could not have held earlier.
        socket.send(JSON.stringify({ type: CLIENT_MESSAGE.PONG, token: data.token }));
        roundTripMs = data.rtt ?? null;
      } else if (data.type === SERVER_MESSAGE.LOBBY) {
        onLobby(data);
      } else if (data.type === SERVER_MESSAGE.CHOOSE) {
        if (!data.ok) toast(data.message);
      } else if (data.type === SERVER_MESSAGE.TELEPORT) {
        onTeleport(data);
      } else if (data.type === SERVER_MESSAGE.PAUSED) {
        setPaused(data.paused);
      } else if (data.type === SERVER_MESSAGE.SAVED) {
        if (recordingFailed) return;
        savedReplay = data.replay;
        onSaved();
      } else if (data.type === SERVER_MESSAGE.REPLAY_STATUS) {
        if (data.status === 'failed') recordingFailed = true;
        toast(data.message || (data.status === 'partial' ? 'Replay recording is partial.' : 'Replay recording failed.'));
      } else if (data.type === SERVER_MESSAGE.ERROR) {
        onError(data);
      }
    });
    // A close clears nothing here: the last frame stays available to whatever is showing it.
    socket.addEventListener('close', () => { if (ws === socket && !disconnecting) onClose(); });
    socket.addEventListener('error', () => { if (ws === socket) toast('Unable to connect to the arena server.'); });
  }
  return {
    join,
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    /** Sends a message if the socket is open, and says whether it did. */
    send(message) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(message)); return true;
    },
    bufferedBytes: () => ws?.bufferedAmount,
    roomId: () => roomId, ownerKey: () => ownerKey, playerId: () => playerId, isOwner: () => owner, isDev: () => dev,
    liveMap: () => liveMap, liveState: () => liveState, presentation: () => presentation,
    /** The coarse cells this player has discovered. */
    discovered: () => discovery.known,
    roundTripMs: () => roundTripMs, paused: () => paused, savedReplay: () => savedReplay,
    /** A new map shown to this player starts their discovery again, from its first frame. */
    reseedDiscovery(frame) { discovery.reset(); learn(frame); },
    /** The room gave up before its match began: its frame, then its labels, are no longer this page's. */
    forgetFrame() { liveState = null; },
    forgetPresentation() { presentation = null; },
    /** Whether this browser holds a room's owner key, which an `owner` policy asks of a dev view. */
    ownsRoom: id => !!ownerRecord(id)?.key,
    /** An owner reconnecting without a resume key rejoins as they now are, not as they first deployed. */
    rememberChoice(role, kit) {
      if (!owner) return;
      const saved = ownerRecord(roomId);
      try { if (saved) sessionStorage.setItem(`last-exit:owner:${roomId}`, JSON.stringify({ ...saved, role, kit })); } catch { /* Storage may be unavailable. */ }
    },
  };
}
