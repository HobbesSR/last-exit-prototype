import { createInputController } from '/input-controller.js';
import { createHUDController } from '/hud-controller.js';
import { resetDiagnostics, diagnosticTimings, reportDiagnostics, manualMark, forgetTiming } from '/diagnostics.js';
import { makeArenaScene } from '/arena-scene.js';
import { createReplayController } from '/replay-controller.js';
import { createCameraDirector } from '/camera-director.js';
import { createSnapshotBuffer } from '/snapshot-buffer.js';
import * as profiler from '/shared/profiler.ts';
import { CLIENT_MESSAGE, HTTP_ENDPOINT } from '/shared/protocol.ts';
import { contentById } from '/shared/simulation/content.ts';
import { transitOptions } from '/shared/simulation/transit.ts';
import { downloadJson } from '/download.js';
import { createLobbyController } from '/lobby-controller.js';
import { createDeployController } from '/deploy-controller.js';
import { createArchiveController } from '/archive-controller.js';
import { createProfileOverlay } from '/profile-overlay.js';
import { createRoomConnection } from '/room-connection.js';
import { createInputPrediction } from '/input-prediction.js';
import { createDevView } from '/dev-view.js';
import { THEMES, DEFAULT_THEME, themeColors, css } from '/palette.js';
import { $, HZ, INTERPOLATION_DELAY_TICKS } from '/ui.js';

const icon = name => `<i data-lucide="${name}"></i>`;
const icons = () => window.lucide?.createIcons();
// The shown view: the map and newest authoritative frame on screen, whichever source they came from. The
// room's socket, the dev feed and a replay each hand frames to `changeMap` and `acceptState`; only this
// module assigns them, and it decides which source is showing.
let arenaMap, state;
// Authoritative frames are buffered and read back at a fixed delay, so what is drawn is
// interpolated between two received states rather than chasing the newest one.
const snapshots = createSnapshotBuffer({ hz: HZ, delayTicks: INTERPOLATION_DELAY_TICKS });
let presentation = null;
const inputController = createInputController({
  getPlayer: () => me(),
  onSelectionChange: () => updateHUD(), onToggleFullscreen: () => toggleFullscreen(),
  onToggleReplay: () => { if (replayController.active()) replayController.togglePlay(); else if (devView.active()) togglePause(); },
  onMarkLag: () => markLag()
});
const hudController = createHUDController({
  selectSlot: index => inputController.selectSlot(index), arrange: () => inputController.toggleArrange(),
  skill: () => inputController.skill(), interact: () => inputController.interact(), drop: () => inputController.drop(),
  reload: () => inputController.reload(), dropAmmo: family => inputController.dropAmmo(family),
  transit: stationId => inputController.transit(stationId),
  moveSlot: (from, to) => inputController.moveSlot(from, to), dropSlot: from => inputController.dropSlot(from),
  cancelPointerFire: () => inputController.setPointerFire(false),
  canDrag: () => !replayController.active() && state?.players.some(p => p.id === room.playerId() && p.role === 'contestant' && p.status === 'active'),
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
    $('replay-focus').value = id || ''; devView.showFollow(id);
    // A cut, not a pan: gliding a camera across a 24000 unit arena would lose the subject for seconds.
    scene?.cutTo();
    updateHUD();
    if (announce && subject) toast(`Following ${subject.name}`);
  },
  onFog: (fog, announce) => {
    devView.showFog(fog);
    updateHUD();
    if (announce) toast(fog ? 'Followed players are shown in their own sight' : 'Fog off: followed players see everything');
  },
});
const replayController = createReplayController({
  fetchJSON: json, changeMap, acceptState, updateHUD, clearInput, toast, connection,
  getMap: () => arenaMap, getState: () => state, setState: value => state = value,
  getScene: () => scene, getLiveMap: () => room.liveMap(), getLiveState: () => room.liveState(),
  liveConnectionLabel: () => room.isOpen() ? (devView.active() ? 'DEV VIEW' : 'LIVE') : 'OFFLINE',
  downloadReplay: id => archive.download(id), icon, icons, director,
});
let toastTimer;
const me = () => state?.players.find(p => p.id === room.playerId());
const directed = () => replayController.active() || !room.playerId() || devView.feeding();
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
  clearInput(); prediction.restart(me()); scene?.cutTo();
});
function changeMap(map) { prediction.resetPhysics(); director.clearPosition(); arenaMap = structuredClone(map); if (scene?.ready) scene.buildMap(); }
/** Where the player may transit to now, when the live content lets a gladiator choose (#692); else null. */
function transitChoices() {
  const predicted = prediction.predicted();
  if (replayController.active() || devView.feeding() || !state || !predicted || !arenaMap) return null;
  let selectable = false;
  try { selectable = contentById(displayPresentation()?.contentId).transit === 'selectable'; } catch { /* an unknown id chooses nothing */ }
  const own = me();
  return selectable && own ? transitOptions({ map: arenaMap, hazardX: state.hazardX }, { ...own, x: predicted.x, y: predicted.y }) : null;
}
/** The descriptor of whatever is shown: the open recording, the dev feed, or the live room. */
function displayPresentation() {
  if (replayController.active()) return replayController.presentation();
  return devView.feeding() ? devView.presentation() : room.presentation();
}
// Labels follow a descriptor change even when no item id or count changed.
function presentationChanged() {
  devView.staleRoster();
  if (lobby.open()) lobby.redraw();
  if (state) { refreshDevRoster(); updateHUD(); }
}
// A player's own HUD shows only while they play: not in the lobby, nor while stepped out to the dev view,
// which the non-modal lobby lets them do before the start (#267 review).
function showPlayerHud() {
  if (room.playerId() && !replayController.active()) $('live-hud').hidden = devView.feeding() || lobby.open();
}
function showLobby(data) {
  lobby.show(data);
  showPlayerHud();
  if (!devView.feeding()) connection(room.isOwner() ? 'LOBBY' : 'WAITING');
}
function hideLobby() {
  lobby.hide();
  showPlayerHud();
}
const room = createRoomConnection({
  toast, showStatus: connection,
  // Nothing of the previous room's view carries over.
  onJoining({ kit }) {
    clearInput(); prediction.reset();
    state = null; snapshots.reset(); presentation = null;
    // A replay still loading belongs to the view being left.
    replayController.cancel();
    resetDiagnostics();
    lobby.reset(kit); director.reset(); archive.reset();
  },
  onWelcome(data) {
    devView.offer(data.devTools);
    replayController.reset();
    $('live-hud').hidden = !!data.spectator;
    // A room whose map is still generating sends it later, in `ready`.
    if (data.map) { changeMap(data.map); acceptState(data.state); }
    history.replaceState(null, '', `?room=${room.roomId()}${room.isDev() ? '&dev' : ''}`);
    connection(room.isDev() ? 'DEV VIEW' : data.spectator ? 'SPECTATING' : data.started ? 'LIVE' : 'LOBBY'); deploy.close();
    if (!data.spectator && !data.started) showLobby(data);
    presentationChanged();
  },
  onReady(data) {
    // A new map starts its own ticks, as at the start when players leave the waiting area (#236), so
    // neither buffered frames nor inputs predicted on the old map carry over.
    if (!replayController.active() && !devView.feeding()) {
      snapshots.reset(); prediction.forgetInputs(); room.reseedDiscovery(data.state);
      changeMap(data.map); acceptState(data.state);
    }
    presentationChanged();
  },
  onState(frame) { if (!replayController.active() && !devView.feeding()) acceptState(frame); },
  onLobby(data) {
    lobby.update(data);
    if (data.started) { if (!room.isDev()) { hideLobby(); connection(devView.feeding() ? 'DEV VIEW' : 'LIVE'); } }
    else if (room.playerId()) showLobby(data);
  },
  onTeleport(data) {
    const who = state?.players.find(p => p.id === data.id)?.name || 'Player';
    toast(data.ok ? `${who} moved` : `${who} cannot stand there`);
  },
  onPaused(paused) {
    $('paused-banner').hidden = !paused;
    // Packet gaps across a pause are the pause, not the network.
    forgetTiming();
    if (paused) clearInput();
    devView.showPaused(paused);
  },
  onSaved() { $('watch-match').disabled = false; archive.refresh(); },
  onError(data) {
    toast(data.message); connection('UNAVAILABLE');
    deploy.showError(data.message);
    // Includes a room given up while its map generated: its lobby and waiting yard are gone, so back to
    // the deploy dialog.
    if (!room.playerId() || !state || state.phase === 'waiting') {
      if (state?.phase === 'waiting') { state = null; room.forgetFrame(); prediction.abandon(); snapshots.reset(); }
      // The room view is discarded, and its labels with it.
      if (!state) room.forgetPresentation();
      lobby.hide();
      deploy.open();
    }
  },
  onClose() { connection('OFFLINE'); clearInput(); prediction.resetPhysics(); if (!replayController.active()) toast('Connection closed. Open Lobbies to reconnect.'); },
});
const prediction = createInputPrediction({
  getMap: () => arenaMap, getPlayerId: () => room.playerId(), getState: () => state, directed,
});
/** Joins a room, leaving whatever this page was showing. A dev view stepped out to belongs to the room being left. */
async function connect(options) {
  devView.leave(); devView.forget();
  room.join(options);
}
function acceptState(next) {
  state = next;
  if (!replayController.active()) snapshots.push(next);
  if (!arenaMap) return;
  arenaMap.gates = state.gates;
  refreshDevRoster();
  const own = me();
  if (own && !replayController.active() && !devView.feeding()) prediction.reconcile(state, own);
  else if (!own && !directed()) prediction.abandon();
  updateHUD();
}
function refreshDevRoster() { if (devView.active()) devView.refreshRoster(state.players, displayPresentation()); }
// What the renderer draws: the buffered, interpolated view when live, and the frame a replay's own
// playhead selects when a recording is open. `state` stays the newest authoritative frame, which is
// what the HUD, prediction and every gameplay read use.
function presentationFrame() { return replayController.active() ? state : presentation || state; }
function currentView() {
  if (replayController.active()) return 'replay';
  if (devView.active()) return 'dev';
  if (!state || state.phase === 'waiting' || lobby.open()) return 'lobby';
  if (!room.playerId()) return 'spectator';
  const own = me();
  if (!own || own.status !== 'active' || state.phase === 'finished') return 'outcome';
  return 'play';
}
// Whether the player a stepped-out dev view returns to has finished: judged on their own socket's frame.
function playerEnded() {
  const id = room.playerId(), own = room.liveState()?.players?.find(p => p.id === id) || state?.players?.find(p => p.id === id);
  return own && (own.status !== 'active' || state?.phase === 'finished');
}
function updateHUD() {
  devView.labelLeave(playerEnded);
  hudController.render({ state, arenaMap, playerId: room.playerId(), view: currentView(), savedReplay: room.savedReplay(),
    presentation: displayPresentation(), hz: replayController.active() ? replayController.hz() : HZ,
    selection: inputController.selection(), transit: transitChoices(),
    visibility: { directed: directed(), fogged: directed() && director.fog() && !!director.followId(), viewer: director.viewer(), sight: scene?.sight },
    discovery: room.discovered()
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
  map: () => arenaMap, state: () => presentationFrame(), playerId: () => room.playerId(),
  kits: () => displayPresentation()?.kits,
  self: () => !replayController.active() && prediction.predicted() ? prediction.predicted() : me() || null,
  localPhysics: () => !directed() && !!state?.physicsProfile,
  predictionCut: () => prediction.stats()?.cuts,
  replay: () => replayController.active(), directed, aim: () => inputController.aim(),
  // Geometry is match display data, shown only after a dev welcome has authorized this view, and
  // only over a frame that carries physics bodies.
  geometryOverlay: () => !replayController.active() && !!presentationFrame()?.physicsProfile
    && (room.isDev() || devView.feeding() && devView.presentation())
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
    if (directed()) hudController.drawMinimap({ state: presentationFrame(), arenaMap, playerId: room.playerId(),
      visibility: { directed: true, fogged: director.fog() && !!director.followId(), viewer: director.viewer(), sight: scene?.sight } });
  }
});
// Diagnostic reports ride beside inputs but are metadata: the server records them as marks on the
// replay and the simulation never sees them. They name the tick this client was drawing.
reportDiagnostics(() => (directed() ? null : presentation?.tick ?? state?.tick ?? null),
  report => { room.send({ type: CLIENT_MESSAGE.DIAGNOSTIC, ...report }); });
function markLag() { if (manualMark()) toast('Lag flagged for the replay'); }
$('mark-lag').onclick = markLag;
function toggleFullscreen() { if (!document.fullscreenElement) { document.documentElement.requestFullscreen().catch(() => {}); } else { document.exitFullscreen().catch(() => {}); } }
document.addEventListener('fullscreenchange', () => { const isFull = !!document.fullscreenElement; $('fullscreen-toggle').classList.toggle('active', isFull); $('fullscreen-toggle').innerHTML = `<i data-lucide="${isFull ? 'minimize' : 'maximize'}"></i>`; icons(); });
function togglePause() {
  room.send({ type: CLIENT_MESSAGE.DEV, action: room.paused() ? 'resume' : 'pause' });
}
function inputTick() {
  if (state?.physicsProfile && document.hidden) return;
  const predicted = prediction.predicted();
  if (room.paused() || devView.feeding() || replayController.active() || !state || !predicted || !room.isOpen() || predicted.status !== 'active') { hudController.cancelDrag(); return; }
  const blocked = document.querySelector('dialog:modal');
  if (blocked) hudController.cancelDrag();
  let pointerAim;
  if (scene?.ready) {
    const point = scene.cameras.main.getWorldPoint(scene.input.activePointer.x, scene.input.activePointer.y);
    pointerAim = Math.atan2(point.y - predicted.y, point.x - predicted.x);
  }
  const input = { type: CLIENT_MESSAGE.INPUT, seq: prediction.nextSeq(), ...inputController.collectIntent({ blocked, pointerAim }) };
  room.send(input); prediction.apply(input, state);
  inputController.consumeActions();
  hudController.setSneak(input.sneak);
}
const lobby = createLobbyController({
  getRoomId: () => room.roomId(), getPlayerId: () => room.playerId(), isOwner: () => room.isOwner(), getPresentation: () => room.presentation(),
  choose: (role, kit) => { room.send({ type: CLIENT_MESSAGE.CHOOSE, role, kit }); },
  start: () => { if (room.isOwner()) room.send({ type: CLIENT_MESSAGE.START }); },
  copyLink: () => share(), onOwnChoice: (role, kit) => room.rememberChoice(role, kit), icons,
});
const deploy = createDeployController({
  fetchJSON: json, connect, toast, clearInput, icon, icons,
  ownsRoom: id => room.ownsRoom(id),
});
const archive = createArchiveController({
  fetchJSON: json, toast, clearInput, icon, icons,
  watch: id => watchReplay(id), cachedReplay: id => replayController.cachedData(id),
  canFinish: () => !!room.isOwner() && !!room.liveState() && room.liveState().phase !== 'finished',
  finish: () => room.isOwner() && room.send({ type: CLIENT_MESSAGE.FINISH }),
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
  const own = me();
  const report = { capturedAt: new Date().toISOString(), version: state?.version, content: displayPresentation()?.contentId ?? null,
    seed: arenaMap?.seed, map: arenaMap && { width: arenaMap.width, height: arenaMap.height }, tick: state?.tick,
    role: own?.role, position: own && { x: own.x, y: own.y }, viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, visibility: document.visibilityState,
    renderer: rendererReport(), crowd: crowdReport(),
    socketBufferedBytes: room.bufferedBytes(), timings: diagnosticTimings(), profile: profiler.report() };
  try { report.server = await json(HTTP_ENDPOINT.HEALTH); } catch { report.server = { reachable: false }; }
  downloadJson(`last-exit-diagnostics-${Date.now()}.json`, report, 2);
}
$('download-diagnostics').onclick = () => void downloadDiagnostics();
const devView = createDevView({
  director, toast, icon, icons, presentationChanged, updateHUD, togglePause,
  standalone: () => room.isDev(), getRoomId: () => room.roomId(), getOwnerKey: () => room.ownerKey(), getPlayerId: () => room.playerId(),
  canEnter: () => !!room.playerId() && !replayController.active() && room.isOpen(),
  onEnter: () => { clearInput(); replayController.cancel(); },
  showMap: (map, frame) => { snapshots.reset(); changeMap(map); acceptState(frame); },
  showState: frame => { if (!replayController.active()) acceptState(frame); },
  // Back to the player's own view, from the newest frame their socket holds.
  restoreLive: () => {
    snapshots.reset();
    if (room.liveMap() && room.liveState() && !replayController.active()) { changeMap(room.liveMap()); acceptState(room.liveState()); }
  },
  showStatus: on => { if (room.isOpen() && !replayController.active()) connection(on ? 'DEV VIEW' : 'LIVE'); },
  cut: () => scene?.cutTo(), pointer: () => scene?.pointerWorld(), replaying: () => replayController.active(),
  sendDev: command => room.send({ type: CLIENT_MESSAGE.DEV, ...command }),
});
const watchReplay = id => { devView.leave(); void replayController.watch(id); };
for (const [id, { label }] of Object.entries(THEMES)) $('dev-palette').add(new Option(label, id));
$('dev-palette').value = palette;
$('dev-palette').onchange = event => { choosePalette(event.currentTarget.value); event.currentTarget.blur(); };
$('watch-match').onclick = () => { if (room.savedReplay()) watchReplay(room.savedReplay().id); };
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
    const b = snapshots.stats(), own = me(), rtt = room.roundTripMs();
    return [b.newest === null ? '' : `interp ${b.delayTicks} ticks behind (${(b.delayTicks * 1000 / HZ).toFixed(0)} ms), buffered ${b.depth}, rate ${b.rate.toFixed(2)}, starved ${b.starved}, cuts ${b.snaps}`,
      // Unacknowledged inputs the client is still replaying, and whether the server had to repeat one
      // because none had arrived. A stall is the signal that the send rate is losing to the tick rate.
      own ? `input pending ${prediction.pendingCount()}, stalled ${own.inputStalled ?? 0}` : '',
      rtt === null ? '' : `rtt ${rtt} ms (server measured)`];
  },
});
window.arenaProfile = () => ({ enabled: profiler.profiling(), frames: profiler.frameCount(), series: profiler.report() });
window.arenaProfiling = profile.setProfiling;
// Spectator connections exist on the server but have no interface yet; this is the hook the presenter
// tooling will grow from, and what the tests drive.
window.arenaSpectate = () => connect({ room: room.roomId(), key: room.ownerKey(), mode: 'spectator' });
// Read-only inspection surface for reproducible browser smoke tests.
window.arenaDebug = () => ({ tick: state?.tick, palette, version: state?.version, room: room.roomId(), content: displayPresentation()?.contentId ?? null, directed: directed(), spectating: !!state && !room.playerId(), shots: scene?.shots, me: me(), replay: replayController.active(), follow: director.followId(), dev: devView.active(), devFeed: devView.feeding(), view: currentView(), paused: room.paused(), fog: director.fog(), viewer: director.viewer()?.id ?? null, phase: state?.phase, actorCount: scene?.actors.size, roofs: scene && [...scene.roofs].map(([id, roof]) => ({ id, visible: roof.visible })), actors: scene && [...scene.actors].map(([id, a]) => ({ id, visible: a.container.visible, x: a.container.x, y: a.container.y, geometry: { visible: a.geometry.visible, scale: a.geometry.scaleX, commands: a.geometry.visible ? a.geometry.commandBuffer : [] } })), markerScale: scene?.marker, aim: inputController.aim(), cameraWidth: scene?.cameras.main.worldView.width, cameraHeight: scene?.cameras.main.worldView.height, camera: scene && { x: scene.cameras.main.worldView.x, y: scene.cameras.main.worldView.y, zoom: scene.cameras.main.zoom }, mapWidth: arenaMap?.width, map: arenaMap && { seed: arenaMap.seed, width: arenaMap.width, height: arenaMap.height, playableArea: arenaMap.playableArea, exit: arenaMap.exit, spawns: arenaMap.spawns, hunterSpawns: arenaMap.hunterSpawns, stations: arenaMap.stations.map(({ x, y }) => ({ x, y })), chargers: arenaMap.chargers.map(({ x, y }) => ({ x, y })) }, vision: scene?.visionPoints, predicted: prediction.predicted() && { x: prediction.predicted().x, y: prediction.predicted().y }, buffer: snapshots.stats(),
  discoveredCount: room.discovered().size ?? 0,
  physicsPrediction: prediction.stats(),
  pending: prediction.pendingCount(), inputStalled: me()?.inputStalled ?? null, rtt: room.roundTripMs() });
