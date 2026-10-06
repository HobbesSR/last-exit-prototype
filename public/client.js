import { movePlayer } from '/shared/movement.ts';
import { createInputController } from '/input-controller.js';
import { createHUDController } from '/hud-controller.js';
import { notePacket, resetDiagnostics, diagnosticTimings, reportDiagnostics, manualMark, forgetTiming } from '/diagnostics.js';
import { makeArenaScene } from '/arena-scene.js';
import { createReplayController } from '/replay-controller.js';
import { createCameraDirector } from '/camera-director.js';
import { createSnapshotBuffer } from '/snapshot-buffer.js';
import * as profiler from '/shared/profiler.ts';
import { $, HZ, INTERPOLATION_DELAY_TICKS, kitName, time, fillFollowOptions } from '/ui.js';

const icon = name => `<i data-lucide="${name}"></i>`;
const icons = () => window.lucide?.createIcons();
let ws, roomId, ownerKey, playerId, owner = false, arenaMap, state, liveMap, liveState, predicted;
let seq = 0, pending = [], selectedRole = 'contestant', savedReplay, recordingFailed = false;
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
let lobbyPlayers = [];
// Advertised by the room rather than transcribed here: the roster that decides them is match content.
let lobbyCapacity = null;
let lobbyStartsAt = null;
// Whether the room's map exists yet (#258), and whether the owner's start is waiting on it.
let lobbyReady = true, lobbyStarting = false;
// The gladiator kit this player last held or picked in the lobby, kept across a spell as a contestant.
let lobbyKit = 'warden';
const inputController = createInputController({
  getPlayer: () => state?.players.find(p => p.id === playerId),
  onSelectionChange: () => updateHUD(), onToggleFullscreen: () => toggleFullscreen(),
  onToggleReplay: () => { if (replayController.active()) replayController.togglePlay(); else if (inDevView()) togglePause(); },
  onMarkLag: () => markLag()
});
const hudController = createHUDController({
  selectSlot: index => inputController.selectSlot(index), arrange: () => inputController.toggleArrange(),
  skill: () => inputController.skill(), interact: () => inputController.interact(), drop: () => inputController.drop(),
  moveSlot: (from, to) => inputController.moveSlot(from, to), dropSlot: from => inputController.dropSlot(from),
  cancelPointerFire: () => inputController.setPointerFire(false),
  canDrag: () => !replayController.active() && state?.players.some(p => p.id === playerId && p.role === 'contestant' && p.status === 'active'),
  toggleFullscreen: () => toggleFullscreen()
});
const director = createCameraDirector({
  // The followed player is found in the frame being drawn, so the camera holds them where their sprite is.
  getState: () => presentationFrame(), active: () => directed(),
  camera: () => scene?.cameraView() ?? { x: 0, y: 0, zoom: 1 },
  onFollow: (subject, id) => {
    $('replay-focus').value = id || ''; $('dev-focus').value = id || '';
    // A cut, not a pan: gliding a camera across a 24000 unit arena would lose the subject for seconds.
    scene?.cutTo();
    if (subject) toast(`Following ${subject.name}`);
  },
  onFog: fog => {
    $('dev-fog').classList.toggle('active', fog); $('dev-fog').setAttribute('aria-pressed', String(fog));
    toast(fog ? 'Followed players are shown in their own sight' : 'Fog off: followed players see everything');
  },
});
const replayController = createReplayController({
  fetchJSON: json, changeMap, acceptState, updateHUD, clearInput, toast, connection,
  getMap: () => arenaMap, getState: () => state, setState: value => state = value,
  getScene: () => scene, getLiveMap: () => liveMap, getLiveState: () => liveState,
  liveConnectionLabel: () => ws?.readyState === WebSocket.OPEN ? (inDevView() ? 'DEV VIEW' : 'LIVE') : 'OFFLINE',
  downloadReplay, icon, icons, director,
});
let toastTimer, connecting = false, disconnecting = false, lastStateAt = 0, profileOverlay;
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
function changeMap(map) { arenaMap = structuredClone(map); if (scene?.ready) scene.buildMap(); }
function updateLobby(data = {}) {
  lobbyStartsAt = data.startsAt || null;
  if ('ready' in data) lobbyReady = data.ready;
  lobbyStarting = !!data.starting;
  if (data.players) lobbyPlayers = data.players;
  if (data.capacity) lobbyCapacity = data.capacity;
  const contestants = lobbyPlayers.filter(p => p.role === 'contestant');
  const gladiators = lobbyPlayers.filter(p => p.role === 'gladiator');
  $('lobby-room').textContent = roomId || data.room || '';
  if ('name' in data) $('lobby-title').textContent = data.name || 'Arena lobby.';
  if (data.size) $('lobby-size').textContent = data.size.replace('x', ' × ');
  const places = role => lobbyCapacity ? `/${lobbyCapacity[role]}` : '';
  $('lobby-count').textContent = `${contestants.length}${places('contestant')} contestants / ${gladiators.length}${places('gladiator')} gladiators`;
  const render = (target, list, empty) => {
    target.replaceChildren();
    if (!list.length) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = empty; target.append(li); return;
    }
    for (const p of list) {
      const li = document.createElement('li'), name = document.createElement('strong'), meta = document.createElement('span');
      const kit = p.role === 'gladiator' ? ` / ${kitName(p.kit)}` : '';
      name.textContent = p.name; meta.textContent = `${p.role}${kit}`;
      li.append(name, meta); target.append(li);
    }
  };
  render($('lobby-contestants'), contestants, 'Open contestant slots will be bots.');
  render($('lobby-gladiators'), gladiators, 'Open gladiator slots will be bots.');
  showChoice(data.started);
  $('start-match').hidden = !owner;
  $('start-match').disabled = !owner || data.started || lobbyStarting;
  $('lobby-waiting').hidden = owner && lobbyReady;
  $('lobby-waiting').textContent = lobbyWaiting(data.matchmade);
  icons();
}
// A player's own role and kit, changeable until the start (#235). The room holds the choice; this only asks.
function showChoice(started) {
  const me = lobbyPlayers.find(p => p.id === playerId);
  $('lobby-choice').hidden = !me || !!started;
  if (!me) return;
  for (const button of document.querySelectorAll('[data-lobby-role]')) {
    const role = button.dataset.lobbyRole, mine = role === me.role;
    button.setAttribute('aria-pressed', String(mine));
    // Another side is open while it holds fewer people than places.
    button.disabled = !mine && !!lobbyCapacity && lobbyPlayers.filter(p => p.role === role).length >= lobbyCapacity[role];
  }
  if (me.role === 'gladiator') lobbyKit = me.kit;
  $('lobby-kit').hidden = me.role !== 'gladiator';
  $('lobby-kit').value = lobbyKit;
  // An owner reconnecting without a resume key rejoins as they now are, not as they first deployed.
  if (owner) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`last-exit:owner:${roomId}`));
      if (saved) sessionStorage.setItem(`last-exit:owner:${roomId}`, JSON.stringify({ ...saved, role: me.role, kit: me.kit }));
    } catch { /* Storage may be unavailable. */ }
  }
}
const choose = (role, kit) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'choose', role, kit })); };
function lobbyWaiting(matchmade) {
  if (!lobbyReady) return lobbyStarting || matchmade ? 'Generating the arena. The match starts when it is ready.' : 'Generating the arena…';
  return matchmade ? 'Match found. Preparing the arena…' : 'Waiting for the room owner to start the match.';
}
function showLobby(data) {
  updateLobby(data);
  $('live-hud').hidden = true;
  if (!$('lobby-dialog').open) $('lobby-dialog').showModal();
  connection(owner ? 'LOBBY' : 'WAITING');
}
function hideLobby() {
  if ($('lobby-dialog').open) $('lobby-dialog').close();
  $('live-hud').hidden = false;
}
async function connect({ room, key, role = 'contestant', kit = 'warden', name = 'Runner', matchmake = false }) {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(`last-exit:owner:${room}`)); } catch { /* Storage may be unavailable. */ }
  // A dev view borrows the owner key for an `owner` policy, but never the owner's player slot.
  if (!key && saved?.key) { key = saved.key; if (role !== 'dev') { role = saved.role; kit = saved.kit; name = saved.name; } }
  leaveDevView();
  if (ws) { disconnecting = true; ws.close(); }
  clearInput(); pending = []; seq = 0; savedReplay = null; recordingFailed = false; playerId = null;
  // Nothing of the previous room carries over: a room still generating sends no state until `ready`,
  // and an error before then must find this room stateless, not the last one's frame.
  state = null; liveMap = null; liveState = null; predicted = null;
  snapshots.reset(); presentation = null; roundTripMs = null;
  resetDiagnostics();
  $('lobby-title').textContent = 'Arena lobby.';
  owner = false; lobbyPlayers = []; lobbyCapacity = null; lobbyReady = true; lobbyStarting = false; lobbyKit = kit; devView = false; devRoster = ''; director.reset(); setPaused(false);
  $('finish-recording').disabled = false;
  // `role` is how this connection joins (a role, a matchmaking preference or the dev view); `selectedRole`
  // stays the deploy dialog's own choice, which only its role buttons set.
  roomId = room; ownerKey = key;
  connection('CONNECTING');
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws = socket;
  socket.addEventListener('open', () => {
    disconnecting = false;
    let resumeKey;
    try { if (room) resumeKey = sessionStorage.getItem(`last-exit:resume:${room}`); } catch { /* Optional recovery. */ }
    socket.send(JSON.stringify({ type: matchmake ? 'match' : 'join', room, ownerKey: key, resumeKey, role, kit, name }));
  });
  socket.addEventListener('message', event => {
    if (ws !== socket) return;
    const data = JSON.parse(event.data);
    if (data.type === 'welcome') {
      room = data.room; roomId = room;
      try { if (data.resumeKey) sessionStorage.setItem(`last-exit:resume:${room}`, data.resumeKey); } catch { /* Optional recovery. */ }
      playerId = data.id; owner = data.owner; liveMap = data.map; liveState = data.state; devView = !!data.dev;
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
      connection(devView ? 'DEV VIEW' : data.spectator ? 'SPECTATING' : data.started ? 'LIVE' : 'LOBBY'); $('loadout-dialog').close();
      if (!data.spectator && !data.started) showLobby(data);
    } else if (data.type === 'ready') {
      liveMap = data.map; liveState = data.state;
      if (!replayController.active() && !devFeed) { changeMap(data.map); acceptState(data.state); }
    } else if (data.type === 'state') {
      notePacket(event.data.length);
      // Gap between authoritative frames: separates server pacing from client render cost.
      if (lastStateAt) profiler.observe('net.stateGap', performance.now() - lastStateAt);
      profiler.observe('net.stateBytes', event.data.length, 'n');
      liveState = data.state;
      if (!replayController.active() && !devFeed) acceptState(data.state);
    } else if (data.type === 'ping') {
      // Echoed immediately and unmodified. The server times its own round trip; this end
      // states nothing about latency, it only returns a token it could not have held earlier.
      socket.send(JSON.stringify({ type: 'pong', token: data.token }));
      roundTripMs = data.rtt ?? null;
    } else if (data.type === 'lobby') {
      updateLobby(data);
      if (data.started) { if (!devView) { hideLobby(); connection('LIVE'); } }
      else if (playerId) showLobby(data);
    } else if (data.type === 'choose') {
      if (!data.ok) toast(data.message);
    } else if (data.type === 'teleport') {
      const who = state?.players.find(p => p.id === data.id)?.name || 'Player';
      toast(data.ok ? `${who} moved` : `${who} cannot stand there`);
    } else if (data.type === 'paused') {
      setPaused(data.paused);
    } else if (data.type === 'saved') {
      if (recordingFailed) return;
      savedReplay = data.replay; $('watch-match').disabled = false;
      if ($('archive-dialog').open) void loadArchive();
    } else if (data.type === 'replay-status') {
      if (data.status === 'failed') recordingFailed = true;
      toast(data.message || (data.status === 'partial' ? 'Replay recording is partial.' : 'Replay recording failed.'));
    } else if (data.type === 'error') {
      toast(data.message); connection('UNAVAILABLE');
      $('deploy-error').textContent = data.message; $('deploy-error').hidden = false;
      // Includes a room given up while its map generated: its lobby is gone, so back to the deploy dialog.
      if (!playerId || !state) { if ($('lobby-dialog').open) $('lobby-dialog').close(); openDeploy(); }
    }
  });
  socket.addEventListener('close', () => {
    if (ws === socket && !disconnecting) { connection('OFFLINE'); clearInput(); if (!replayController.active()) toast('Connection closed. Start a new arena to reconnect.'); }
  });
  socket.addEventListener('error', () => { if (ws === socket) toast('Unable to connect to the arena server.'); });
}
function acceptState(next) {
  state = next; lastStateAt = performance.now();
  if (!replayController.active()) snapshots.push(next);
  if (!arenaMap) return;
  arenaMap.gates = state.gates;
  if (inDevView()) refreshDevRoster();
  const me = state.players.find(p => p.id === playerId);
  if (me && !replayController.active() && !devFeed) {
    pending = pending.filter(i => i.seq > me.lastSeq).slice(-20);
    predicted = { ...me };
    if (me.status === 'active') for (const input of pending) movePlayer(arenaMap, predicted, input);
  }
  updateHUD();
}
// The dev view's focus list tracks the live roster: players join, and bots fill slots at the start.
function refreshDevRoster() {
  const key = state.players.map(p => p.id).join();
  if (key === devRoster) return;
  devRoster = key; fillFollowOptions($('dev-focus'), state.players); $('dev-focus').value = director.followId() || '';
}
// What the renderer draws: the buffered, interpolated view when live, and the frame a replay's own
// playhead selects when a recording is open. `state` stays the newest authoritative frame, which is
// what the HUD, prediction and every gameplay read use.
function presentationFrame() { return replayController.active() ? state : presentation || state; }
function updateHUD() {
  hudController.render({ state, arenaMap, playerId, replay: replayController.active(), savedReplay,
    selection: inputController.selection(),
    visibility: { directed: directed(), sight: scene?.sight }
  });
}

let scene;
const ArenaScene = makeArenaScene({
  map: () => arenaMap, state: () => presentationFrame(), playerId: () => playerId,
  self: () => !replayController.active() && predicted ? predicted : state?.players.find(p => p.id === playerId) || null,
  replay: () => replayController.active(), directed, aim: () => inputController.aim(),
  director, follow: () => directed() ? director.subject() : null,
  // How far into the current authoritative tick the renderer is, so motion that only updates on a
  // server frame can be advanced smoothly between them.
  frameAlpha: () => replayController.active() ? replayController.frameAlpha() : (presentationFrame()?.alpha ?? 0),
  onReady: value => scene = value, onFire: value => inputController.setPointerFire(value),
  onFrame: () => { if (!replayController.active()) presentation = snapshots.frame() || state; replayController.renderFrame(); }
});
// Diagnostic reports ride beside inputs but are metadata: the server records them as marks on the
// replay and the simulation never sees them. They name the tick this client was drawing.
reportDiagnostics(() => (replayController.active() || !playerId || devFeed ? null : presentation?.tick ?? state?.tick ?? null),
  report => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'diagnostic', ...report })); });
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
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'dev', action: paused ? 'resume' : 'pause' }));
}
function inputTick() {
  if (paused || devFeed || replayController.active() || !state || !predicted || !ws || ws.readyState !== WebSocket.OPEN || predicted.status !== 'active') { hudController.cancelDrag(); return; }
  const blocked = document.querySelector('dialog[open]');
  if (blocked) hudController.cancelDrag();
  let pointerAim;
  if (scene?.ready) {
    const point = scene.cameras.main.getWorldPoint(scene.input.activePointer.x, scene.input.activePointer.y);
    pointerAim = Math.atan2(point.y - predicted.y, point.x - predicted.x);
  }
  const input = { type: 'input', seq: seq++, ...inputController.collectIntent({ blocked, pointerAim }) };
  ws.send(JSON.stringify(input)); pending.push(input); pending = pending.slice(-20);
  movePlayer(arenaMap, predicted, input); inputController.consumeActions();
  hudController.setSneak(input.sneak);
}
/** Runs one way into a room from the deploy dialog, reporting a refusal there; one at a time. */
async function deploy(enter) {
  if (connecting) return;
  connecting = true; $('deploy-error').hidden = true;
  try { await enter(); }
  catch (error) { $('deploy-error').textContent = error.message; $('deploy-error').hidden = false; toast(error.message); }
  finally { connecting = false; }
}
const player = () => ({ kit: $('kit').value, name: $('callsign').value || 'Runner' });
const newArena = () => deploy(async () => {
  const body = { seed: Number($('seed').value), size: $('map-size').value, name: $('room-name').value };
  const data = await json('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await connect({ room: data.id, key: data.ownerKey, role: selectedRole, ...player() });
});
// Auto is matchmaking: the directory picks a matchmade room still filling, or starts one.
const autoMatch = () => deploy(() => connect({ matchmake: true, role: $('role-preference').value, ...player() }));
// The lobby browser (22.5): the rooms the directory lists, polled while the deploy dialog is open.
let listedRooms = [], devPolicy = null, refreshingRooms = false;
function openDeploy() {
  if (!$('loadout-dialog').open) $('loadout-dialog').showModal();
  void refreshRooms();
}
async function refreshRooms() {
  if (refreshingRooms) return;
  refreshingRooms = true;
  try {
    // The dev tools policy is fixed for the server's life, so it is asked once.
    devPolicy ??= (await json('/api/health')).devTools;
    listedRooms = await json('/api/rooms');
  } catch { listedRooms = null; }
  finally { refreshingRooms = false; }
  renderRooms();
}
// Whether this browser holds a room's owner key, which an `owner` policy asks of a dev view.
function ownsRoom(id) {
  try { return !!JSON.parse(sessionStorage.getItem(`last-exit:owner:${id}`))?.key; } catch { return false; }
}
function renderRooms() {
  const target = $('room-list'); target.replaceChildren();
  if (!listedRooms?.length) {
    const p = document.createElement('p'); p.className = 'empty-archive';
    p.textContent = listedRooms ? 'No open rooms. Press Auto, or create one below.' : 'The room list is unavailable.';
    target.append(p); return;
  }
  for (const r of listedRooms) {
    const row = document.createElement('div'); row.className = 'room-row';
    const details = document.createElement('div'), title = document.createElement('strong'), sub = document.createElement('small');
    const label = r.name || `Room ${r.id}`; title.textContent = label;
    const status = r.phase === 'live' ? 'live' : r.ready ? r.kind === 'matchmade' ? 'filling' : 'lobby' : 'generating';
    const badge = document.createElement('span'); badge.className = `room-phase phase-${status}`; badge.textContent = status;
    const count = role => `${r.players[role]}/${r.players[role] + r.open[role]}`;
    sub.textContent = `${r.size.replace('x', ' × ')} / ${count('contestant')} contestants / ${count('gladiator')} gladiators`;
    title.append(' ', badge); details.append(title, sub);
    const actions = document.createElement('div');
    // Before the start a player is placed wherever there is room and can change in the lobby (#235); a
    // private match already under way admits only the role chosen.
    const open = r.phase === 'lobby' || r.kind === 'matchmade' ? r.open.contestant + r.open.gladiator : r.open[selectedRole];
    const join = document.createElement('button'); join.type = 'button'; join.className = 'secondary-button'; join.textContent = 'Join';
    join.disabled = !open; join.ariaLabel = `Join ${label}`; join.onclick = () => deploy(() => connect({ room: r.id, role: selectedRole, ...player() }));
    actions.append(join);
    if (devPolicy === 'all' || devPolicy === 'owner' && ownsRoom(r.id)) {
      const dev = document.createElement('button'); dev.type = 'button'; dev.className = 'icon-button'; dev.innerHTML = icon('eye');
      dev.ariaLabel = `Dev view of ${label}`; dev.dataset.tip = 'Dev view';
      dev.onclick = () => deploy(() => connect({ room: r.id, role: 'dev' }));
      actions.append(dev);
    }
    row.append(details, actions); target.append(row);
  }
  icons();
}
setInterval(() => { if ($('loadout-dialog').open) void refreshRooms(); }, 2000);
async function loadArchive() {
  $('replay-list').textContent = 'Loading broadcasts...';
  $('finish-recording').hidden = !owner || !liveState || liveState.phase === 'finished';
  try {
    const list = await json('/api/replays'); $('replay-list').replaceChildren();
    if (!list.length) { const p = document.createElement('p'); p.className = 'empty-archive'; p.textContent = 'No completed broadcasts yet.'; $('replay-list').append(p); }
    for (const r of list) {
      const row = document.createElement('div'); row.className = 'replay-row';
      const details = document.createElement('div'); const title = document.createElement('strong'); title.textContent = `Arena ${r.seed}${r.recording?.complete === false ? ' · PARTIAL' : ''}`;
      const sub = document.createElement('small'); sub.textContent = `${time(r.ticks)} / ${r.escaped} escaped / ${new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      details.append(title, sub); const actions = document.createElement('div');
      const play = document.createElement('button'); play.className = 'icon-button'; play.ariaLabel = `Play arena ${r.seed}`; play.innerHTML = icon('play'); play.onclick = () => watchReplay(r.id);
      const download = document.createElement('button'); download.className = 'icon-button'; download.ariaLabel = `Download arena ${r.seed}`; download.innerHTML = icon('download'); download.onclick = () => downloadReplay(r.id);
      actions.append(play, download); row.append(details, actions); $('replay-list').append(row);
    }
    icons();
  } catch (error) { $('replay-list').textContent = error.message; }
}
async function downloadReplay(id) {
  try {
    const cached = replayController.cachedData(id);
    const data = cached || await json(`/api/replays/${id}`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `last-exit-${id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); }
}
$('new-game').onclick = $('play-again').onclick = () => { clearInput(); $('deploy-error').hidden = true; openDeploy(); };
$('deploy-form').onsubmit = e => { e.preventDefault(); void newArena(); };
$('auto-match').onclick = () => void autoMatch();
const randomizeSeed = () => { $('seed').value = 1 + crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646; };
$('random-seed').onclick = randomizeSeed;
randomizeSeed();
document.querySelectorAll('[data-role]').forEach(button => button.onclick = () => {
  selectedRole = button.dataset.role; showKit();
  document.querySelectorAll('[data-role]').forEach(b => { const selected = b === button; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', selected); });
  renderRooms();
});
// The kit matters to anyone who may be a gladiator: chosen, or preferred for Auto.
const showKit = () => { $('kit-options').hidden = selectedRole !== 'gladiator' && $('role-preference').value !== 'gladiator'; };
$('role-preference').onchange = showKit;
$('lobby-kit').innerHTML = $('kit').innerHTML;
document.querySelectorAll('[data-lobby-role]').forEach(button => button.onclick = () => {
  const role = button.dataset.lobbyRole, me = lobbyPlayers.find(p => p.id === playerId);
  // The role already held asks nothing, so it cannot send a kit that is not the player's own.
  if (!me || role === me.role) return;
  // Back to gladiator with the lobby's latest kit; a contestant's kit is never shown.
  choose(role, role === 'gladiator' ? lobbyKit : undefined);
});
$('lobby-kit').onchange = () => { lobbyKit = $('lobby-kit').value; choose('gladiator', lobbyKit); };
document.querySelectorAll('.close-dialog').forEach(button => button.onclick = () => button.closest('dialog').close());
$('share').onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('Arena link copied'); } catch { toast('Arena link: ' + location.href); } };
$('copy-lobby-link').onclick = $('share').onclick;
setInterval(() => {
  if (!lobbyStartsAt || !$('lobby-dialog').open) return;
  const seconds = Math.ceil((lobbyStartsAt - Date.now()) / 1000);
  $('lobby-waiting').textContent = seconds <= 0 && !lobbyReady ? lobbyWaiting(true) : `Match starts in ${Math.max(0, seconds)}s. Open slots will be filled by bots.`;
}, 250);
$('start-match').onclick = () => { if (ws?.readyState === WebSocket.OPEN && owner) ws.send(JSON.stringify({ type: 'start' })); };
$('archive').onclick = () => { clearInput(); $('archive-dialog').showModal(); void loadArchive(); };
async function downloadDiagnostics() {
  const me = state?.players.find(p => p.id === playerId);
  const report = { capturedAt: new Date().toISOString(), version: state?.version, seed: arenaMap?.seed, tick: state?.tick,
    role: me?.role, position: me && { x: me.x, y: me.y }, viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, visibility: document.visibilityState,
    socketBufferedBytes: ws?.bufferedAmount, timings: diagnosticTimings(), profile: profiler.report() };
  try { report.server = await json('/api/health'); } catch { report.server = { reachable: false }; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `last-exit-diagnostics-${Date.now()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download-diagnostics').onclick = () => void downloadDiagnostics();
$('finish-recording').onclick = () => { if (ws?.readyState === WebSocket.OPEN && owner) { ws.send(JSON.stringify({ type: 'finish' })); $('finish-recording').disabled = true; } };
// The dev view opens beside the match rather than in place of it, so a player keeps their slot.
function enterDevView() {
  if (devFeed || !playerId || replayController.active() || ws?.readyState !== WebSocket.OPEN) return;
  clearInput();
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  devFeed = socket; showDevMode();
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'join', room: roomId, ownerKey, role: 'dev' })));
  socket.addEventListener('message', event => {
    if (devFeed !== socket) return;
    const data = JSON.parse(event.data);
    // Only the frames come from here; pauses, the lobby and replays still arrive on the player's socket.
    if ((data.type === 'welcome' || data.type === 'ready') && data.map) { devRoster = ''; snapshots.reset(); changeMap(data.map); acceptState(data.state); }
    else if (data.type === 'state') { if (!replayController.active()) acceptState(data.state); }
    else if (data.type === 'error') { toast(data.message); leaveDevView(); }
  });
  socket.addEventListener('close', () => { if (devFeed === socket) leaveDevView(); });
}
function leaveDevView() {
  const socket = devFeed;
  if (!socket) return;
  devFeed = null; socket.close(); director.reset(); snapshots.reset();
  if (liveMap && liveState && !replayController.active()) { changeMap(liveMap); acceptState(liveState); }
  showDevMode(); scene?.cutTo();
}
function showDevMode() {
  const on = inDevView();
  $('dev-controls').hidden = !on; $('dev-leave').hidden = !devFeed;
  if (playerId && !replayController.active()) $('live-hud').hidden = !!devFeed;
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
  if (point && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'dev', action: 'teleport', id, x: point.x, y: point.y }));
}
addEventListener('keydown', event => {
  if (event.code !== 'KeyT' || event.repeat || !inDevView() || replayController.active() || event.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
  teleportToCursor();
});
// Backquote steps out to the dev view and back, wherever the button is.
addEventListener('keydown', event => {
  if (event.code !== 'Backquote' || event.repeat || event.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]') || $('dev-view').hidden) return;
  devFeed ? leaveDevView() : enterDevView();
});
$('dev-focus').onchange = () => director.setFollow($('dev-focus').value);
$('dev-fog').onclick = () => director.setFog(!director.fog());
$('dev-whole').onclick = () => director.whole();
// Focus would leave Space pressing this button as well as toggling the pause, which cancels out.
$('dev-pause').onclick = event => { togglePause(); event.currentTarget.blur(); };
$('watch-match').onclick = () => { if (savedReplay) watchReplay(savedReplay.id); };
icons();
const game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', backgroundColor: '#253f3f', antialias: true, scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: ArenaScene, audio: { noAudio: true }, render: { preserveDrawingBuffer: true } });
// Phaser's own render pass runs after the scene's update, outside render.frame. It is where Graphics
// are tessellated and batched, so it must be timed separately or draw cost is invisible here.
game.events.on('prerender', () => profiler.start('render.draw'));
game.events.on('postrender', () => profiler.stop('render.draw'));
setInterval(inputTick, 50);
const initialParams = new URLSearchParams(location.search);
const initialRoom = initialParams.get('room');
// `?seed=` names the arena a new room generates (`?size=24x12` its zone size), as the Map Lab's "Play in the game" link does (53).
if (initialParams.has('seed')) $('seed').value = initialParams.get('seed');
if (initialParams.has('size')) $('map-size').value = initialParams.get('size');
// `?room=…&dev` opens that room's dev view, as the dev view button does.
if (initialRoom) void connect({ room: initialRoom, key: initialParams.get('ownerKey'), ...(initialParams.has('dev') ? { role: 'dev' } : {}) }); else void newArena();
// Profiling is opt-in so instrumented hot paths cost nothing during normal play.
function renderProfileOverlay() {
  if (!profiler.profiling()) { profileOverlay?.remove(); profileOverlay = null; return; }
  if (!profileOverlay) {
    profileOverlay = Object.assign(document.createElement('pre'), { id: 'profile-overlay' });
    profileOverlay.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:60;margin:0;padding:10px 12px;max-height:52vh;overflow:auto;font:11px/1.35 ui-monospace,monospace;color:#d9f2c8;background:rgba(12,26,24,.86);border:1px solid #35564a;border-radius:8px;pointer-events:none;white-space:pre';
    document.body.append(profileOverlay);
  }
  const rows = profiler.report(), find = name => rows.find(r => r.name === name);
  const delta = find('render.delta'), gap = find('net.stateGap'), bytes = find('net.stateBytes');
  const head = [`frames ${profiler.frameCount()}`,
    delta ? `fps ${(1000 / Math.max(0.001, delta.mean)).toFixed(0)} (p95 frame ${delta.p95.toFixed(1)} ms)` : 'fps --',
    gap ? `state gap ${gap.mean.toFixed(1)} ms mean / ${gap.p95.toFixed(1)} p95 (server ${HZ} Hz = ${(1000 / HZ).toFixed(0)} ms)` : 'state gap --',
    bytes ? `state ${(bytes.mean / 1024).toFixed(1)} KiB` : '',
    (() => { const b = snapshots.stats(); return b.newest === null ? '' : `interp ${b.delayTicks} ticks behind (${(b.delayTicks * 1000 / HZ).toFixed(0)} ms), buffered ${b.depth}, rate ${b.rate.toFixed(2)}, starved ${b.starved}, cuts ${b.snaps}`; })(),
    // Unacknowledged inputs the client is still replaying, and whether the server had to repeat one
    // because none had arrived. A stall is the signal that the send rate is losing to the tick rate.
    (() => { const me = state?.players.find(p => p.id === playerId); return me ? `input pending ${pending.length}, stalled ${me.inputStalled ?? 0}` : ''; })(),
    roundTripMs === null ? '' : `rtt ${roundTripMs} ms (server measured)`].filter(Boolean);
  profileOverlay.textContent = head.join('\n') + '\n' + profiler.format(rows.filter(r => r !== delta && r !== gap && r !== bytes));
}
function setProfiling(value) {
  profiler.enable(value);
  renderProfileOverlay();
  toast(value ? 'Profiling on. Press P to stop.' : 'Profiling off.');
}
setInterval(renderProfileOverlay, 500);
addEventListener('keydown', e => { if (e.key === 'p' || e.key === 'P') if (!e.target.closest('input, textarea')) setProfiling(!profiler.profiling()); });
if (new URLSearchParams(location.search).has('profile')) profiler.enable(true);
window.arenaProfile = () => ({ enabled: profiler.profiling(), frames: profiler.frameCount(), series: profiler.report() });
window.arenaProfiling = setProfiling;
// Spectator connections exist on the server but have no interface yet; this is the hook the presenter
// tooling will grow from, and what the tests drive.
window.arenaSpectate = () => connect({ room: roomId, key: ownerKey, role: 'spectator' });
// Read-only inspection surface for reproducible browser smoke tests.
window.arenaDebug = () => ({ tick: state?.tick, room: roomId, directed: directed(), spectating: !!state && !playerId, shots: scene?.shots, me: state?.players.find(p => p.id === playerId), replay: replayController.active(), follow: director.followId(), dev: inDevView(), devFeed: !!devFeed, paused, fog: director.fog(), viewer: director.viewer()?.id ?? null, phase: state?.phase, actorCount: scene?.actors.size, roofs: scene && [...scene.roofs].map(([id, roof]) => ({ id, visible: roof.visible })), actors: scene && [...scene.actors].map(([id, a]) => ({ id, visible: a.container.visible, x: a.container.x, y: a.container.y })), markerScale: scene?.marker, aim: inputController.aim(), cameraWidth: scene?.cameras.main.worldView.width, cameraHeight: scene?.cameras.main.worldView.height, camera: scene && { x: scene.cameras.main.worldView.x, y: scene.cameras.main.worldView.y, zoom: scene.cameras.main.zoom }, mapWidth: arenaMap?.width, map: arenaMap && { seed: arenaMap.seed, width: arenaMap.width, height: arenaMap.height, playableArea: arenaMap.playableArea, exit: arenaMap.exit, spawns: arenaMap.spawns, hunterSpawns: arenaMap.hunterSpawns, stations: arenaMap.stations.map(({ x, y }) => ({ x, y })), chargers: arenaMap.chargers.map(({ x, y }) => ({ x, y })) }, vision: scene?.visionPoints, predicted: predicted && { x: predicted.x, y: predicted.y }, buffer: snapshots.stats(),
  pending: pending.length, inputStalled: state?.players.find(p => p.id === playerId)?.inputStalled ?? null, rtt: roundTripMs });
