import { movePlayer } from '/shared/movement.ts';
import { createInputController } from '/input-controller.js';
import { createHUDController } from '/hud-controller.js';
import { notePacket, resetDiagnostics, diagnosticTimings, reportDiagnostics, manualMark, forgetTiming } from '/diagnostics.js';
import { makeArenaScene } from '/arena-scene.js';
import { createReplayController } from '/replay-controller.js';
import { createCameraDirector } from '/camera-director.js';
import { createSnapshotBuffer } from '/snapshot-buffer.js';
import * as profiler from '/shared/profiler.ts';
import { createLayerDecoder } from '/shared/frame-layers.ts';
import { createDiscoveryDecoder } from '/shared/discovery.ts';
import { readPresentation } from '/shared/presentation.ts';
import { CLIENT_MESSAGE, SERVER_MESSAGE, HTTP_ENDPOINT } from '/shared/protocol.ts';
import { DEFAULT_KIT } from '/shared/simulation/rules.ts';
import { contentById } from '/shared/simulation/content.ts';
import { transitOptions } from '/shared/simulation/transit.ts';
import { downloadJson } from '/download.js';
import { createLobbyController } from '/lobby-controller.js';
import { createDeployController } from '/deploy-controller.js';
import { createArchiveController } from '/archive-controller.js';
import { createProfileOverlay } from '/profile-overlay.js';
import { THEMES, DEFAULT_THEME, themeColors, css } from '/palette.js';
import { $, HZ, INTERPOLATION_DELAY_TICKS, DEFAULT_CALLSIGN, fillFollowOptions } from '/ui.js';

const icon = name => `<i data-lucide="${name}"></i>`;
const icons = () => window.lucide?.createIcons();
let ws, roomId, ownerKey, playerId, owner = false, arenaMap, state, liveMap, liveState, predicted;
let seq = 0, pending = [], savedReplay, recordingFailed = false;
let physicsPrediction = null, predictionLoading = false, predictionEpoch = 0;
function resetPhysicsPrediction() {
  predictionEpoch++; physicsPrediction?.dispose(); physicsPrediction = null; predictionLoading = false;
}
function correctPhysicsPrediction(frame) {
  if (physicsPrediction) { predicted = physicsPrediction.correct(frame) || predicted; return; }
  if (predictionLoading) return;
  predictionLoading = true;
  const epoch = predictionEpoch, map = arenaMap, id = playerId;
  import('/physics-prediction.js').then(m => m.createPhysicsPrediction(map, id)).then(controller => {
    if (epoch !== predictionEpoch) { controller.dispose(); return; }
    physicsPrediction = controller; predictionLoading = false;
    if (state?.physicsProfile && !directed()) {
      predicted = controller.correct(state) || predicted;
      for (const input of pending) predicted = controller.input(input) || predicted;
    }
  }).catch(error => {
    if (epoch === predictionEpoch) {
      // Keep server-driven motion if initialization is unavailable; nothing else predicts a physics match.
      console.error('Physics prediction unavailable', error);
    }
  });
}
let discoveryDecoder = createDiscoveryDecoder();
// This connection is the dev view (24): undelayed and unfogged, with the director's free camera.
let devView = false, devRoster = '';
// A player who has stepped out to the dev view (#246) keeps their own socket, and their slot, and
// watches through this second one. Closing it returns them to their own view.
let devFeed = null;
const inDevView = () => devView || !!devFeed;
// A dev pause has stopped this room's clock (24): no frames arrive and no input is sent.
let paused = false;
// Authoritative frames are buffered and read back at a fixed delay, so what is drawn is
// interpolated between two received states rather than chasing the newest one.
const snapshots = createSnapshotBuffer({ hz: HZ, delayTicks: INTERPOLATION_DELAY_TICKS });
let presentation = null;
// Display metadata for each view (22.7), apart from the interpolated frame above: the room this socket
// joined, the dev feed stepped out to, and (in the replay controller) the open recording. Each is set
// only by its own source, so a live update behind a replay or the dev view never relabels them.
let liveContentPresentation = null, devPresentation = null;
const inputController = createInputController({
  getPlayer: () => state?.players.find(p => p.id === playerId),
  onSelectionChange: () => updateHUD(), onToggleFullscreen: () => toggleFullscreen(),
  onToggleReplay: () => { if (replayController.active()) replayController.togglePlay(); else if (inDevView()) togglePause(); },
  onMarkLag: () => markLag()
});
const hudController = createHUDController({
  selectSlot: index => inputController.selectSlot(index), arrange: () => inputController.toggleArrange(),
  skill: () => inputController.skill(), interact: () => inputController.interact(), drop: () => inputController.drop(),
  reload: () => inputController.reload(), dropAmmo: family => inputController.dropAmmo(family),
  transit: stationId => inputController.transit(stationId),
  moveSlot: (from, to) => inputController.moveSlot(from, to), dropSlot: from => inputController.dropSlot(from),
  cancelPointerFire: () => inputController.setPointerFire(false),
  canDrag: () => !replayController.active() && state?.players.some(p => p.id === playerId && p.role === 'contestant' && p.status === 'active'),
  toggleFullscreen: () => toggleFullscreen()
});
const director = createCameraDirector({
  getState: () => presentationFrame(), active: () => directed(),
  getSubject: id => {
    if (replayController.active() && !replayController.positionAt(id)) return null;
    return presentationFrame()?.players.find(p => p.id === id) || null;
  },
  getPosition: id => replayController.active() ? replayController.positionAt(id) : undefined,
  camera: () => scene?.cameraView() ?? { x: 0, y: 0, zoom: 1 },
  onFollow: (subject, id, announce) => {
    $('replay-focus').value = id || ''; $('dev-focus').value = id || '';
    // A cut, not a pan: gliding a camera across a 24000 unit arena would lose the subject for seconds.
    scene?.cutTo();
    updateHUD();
    if (announce && subject) toast(`Following ${subject.name}`);
  },
  onFog: (fog, announce) => {
    $('dev-fog').classList.toggle('active', fog); $('dev-fog').setAttribute('aria-pressed', String(fog));
    updateHUD();
    if (announce) toast(fog ? 'Followed players are shown in their own sight' : 'Fog off: followed players see everything');
  },
});
const replayController = createReplayController({
  fetchJSON: json, changeMap, acceptState, updateHUD, clearInput, toast, connection,
  getMap: () => arenaMap, getState: () => state, setState: value => state = value,
  getScene: () => scene, getLiveMap: () => liveMap, getLiveState: () => liveState,
  liveConnectionLabel: () => ws?.readyState === WebSocket.OPEN ? (inDevView() ? 'DEV VIEW' : 'LIVE') : 'OFFLINE',
  downloadReplay: id => archive.download(id), icon, icons, director,
});
let toastTimer, disconnecting = false;
// When the player socket last delivered a frame. It is the network's own measure, kept by the socket that
// receives the frames rather than by whatever is being drawn: a replay or the dev feed showing in its
// place must neither stall it nor stand in for it.
let lastLiveStateAt = 0;
// What the server last measured for this connection, for display only.
let roundTripMs = null;
const directed = () => replayController.active() || !playerId || !!devFeed;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function connection(message) { $('connection-text').textContent = message; }
async function json(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function clearInput() { hudController.cancelDrag(); inputController.reset(); }
document.addEventListener('visibilitychange', () => {
  if (!state?.physicsProfile) return;
  resetPhysicsPrediction(); clearInput();
  const me = state.players.find(p => p.id === playerId);
  predicted = me && { ...me }; scene?.cutTo();
});
function changeMap(map) { resetPhysicsPrediction(); director.clearPosition(); arenaMap = structuredClone(map); if (scene?.ready) scene.buildMap(); }
/** Where the player may transit to now, when the live content lets a gladiator choose (#692); else null. */
function transitChoices() {
  if (replayController.active() || devFeed || !state || !predicted || !arenaMap) return null;
  let selectable = false;
  try { selectable = contentById(displayPresentation()?.contentId).transit === 'selectable'; } catch { /* an unknown id chooses nothing */ }
  const me = state.players.find(p => p.id === playerId);
  return selectable && me ? transitOptions({ map: arenaMap, hazardX: state.hazardX }, { ...me, x: predicted.x, y: predicted.y }) : null;
}
/** The descriptor of whatever is shown: the open recording, the dev feed, or the live room. */
function displayPresentation() {
  if (replayController.active()) return replayController.presentation();
  return devFeed ? devPresentation : liveContentPresentation;
}
/**
 * A welcome or ready's descriptor, validated against its content id before anything of it is installed.
 * Every live envelope carries both, since the server ships with this browser; one without is refused.
 */
function envelopePresentation(data) {
  return typeof data.contentId === 'string' && data.contentId ? readPresentation(data.presentation, data.contentId) : null;
}
// Labels follow a descriptor change even when no item id or count changed.
function presentationChanged() {
  devRoster = '';
  if (lobby.open()) lobby.redraw();
  if (state) { if (inDevView()) refreshDevRoster(); updateHUD(); }
}
// A player's own HUD shows only while they play: not in the lobby, nor while stepped out to the dev view,
// which the non-modal lobby lets them do before the start (#267 review).
function showPlayerHud() {
  if (playerId && !replayController.active()) $('live-hud').hidden = !!devFeed || lobby.open();
}
function showLobby(data) {
  lobby.show(data);
  showPlayerHud();
  if (!devFeed) connection(owner ? 'LOBBY' : 'WAITING');
}
function hideLobby() {
  lobby.hide();
  showPlayerHud();
}
async function connect({ room, key, mode = 'player', role = 'contestant', kit = DEFAULT_KIT, name = DEFAULT_CALLSIGN, matchmake = false }) {
  const saved = ownerRecord(room);
  // A dev view borrows the owner key for an `owner` policy, but never the owner's player slot.
  if (!key && saved?.key) { key = saved.key; if (mode === 'player') { role = saved.role; kit = saved.kit; name = saved.name; } }
  leaveDevView();
  savedDevCamera = null;
  if (ws) { disconnecting = true; ws.close(); }
  clearInput(); pending = []; seq = 0; savedReplay = null; recordingFailed = false; playerId = null;
  resetPhysicsPrediction();
  // Nothing of the previous room carries over: a room still generating sends no state until `ready`,
  // and an error before then must find this room stateless, not the last one's frame.
  state = null; liveMap = null; liveState = null; predicted = null;
  snapshots.reset(); presentation = null; liveContentPresentation = null; roundTripMs = null; lastLiveStateAt = 0;
  // A replay still loading belongs to the view being left.
  replayController.cancel();
  resetDiagnostics();
  owner = false; lobby.reset(kit); devView = false; devRoster = ''; director.reset(); setPaused(false);
  discoveryDecoder.reset();
  archive.reset();
  // `mode` and `role` say how this connection joins; the deploy dialog's own choice of role is untouched.
  roomId = room; ownerKey = key;
  connection('CONNECTING');
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
      if (!described) { toast('The arena sent a match this browser cannot read.'); connection('UNAVAILABLE'); disconnecting = true; socket.close(); return; }
      liveContentPresentation = described;
    }
    if (data.type === SERVER_MESSAGE.WELCOME) {
      room = data.room; roomId = room;
      try { if (data.resumeKey) sessionStorage.setItem(`last-exit:resume:${room}`, data.resumeKey); } catch { /* Optional recovery. */ }
      playerId = data.id; owner = data.owner; liveMap = data.map; liveState = data.state; devView = !!data.dev;
      const me = data.state?.players?.find(p => p.id === playerId);
      if (me?.discovered) discoveryDecoder.decode(me.discovered);
      $('dev-view').hidden = !data.devTools || devView; $('dev-controls').hidden = !devView;
      if (owner && !devView) {
        try { sessionStorage.setItem(`last-exit:owner:${room}`, JSON.stringify({ key, role, kit, name })); }
        catch { toast('Owner recovery is unavailable in this browser session. Keep this tab open.'); }
      }
      replayController.reset();
      $('live-hud').hidden = !!data.spectator;
      // A room whose map is still generating sends it later, in `ready`.
      if (data.map) { changeMap(data.map); acceptState(data.state); }
      setPaused(!!data.paused);
      history.replaceState(null, '', `?room=${room}${devView ? '&dev' : ''}`);
      connection(devView ? 'DEV VIEW' : data.spectator ? 'SPECTATING' : data.started ? 'LIVE' : 'LOBBY'); deploy.close();
      if (!data.spectator && !data.started) showLobby(data);
      presentationChanged();
    } else if (data.type === SERVER_MESSAGE.READY) {
      liveMap = data.map; liveState = data.state;
      // A new map starts its own ticks, as at the start when players leave the waiting area (#236), so
      // neither buffered frames nor inputs predicted on the old map carry over.
      if (!replayController.active() && !devFeed) {
        snapshots.reset(); pending = []; discoveryDecoder.reset();
        const me = data.state?.players?.find(p => p.id === playerId);
        if (me?.discovered) discoveryDecoder.decode(me.discovered);
        changeMap(data.map); acceptState(data.state);
      }
      presentationChanged();
    } else if (data.type === SERVER_MESSAGE.STATE) {
      notePacket(event.data.length); layers.decode(data.state);
      const me = data.state.players?.find(p => p.id === playerId);
      if (me?.discovered) discoveryDecoder.decode(me.discovered);
      // Gap between authoritative frames: separates server pacing from client render cost.
      const receivedAt = performance.now();
      if (lastLiveStateAt) profiler.observe('net.stateGap', receivedAt - lastLiveStateAt);
      lastLiveStateAt = receivedAt;
      profiler.observe('net.stateBytes', event.data.length, 'n');
      liveState = data.state;
      if (!replayController.active() && !devFeed) acceptState(data.state);
    } else if (data.type === SERVER_MESSAGE.PING) {
      // Echoed immediately and unmodified. The server times its own round trip; this end
      // states nothing about latency, it only returns a token it could not have held earlier.
      socket.send(JSON.stringify({ type: CLIENT_MESSAGE.PONG, token: data.token }));
      roundTripMs = data.rtt ?? null;
    } else if (data.type === SERVER_MESSAGE.LOBBY) {
      lobby.update(data);
      if (data.started) { if (!devView) { hideLobby(); connection(devFeed ? 'DEV VIEW' : 'LIVE'); } }
      else if (playerId) showLobby(data);
    } else if (data.type === SERVER_MESSAGE.CHOOSE) {
      if (!data.ok) toast(data.message);
    } else if (data.type === SERVER_MESSAGE.TELEPORT) {
      const who = state?.players.find(p => p.id === data.id)?.name || 'Player';
      toast(data.ok ? `${who} moved` : `${who} cannot stand there`);
    } else if (data.type === SERVER_MESSAGE.PAUSED) {
      setPaused(data.paused);
    } else if (data.type === SERVER_MESSAGE.SAVED) {
      if (recordingFailed) return;
      savedReplay = data.replay; $('watch-match').disabled = false;
      archive.refresh();
    } else if (data.type === SERVER_MESSAGE.REPLAY_STATUS) {
      if (data.status === 'failed') recordingFailed = true;
      toast(data.message || (data.status === 'partial' ? 'Replay recording is partial.' : 'Replay recording failed.'));
    } else if (data.type === SERVER_MESSAGE.ERROR) {
      toast(data.message); connection('UNAVAILABLE');
      deploy.showError(data.message);
      // Includes a room given up while its map generated: its lobby and waiting yard are gone, so back to
      // the deploy dialog.
      if (!playerId || !state || state.phase === 'waiting') {
        if (state?.phase === 'waiting') { state = null; liveState = null; predicted = null; snapshots.reset(); }
        // The room view is discarded, and its labels with it.
        if (!state) liveContentPresentation = null;
        lobby.hide();
        deploy.open();
      }
    }
  });
  socket.addEventListener('close', () => {
    if (ws === socket && !disconnecting) { connection('OFFLINE'); clearInput(); resetPhysicsPrediction(); if (!replayController.active()) toast('Connection closed. Open Lobbies to reconnect.'); }
  });
  socket.addEventListener('error', () => { if (ws === socket) toast('Unable to connect to the arena server.'); });
}
function acceptState(next) {
  state = next;
  if (!replayController.active()) snapshots.push(next);
  if (!arenaMap) return;
  arenaMap.gates = state.gates;
  if (inDevView()) refreshDevRoster();
  const me = state.players.find(p => p.id === playerId);
  if (me && !replayController.active() && !devFeed) {
    pending = pending.filter(i => i.seq > me.lastSeq).slice(-20);
    predicted = { ...me };
    if (state.physicsProfile) correctPhysicsPrediction(state);
    else {
      // The waiting area (#236) is the frame without a physics profile: its simulation moves players with
      // `movePlayer` (shared/simulation/waiting.ts), so it is predicted the same way, here and in `inputTick`.
      if (physicsPrediction || predictionLoading) resetPhysicsPrediction();
      if (me.status === 'active') for (const input of pending) movePlayer(arenaMap, predicted, input);
    }
  } else if (!me && !directed()) {
    predicted = null; resetPhysicsPrediction();
  }
  updateHUD();
}
// The dev view's focus list tracks the live roster: players join, and bots fill slots at the start.
function refreshDevRoster() {
  const key = state.players.map(p => p.id).join();
  if (key === devRoster) return;
  const select = $('dev-focus'), id = director.followId();
  const previous = [...select.options].find(option => option.value === id)?.textContent;
  devRoster = key; fillFollowOptions(select, state.players, displayPresentation());
  if (id && !state.players.some(player => player.id === id)) select.add(new Option(previous || `${id} (absent)`, id));
  select.value = id || '';
}
// What the renderer draws: the buffered, interpolated view when live, and the frame a replay's own
// playhead selects when a recording is open. `state` stays the newest authoritative frame, which is
// what the HUD, prediction and every gameplay read use.
function presentationFrame() { return replayController.active() ? state : presentation || state; }
function currentView() {
  if (replayController.active()) return 'replay';
  if (inDevView()) return 'dev';
  if (!state || state.phase === 'waiting' || lobby.open()) return 'lobby';
  if (!playerId) return 'spectator';
  const me = state.players.find(p => p.id === playerId);
  if (!me || me.status !== 'active' || state.phase === 'finished') return 'outcome';
  return 'play';
}
function updateDevLeaveLabel() {
  if (!devFeed) return;
  const me = liveState?.players?.find(p => p.id === playerId) || state?.players?.find(p => p.id === playerId);
  const ended = me && (me.status !== 'active' || state?.phase === 'finished');
  const label = ended ? 'Back to results' : 'Back to player';
  const span = $('dev-leave').querySelector('span');
  if (span && span.textContent !== label) {
    span.textContent = label;
  } else if (!span) {
    $('dev-leave').innerHTML = `<i data-lucide="user"></i><span>${label}</span>`;
    icons();
  }
}
function updateHUD() {
  updateDevLeaveLabel();
  hudController.render({ state, arenaMap, playerId, view: currentView(), savedReplay,
    presentation: displayPresentation(), hz: replayController.active() ? replayController.hz() : HZ,
    selection: inputController.selection(), transit: transitChoices(),
    visibility: { directed: directed(), fogged: directed() && director.fog() && !!director.followId(), viewer: director.viewer(), sight: scene?.sight },
    discovery: discoveryDecoder?.known
  });
  showPlayerHud();
}

// The arena's palette (11.1): `?palette=` names one, or the dev view's menu picks one. It is this
// browser's choice alone and only recolours the drawing; no simulation, wire or recording sees it.
const PALETTE_KEY = 'last-exit:palette';
let palette = (() => {
  const asked = new URLSearchParams(location.search).get('palette');
  if (Object.hasOwn(THEMES, asked ?? '')) return asked;
  try { const saved = localStorage.getItem(PALETTE_KEY); if (Object.hasOwn(THEMES, saved ?? '')) return saved; } catch { /* Storage may be unavailable. */ }
  return DEFAULT_THEME;
})();
function choosePalette(id) {
  palette = Object.hasOwn(THEMES, id) ? id : DEFAULT_THEME;
  try { localStorage.setItem(PALETTE_KEY, palette); } catch { /* Storage may be unavailable. */ }
  $('dev-palette').value = palette; scene?.setPalette(palette);
}
let scene;
const ArenaScene = makeArenaScene({
  palette: () => palette,
  map: () => arenaMap, state: () => presentationFrame(), playerId: () => playerId,
  kits: () => displayPresentation()?.kits,
  self: () => !replayController.active() && predicted ? predicted : state?.players.find(p => p.id === playerId) || null,
  localPhysics: () => !directed() && !!state?.physicsProfile,
  predictionCut: () => physicsPrediction?.stats().cuts,
  replay: () => replayController.active(), directed, aim: () => inputController.aim(),
  // Geometry is match display data, shown only after a dev welcome has authorized this view, and
  // only over a frame that carries physics bodies.
  geometryOverlay: () => !replayController.active() && !!presentationFrame()?.physicsProfile
    && (devView || devFeed && devPresentation)
    ? displayPresentation()?.actorGeometry ?? null : null,
  director, follow: () => directed() ? director.subject() : null,
  // How far into the current authoritative tick the renderer is, so motion that only updates on a
  // server frame can be advanced smoothly between them.
  frameAlpha: () => replayController.active() ? replayController.frameAlpha() : (presentationFrame()?.alpha ?? 0),
  onReady: value => scene = value, onFire: value => inputController.setPointerFire(value),
  onFrame: () => {
    if (!replayController.active()) {
      presentation = snapshots.frame() || state;
      if (directed() && presentation) director.observeState(presentation);
    }
    replayController.renderFrame();
  },
  onSight: () => {
    if (directed()) hudController.drawMinimap({ state: presentationFrame(), arenaMap, playerId,
      visibility: { directed: true, fogged: director.fog() && !!director.followId(), viewer: director.viewer(), sight: scene?.sight } });
  }
});
// Diagnostic reports ride beside inputs but are metadata: the server records them as marks on the
// replay and the simulation never sees them. They name the tick this client was drawing.
reportDiagnostics(() => (replayController.active() || !playerId || devFeed ? null : presentation?.tick ?? state?.tick ?? null),
  report => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: CLIENT_MESSAGE.DIAGNOSTIC, ...report })); });
function markLag() { if (manualMark()) toast('Lag flagged for the replay'); }
$('mark-lag').onclick = markLag;
function toggleFullscreen() { if (!document.fullscreenElement) { document.documentElement.requestFullscreen().catch(() => {}); } else { document.exitFullscreen().catch(() => {}); } }
document.addEventListener('fullscreenchange', () => { const isFull = !!document.fullscreenElement; $('fullscreen-toggle').classList.toggle('active', isFull); $('fullscreen-toggle').innerHTML = `<i data-lucide="${isFull ? 'minimize' : 'maximize'}"></i>`; icons(); });
function setPaused(value) {
  if (paused === value) return;
  paused = value; $('paused-banner').hidden = !paused;
  // Packet gaps across a pause are the pause, not the network.
  forgetTiming();
  if (paused) clearInput();
  $('dev-pause').innerHTML = icon(paused ? 'play' : 'pause'); $('dev-pause').ariaLabel = paused ? 'Resume match' : 'Pause match';
  $('dev-pause').dataset.tip = paused ? 'Resume (Space)' : 'Pause (Space)'; icons();
}
function togglePause() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: CLIENT_MESSAGE.DEV, action: paused ? 'resume' : 'pause' }));
}
function inputTick() {
  if (state?.physicsProfile && document.hidden) return;
  if (paused || devFeed || replayController.active() || !state || !predicted || !ws || ws.readyState !== WebSocket.OPEN || predicted.status !== 'active') { hudController.cancelDrag(); return; }
  const blocked = document.querySelector('dialog:modal');
  if (blocked) hudController.cancelDrag();
  let pointerAim;
  if (scene?.ready) {
    const point = scene.cameras.main.getWorldPoint(scene.input.activePointer.x, scene.input.activePointer.y);
    pointerAim = Math.atan2(point.y - predicted.y, point.x - predicted.x);
  }
  const input = { type: CLIENT_MESSAGE.INPUT, seq: seq++, ...inputController.collectIntent({ blocked, pointerAim }) };
  ws.send(JSON.stringify(input)); pending.push(input); pending = pending.slice(-20);
  if (state.physicsProfile) predicted = physicsPrediction?.input(input) || predicted;
  else movePlayer(arenaMap, predicted, input);
  inputController.consumeActions();
  hudController.setSneak(input.sneak);
}
// The room-keyed owner record in session storage: what lets this browser reclaim a room it created.
function ownerRecord(room) {
  try { return JSON.parse(sessionStorage.getItem(`last-exit:owner:${room}`)); } catch { return null; /* Storage may be unavailable. */ }
}
const lobby = createLobbyController({
  getRoomId: () => roomId, getPlayerId: () => playerId, isOwner: () => owner, getPresentation: () => liveContentPresentation,
  choose: (role, kit) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: CLIENT_MESSAGE.CHOOSE, role, kit })); },
  start: () => { if (ws?.readyState === WebSocket.OPEN && owner) ws.send(JSON.stringify({ type: CLIENT_MESSAGE.START })); },
  copyLink: () => share(),
  // An owner reconnecting without a resume key rejoins as they now are, not as they first deployed.
  onOwnChoice: (role, kit) => {
    if (!owner) return;
    const saved = ownerRecord(roomId);
    try { if (saved) sessionStorage.setItem(`last-exit:owner:${roomId}`, JSON.stringify({ ...saved, role, kit })); } catch { /* Storage may be unavailable. */ }
  },
  icons,
});
const deploy = createDeployController({
  fetchJSON: json, connect, toast, clearInput, icon, icons,
  ownsRoom: id => !!ownerRecord(id)?.key,
});
const archive = createArchiveController({
  fetchJSON: json, toast, clearInput, icon, icons,
  watch: id => watchReplay(id), cachedReplay: id => replayController.cachedData(id),
  canFinish: () => !!owner && !!liveState && liveState.phase !== 'finished',
  finish: () => {
    if (ws?.readyState !== WebSocket.OPEN || !owner) return false;
    ws.send(JSON.stringify({ type: CLIENT_MESSAGE.FINISH })); return true;
  },
});
document.querySelectorAll('.close-dialog').forEach(button => button.onclick = () => button.closest('dialog').close());
const share = async () => { try { await navigator.clipboard.writeText(location.href); toast('Arena link copied'); } catch { toast('Arena link: ' + location.href); } };
$('share').onclick = share;
// Which path drew the frames. A software or Canvas fallback is slow below our code, where the profile
// cannot see it (42.2); the adapter name says which GPU, not who is playing.
function rendererReport() {
  const gl = game.renderer?.gl, debug = gl?.getExtension('WEBGL_debug_renderer_info');
  return { type: gl ? 'webgl' : 'canvas', adapter: gl ? gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null,
    canvas: { width: game.canvas.width, height: game.canvas.height } };
}
// Counts only, so a report can say whether a crowd was near without naming anyone: actors in the
// frame drawn, those inside the camera, and those shown in sight.
function crowdReport() {
  const frame = presentationFrame(), view = scene?.cameras?.main.worldView;
  if (!frame || !view) return null;
  return { received: frame.players.length, inCamera: frame.players.filter(p => view.contains(p.x, p.y)).length,
    shown: [...scene.actors.values()].filter(a => a.container.visible).length };
}
async function downloadDiagnostics() {
  const me = state?.players.find(p => p.id === playerId);
  const report = { capturedAt: new Date().toISOString(), version: state?.version, content: displayPresentation()?.contentId ?? null,
    seed: arenaMap?.seed, map: arenaMap && { width: arenaMap.width, height: arenaMap.height }, tick: state?.tick,
    role: me?.role, position: me && { x: me.x, y: me.y }, viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, visibility: document.visibilityState,
    renderer: rendererReport(), crowd: crowdReport(),
    socketBufferedBytes: ws?.bufferedAmount, timings: diagnosticTimings(), profile: profiler.report() };
  try { report.server = await json(HTTP_ENDPOINT.HEALTH); } catch { report.server = { reachable: false }; }
  downloadJson(`last-exit-diagnostics-${Date.now()}.json`, report, 2);
}
$('download-diagnostics').onclick = () => void downloadDiagnostics();
let savedDevCamera = null;
// The dev view opens beside the match rather than in place of it, so a player keeps their slot.
function enterDevView() {
  if (devFeed || !playerId || replayController.active() || ws?.readyState !== WebSocket.OPEN) return;
  clearInput(); replayController.cancel();
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  devFeed = socket;
  if (savedDevCamera && savedDevCamera.roomId === roomId) {
    director.restore(savedDevCamera.camera);
  }
  showDevMode(); const layers = createLayerDecoder();
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: CLIENT_MESSAGE.JOIN, room: roomId, ownerKey, mode: 'dev' })));
  socket.addEventListener('message', event => {
    if (devFeed !== socket) return;
    const data = JSON.parse(event.data);
    // Only the frames come from here; pauses, the lobby and replays still arrive on the player's socket.
    if (data.type === SERVER_MESSAGE.WELCOME || data.type === SERVER_MESSAGE.READY) {
      const described = envelopePresentation(data);
      if (!described) { toast('The dev view sent a match this browser cannot read.'); leaveDevView(); return; }
      devPresentation = described; devRoster = '';
      if (data.map) { snapshots.reset(); changeMap(data.map); acceptState(data.state); }
      else presentationChanged();
    }
    else if (data.type === SERVER_MESSAGE.STATE) { layers.decode(data.state); if (!replayController.active()) acceptState(data.state); }
    else if (data.type === SERVER_MESSAGE.ERROR) { toast(data.message); leaveDevView(); }
  });
  socket.addEventListener('close', () => { if (devFeed === socket) leaveDevView(); });
}
function leaveDevView() {
  const socket = devFeed;
  if (!socket) return;
  savedDevCamera = { roomId, camera: director.snapshot() };
  devFeed = null; devPresentation = null; devRoster = ''; socket.close(); director.reset(); snapshots.reset();
  if (liveMap && liveState && !replayController.active()) { changeMap(liveMap); acceptState(liveState); }
  showDevMode(); scene?.cutTo();
}
function showDevMode() {
  const on = inDevView();
  $('dev-controls').hidden = !on; $('dev-leave').hidden = !devFeed;
  updateHUD();
  $('dev-view').classList.toggle('active', !!devFeed); $('dev-view').setAttribute('aria-pressed', String(!!devFeed));
  if (ws?.readyState === WebSocket.OPEN && !replayController.active()) connection(on ? 'DEV VIEW' : 'LIVE');
}
const watchReplay = id => { leaveDevView(); void replayController.watch(id); };
$('dev-view').onclick = () => devFeed ? leaveDevView() : enterDevView();
$('dev-leave').onclick = () => leaveDevView();
// T sends the followed player, or your own when you have stepped out of it, to the point under the cursor.
function teleportToCursor() {
  const id = director.followId() || (devFeed ? playerId : null);
  if (!id) return toast('Follow a player to teleport them');
  const point = scene?.pointerWorld();
  if (point && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: CLIENT_MESSAGE.DEV, action: 'teleport', id, x: point.x, y: point.y }));
}
addEventListener('keydown', event => {
  if (event.code !== 'KeyT' || event.repeat || !inDevView() || replayController.active() || event.target.closest?.('input, textarea, select') || document.querySelector('dialog:modal')) return;
  teleportToCursor();
});
// Backquote steps out to the dev view and back, wherever the button is.
addEventListener('keydown', event => {
  if (event.code !== 'Backquote' || event.repeat || event.target.closest?.('input, textarea, select') || document.querySelector('dialog:modal') || $('dev-view').hidden) return;
  devFeed ? leaveDevView() : enterDevView();
});
$('dev-focus').onchange = () => director.setFollow($('dev-focus').value);
$('dev-fog').onclick = () => director.setFog(!director.fog());
$('dev-whole').onclick = () => director.whole();
for (const [id, { label }] of Object.entries(THEMES)) $('dev-palette').add(new Option(label, id));
$('dev-palette').value = palette;
$('dev-palette').onchange = event => { choosePalette(event.currentTarget.value); event.currentTarget.blur(); };
// Focus would leave Space pressing this button as well as toggling the pause, which cancels out.
$('dev-pause').onclick = event => { togglePause(); event.currentTarget.blur(); };
$('watch-match').onclick = () => { if (savedReplay) watchReplay(savedReplay.id); };
icons();
const game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', backgroundColor: css(themeColors(palette).background), antialias: true, scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: ArenaScene, audio: { noAudio: true }, render: { preserveDrawingBuffer: true } });
// Phaser's own render pass runs after the scene's update, outside render.frame. It is where Graphics
// are tessellated and batched, so it must be timed separately or draw cost is invisible here.
game.events.on('prerender', () => profiler.start('render.draw'));
game.events.on('postrender', () => profiler.stop('render.draw'));
setInterval(inputTick, 50);
const initialParams = new URLSearchParams(location.search);
const initialRoom = initialParams.get('room');
// `?seed=` names the arena a new room generates (`?size=24x12` its zone size), as the Map Lab's "Play in the game" link does (53).
const overrides = {};
if (initialParams.get('seed')) overrides.seed = initialParams.get('seed');
if (initialParams.get('size')) overrides.size = initialParams.get('size');
deploy.prefill(overrides);
void deploy.loadConfig();
// `?room=…&dev` opens that room's dev view, as the dev view button does.
if (initialRoom) void connect({ room: initialRoom, key: initialParams.get('ownerKey'), ...(initialParams.has('dev') ? { mode: 'dev' } : {}) }); else void deploy.firstArena(overrides);
const profile = createProfileOverlay({
  toast,
  status: () => {
    const b = snapshots.stats(), me = state?.players.find(p => p.id === playerId);
    return [b.newest === null ? '' : `interp ${b.delayTicks} ticks behind (${(b.delayTicks * 1000 / HZ).toFixed(0)} ms), buffered ${b.depth}, rate ${b.rate.toFixed(2)}, starved ${b.starved}, cuts ${b.snaps}`,
      // Unacknowledged inputs the client is still replaying, and whether the server had to repeat one
      // because none had arrived. A stall is the signal that the send rate is losing to the tick rate.
      me ? `input pending ${pending.length}, stalled ${me.inputStalled ?? 0}` : '',
      roundTripMs === null ? '' : `rtt ${roundTripMs} ms (server measured)`];
  },
});
window.arenaProfile = () => ({ enabled: profiler.profiling(), frames: profiler.frameCount(), series: profiler.report() });
window.arenaProfiling = profile.setProfiling;
// Spectator connections exist on the server but have no interface yet; this is the hook the presenter
// tooling will grow from, and what the tests drive.
window.arenaSpectate = () => connect({ room: roomId, key: ownerKey, mode: 'spectator' });
// Read-only inspection surface for reproducible browser smoke tests.
window.arenaDebug = () => ({ tick: state?.tick, palette, version: state?.version, room: roomId, content: displayPresentation()?.contentId ?? null, directed: directed(), spectating: !!state && !playerId, shots: scene?.shots, me: state?.players.find(p => p.id === playerId), replay: replayController.active(), follow: director.followId(), dev: inDevView(), devFeed: !!devFeed, view: currentView(), paused, fog: director.fog(), viewer: director.viewer()?.id ?? null, phase: state?.phase, actorCount: scene?.actors.size, roofs: scene && [...scene.roofs].map(([id, roof]) => ({ id, visible: roof.visible })), actors: scene && [...scene.actors].map(([id, a]) => ({ id, visible: a.container.visible, x: a.container.x, y: a.container.y, geometry: { visible: a.geometry.visible, scale: a.geometry.scaleX, commands: a.geometry.visible ? a.geometry.commandBuffer : [] } })), markerScale: scene?.marker, aim: inputController.aim(), cameraWidth: scene?.cameras.main.worldView.width, cameraHeight: scene?.cameras.main.worldView.height, camera: scene && { x: scene.cameras.main.worldView.x, y: scene.cameras.main.worldView.y, zoom: scene.cameras.main.zoom }, mapWidth: arenaMap?.width, map: arenaMap && { seed: arenaMap.seed, width: arenaMap.width, height: arenaMap.height, playableArea: arenaMap.playableArea, exit: arenaMap.exit, spawns: arenaMap.spawns, hunterSpawns: arenaMap.hunterSpawns, stations: arenaMap.stations.map(({ x, y }) => ({ x, y })), chargers: arenaMap.chargers.map(({ x, y }) => ({ x, y })) }, vision: scene?.visionPoints, predicted: predicted && { x: predicted.x, y: predicted.y }, buffer: snapshots.stats(),
  discoveredCount: discoveryDecoder?.known.size ?? 0,
  physicsPrediction: physicsPrediction?.stats() ?? null,
  pending: pending.length, inputStalled: state?.players.find(p => p.id === playerId)?.inputStalled ?? null, rtt: roundTripMs });
