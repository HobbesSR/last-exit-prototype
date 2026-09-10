import { movePlayer, litPoint, lineClear } from '/shared/movement.js';
import { inViewport, roofConceals } from '/shared/view.js';
import { WEAPONS, carriedCell, SLOT_COUNT } from '/shared/equipment.js';
import { slotPresentation } from '/equipment-ui.js';
import { notePacket, resetDiagnostics, diagnosticTimings } from '/diagnostics.js';
import { makeArenaScene } from '/arena-scene.js';
import * as profiler from '/shared/profiler.js';

const $ = id => document.getElementById(id);
const icon = name => `<i data-lucide="${name}"></i>`;
const icons = () => window.lucide?.createIcons();
const HZ = 20;
const KIT = { warden: ['Warden', 'Shockwave', 'zap'], specter: ['Specter', 'Pulse scan', 'radar'], striker: ['Striker', 'Overdrive', 'flame'] };
const COLORS = { access: 0xf4d26c, med: 0xff8b97, weapon: 0x8bd9f0, shield: 0xa3b9ff };
let ws, roomId, ownerKey, playerId, owner = false, arenaMap, state, liveMap, liveState, predicted;
let seq = 0, pending = [], overview = false, selectedRole = 'contestant', savedReplay, replay, playback = 0, playing = true;
let lobbyPlayers = [];
let lobbyStartsAt = null;
let pulseSkill = false, pulseInteract = false, pointerFire = false, sneakHeld = false, currentAim = 0;
let selectedSlot;
let pulseDrop = false;
let moveFrom = null, pendingMove = null;
function selectSlot(index) {
  if (moveFrom !== null) { pendingMove = { from: moveFrom, to: index }; moveFrom = null; }
  else selectedSlot = index;
}
function toggleArrange() {
  const me = state?.players.find(p => p.id === playerId);
  moveFrom = moveFrom === null && me?.inventory?.[me.selectedSlot] ? me.selectedSlot : null;
  updateHUD();
}
const movementStick = { x: 0, y: 0, active: false }, aimingStick = { x: 0, y: 0, active: false };
const held = new Set();
for (let index = 0; index < SLOT_COUNT; index++) {
  const button = document.createElement('button'); button.type = 'button'; button.dataset.slot = index;
  button.onclick = () => selectSlot(index); $('equipment-slots').append(button);
}
let toastTimer, connecting = false, disconnecting = false, lastStateAt = 0, profileOverlay;
const directed = () => !!replay || !playerId;
const time = ticks => { const seconds = Math.max(0, Math.floor(ticks / HZ)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function connection(message) { $('connection-text').textContent = message; }
async function json(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function clearInput() { moveFrom = null; pendingMove = null; held.clear(); pointerFire = false; sneakHeld = false; pulseSkill = false; pulseInteract = false; pulseDrop = false; selectedSlot = undefined; for (const stick of [movementStick, aimingStick]) Object.assign(stick, { x: 0, y: 0, active: false }); document.querySelectorAll('.virtual-stick span').forEach(el => el.style.transform = ''); }
function changeMap(map) { arenaMap = structuredClone(map); if (scene?.ready) scene.buildMap(); }
function updateLobby(data = {}) {
  lobbyStartsAt = data.startsAt || null;
  if (data.players) lobbyPlayers = data.players;
  const contestants = lobbyPlayers.filter(p => p.role === 'contestant');
  const gladiators = lobbyPlayers.filter(p => p.role === 'gladiator');
  $('lobby-room').textContent = roomId || data.room || '';
  $('lobby-count').textContent = `${contestants.length}/8 contestants / ${gladiators.length}/2 gladiators`;
  const render = (target, list, empty) => {
    target.replaceChildren();
    if (!list.length) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = empty; target.append(li); return;
    }
    for (const p of list) {
      const li = document.createElement('li'), name = document.createElement('strong'), meta = document.createElement('span');
      const kit = p.role === 'gladiator' ? ` / ${KIT[p.kit]?.[0] || p.kit}` : '';
      name.textContent = p.name; meta.textContent = `${p.role}${kit}`;
      li.append(name, meta); target.append(li);
    }
  };
  render($('lobby-contestants'), contestants, 'Open contestant slots will be bots.');
  render($('lobby-gladiators'), gladiators, 'Open gladiator slots will be bots.');
  $('start-match').hidden = !owner;
  $('start-match').disabled = !owner || data.started;
  $('lobby-waiting').hidden = owner;
  $('lobby-waiting').textContent = data.matchmade ? 'Match found. Preparing the arena…' : 'Waiting for the room owner to start the match.';
  icons();
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
  if (!key && saved?.key) { key = saved.key; role = saved.role; kit = saved.kit; name = saved.name; }
  if (ws) { disconnecting = true; ws.close(); }
  clearInput(); pending = []; seq = 0; savedReplay = null; playerId = null;
  resetDiagnostics();
  owner = false; lobbyPlayers = [];
  $('finish-recording').disabled = false;
  roomId = room; ownerKey = key; selectedRole = role;
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
      playerId = data.id; owner = data.owner; liveMap = data.map; liveState = data.state;
      if (owner) {
        try { sessionStorage.setItem(`last-exit:owner:${room}`, JSON.stringify({ key, role, kit, name })); }
        catch { toast('Owner recovery is unavailable in this browser session. Keep this tab open.'); }
      }
      replay = null; document.body.classList.remove('replaying');
      $('replay-controls').hidden = true; $('live-hud').hidden = !!data.spectator;
      changeMap(data.map); acceptState(data.state);
      history.replaceState(null, '', `?room=${room}`);
      connection(data.spectator ? 'SPECTATING' : data.started ? 'LIVE' : 'LOBBY'); $('loadout-dialog').close();
      if (!data.spectator && !data.started) showLobby(data);
    } else if (data.type === 'state') {
      notePacket(event.data.length);
      // Gap between authoritative frames: separates server pacing from client render cost.
      if (lastStateAt) profiler.observe('net.stateGap', performance.now() - lastStateAt);
      profiler.observe('net.stateBytes', event.data.length, 'n');
      liveState = data.state;
      if (!replay) acceptState(data.state);
    } else if (data.type === 'lobby') {
      updateLobby(data);
      if (data.started) { hideLobby(); connection('LIVE'); }
      else if (playerId) showLobby(data);
    } else if (data.type === 'saved') {
      savedReplay = data.replay; $('watch-match').disabled = false;
      if ($('archive-dialog').open) void loadArchive();
    } else if (data.type === 'error') {
      toast(data.message); connection('UNAVAILABLE');
      $('deploy-error').textContent = data.message; $('deploy-error').hidden = false;
      if (!playerId || !state) $('loadout-dialog').showModal();
    }
  });
  socket.addEventListener('close', () => {
    if (ws === socket && !disconnecting) { connection('OFFLINE'); clearInput(); if (!replay) toast('Connection closed. Start a new arena to reconnect.'); }
  });
  socket.addEventListener('error', () => { if (ws === socket) toast('Unable to connect to the arena server.'); });
}
function acceptState(next) {
  state = next; lastStateAt = performance.now();
  if (!arenaMap) return;
  arenaMap.gates = state.gates;
  const me = state.players.find(p => p.id === playerId);
  if (me && !replay) {
    pending = pending.filter(i => i.seq > me.lastSeq).slice(-20);
    predicted = { ...me };
    if (me.status === 'active') for (const input of pending) movePlayer(arenaMap, predicted, input);
  }
  updateHUD();
}
function updateHUD() {
  if (!state) return;
  profiler.start('render.hud');
  try { hud(); } finally { profiler.stop('render.hud'); }
}
function hud() {
  const me = state.players.find(p => p.id === playerId) || (replay ? state.players[0] : null);
  if (!me) { $('arrange-item').hidden = true; $('objective').hidden = true; $('equipment-slots').hidden = true; $('drop-item').hidden = true; }
  $('clock').textContent = time((state.duration || 2400) - state.tick);
  $('slots').textContent = state.slots;
  $('seed-label').textContent = arenaMap.seed;
  $('sector').textContent = String(Math.min(arenaMap.modules.length, 1 + Math.floor((me?.x || 0) / arenaMap.width * arenaMap.modules.length))).padStart(2, '0');
  $('remaining').textContent = `${state.contestantsActive ?? state.players.filter(p => p.role === 'contestant' && p.status === 'active').length} CONTESTANTS`;
  $('event-feed').replaceChildren(...state.events.slice(-3).map(e => { const line = document.createElement('div'); line.textContent = e.text; return line; }));
  if (me) {
    const gladiator = me.role === 'gladiator';
    const cell = carriedCell(me) || me.cell; // Older recordings stored a dedicated cell.
    $('drop-item').hidden = gladiator || !!replay || me.status !== 'active';
    $('arrange-item').hidden = $('drop-item').hidden;
    $('arrange-item').textContent = moveFrom === null ? 'Move / merge · R' : 'Choose destination · R cancels';
    $('arrange-item').setAttribute('aria-pressed', String(moveFrom !== null));
    $('equipment-slots').hidden = gladiator || !!replay;
    $('skill').hidden = !gladiator;
    for (const button of $('equipment-slots').children) {
      const index = Number(button.dataset.slot), item = me.inventory?.[index];
      const display = slotPresentation(item, state.cellChargeTicks || 100);
      if (button.dataset.item !== display.key) {
        button.innerHTML = '<span class="slot-number">' + (index + 1) + '</span>' + display.glyph + '<span class="slot-count">' + display.count + '</span>';
        button.dataset.item = display.key;
      }
      button.classList.toggle('selected', me.selectedSlot === index);
      button.classList.toggle('move-source', moveFrom === index);
      button.classList.toggle('empty-ammo', item?.kind === 'weapon' && item.ammo === 0);
      button.ariaLabel = 'Slot ' + (index + 1) + ': ' + display.name + (display.count ? ' ' + display.count : '');
      button.title = display.name + (item?.kind === 'weapon' ? ' · ' + display.count + ' rounds' : '');
      button.setAttribute('aria-pressed', String(me.selectedSlot === index));
    }
    $('objective').hidden = gladiator || !!replay || me.status !== 'active';
    const chargeTicks = state.cellChargeTicks || 100;
    $('objective').textContent = !cell ? 'EXPLORE FOR A POWER CELL · requires one inventory slot'
      : cell.charge >= chargeTicks ? 'CELL CHARGED · bring it to the escape pods · E to escape'
      : me.charging ? `CHARGING ${Math.floor(cell.charge / chargeTicks * 100)}% · stay still`
      : `CELL ${Math.floor(cell.charge / chargeTicks * 100)}% · find a charging station · E to charge`;
    $('portrait').src = `/assets/${gladiator ? 'warden' : 'contestant'}.svg`;
    $('player-name').textContent = gladiator ? KIT[me.kit][0].toUpperCase() : me.name.toUpperCase();
    $('player-level').textContent = gladiator ? `LV ${me.level}` : 'RUNNER';
    $('health-bar').style.width = `${100 * me.hp / me.maxHp}%`;
    $('health-bar').style.background = me.hp < me.maxHp * 0.3 ? '#ff8185' : '#c5f16f';
    $('health-value').textContent = `${me.hp} HP`;
    $('shield-value').textContent = gladiator ? `${me.kills} KILLS` : `${me.shield} SHIELD`;
    $('keys').textContent = me.keys; $('weapon').textContent = gladiator ? me.level : me.weapon;
    const skillName = gladiator ? KIT[me.kit][1] : 'No innate ability';
    $('skill').dataset.tip = `${skillName} (Q)`;
    $('skill-cd').textContent = me.cooldown ? `${(me.cooldown / HZ).toFixed(1)}s` : 'READY';
    $('skill').classList.toggle('active', me.boost > 0 || me.cloak > 0);
    $('skill').disabled = me.cooldown > 0 || me.status !== 'active';
    $('interact-label').textContent = gladiator ? (me.railCd ? `${(me.railCd / HZ).toFixed(1)}s` : 'RAIL') : 'USE';
    const nearbyDoor = arenaMap.gates.find(g => g.kind === 'door' && Math.hypot(g.x - me.x, g.y - me.y) < 85 && lineClear(arenaMap, me, g, g.id));
    if (nearbyDoor) $('interact-label').textContent = nearbyDoor.open ? 'CLOSE' : nearbyDoor.locked ? 'UNLOCK' : 'OPEN';
    $('interact').dataset.tip = nearbyDoor ? `${nearbyDoor.open ? 'Close door' : nearbyDoor.locked ? 'Unlock door · one key' : 'Open door'} (E)` : 'Use / charge / extract / transit (E)';
    $('sneak').hidden = gladiator;
    $('hazard-warning').hidden = replay || me.status !== 'active' || me.x - state.hazardX > 230;
    const ended = !replay && (state.phase === 'finished' || me.status !== 'active');
    $('outcome').hidden = !ended;
    if (ended) {
      const escaped = me.status === 'escaped';
      $('outcome-label').textContent = escaped ? 'EXTRACTION CONFIRMED' : state.phase === 'finished' ? 'BROADCAST COMPLETE' : 'CONTESTANT ELIMINATED';
      $('outcome-title').textContent = escaped ? 'You made it out.' : gladiator ? 'The hunt is over.' : 'End of the line.';
      $('outcome-detail').textContent = gladiator ? `${me.kills} eliminations. ${3 - state.slots} contestants escaped.` : escaped ? `${state.slots} escape slots remain.` : `${3 - state.slots} escaped. ${state.slots} exits unclaimed.`;
      $('watch-match').disabled = !savedReplay;
      if (me.status === 'respawning' && state.phase !== 'finished') {
        $('outcome-label').textContent = 'GLADIATOR REDEPLOYMENT';
        $('outcome-title').textContent = `Returning in ${Math.max(0, Math.ceil((me.respawnAt - state.tick) / HZ))}s`;
        $('outcome-detail').textContent = 'Earned upgrades are retained. Waiting for a safe transit station.';
      }
    }
  }
  profiler.start('render.minimap'); drawMinimap(); profiler.stop('render.minimap');
}

let scene;
const ArenaScene = makeArenaScene({
  map: () => arenaMap, state: () => state, playerId: () => playerId,
  self: () => !replay && predicted ? predicted : state?.players.find(p => p.id === playerId) || null,
  replay: () => !!replay, directed, overview: () => overview, aim: () => currentAim,
  // How far into the current authoritative tick the renderer is, so motion that only updates on a
  // server frame can be advanced smoothly between them.
  frameAlpha: () => replay ? playback - Math.floor(playback) : Math.min(1, (performance.now() - lastStateAt) / (1000 / HZ)),
  onReady: value => scene = value, onFire: value => pointerFire = value,
  onFrame: delta => {
    if (!replay || !playing) return;
    playback = Math.min(replay.frames.length - 1, playback + delta / 1000 * replay.hz * Number($('replay-speed').value));
    const next = replay.frames[Math.floor(playback)].state;
    if (next !== state) { state = next; arenaMap.gates = next.gates; updateHUD(); }
    $('replay-seek').value = Math.floor(playback); $('replay-time').textContent = time(state.tick);
    if (playback >= replay.frames.length - 1) setPlaying(false);
  }
});
function drawMinimap() {
  if (!arenaMap || !state) return;
  const c = $('minimap').getContext('2d'); const sx = 260 / arenaMap.width, sy = 124 / arenaMap.height;
  c.clearRect(0, 0, 260, 124);
  c.beginPath(); c.moveTo(2, 62); c.lineTo(130, 2); c.lineTo(258, 62); c.lineTo(130, 122); c.closePath(); c.fillStyle = '#304e42'; c.fill(); c.strokeStyle = '#668674'; c.stroke();
  c.strokeStyle = '#729481'; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(6, 62); c.lineTo(254, 62); c.stroke(); c.setLineDash([]);
  c.fillStyle = '#f46c7a88'; c.fillRect(0, 0, Math.max(0, state.hazardX * sx), 124);
  for (const station of arenaMap.stations) { c.fillStyle = '#92d6f0'; c.fillRect(station.x * sx - 2, station.y * sy - 2, 4, 4); }
  for (const station of arenaMap.chargers || []) { c.strokeStyle = '#f4d26c'; c.strokeRect(station.x * sx - 2, station.y * sy - 2, 4, 4); }
  // The server sends more than the eye can reach, so the minimap has to apply the same test the
  // renderer does or it would quietly become a wallhack.
  const mine = state.players.find(q => q.id === playerId);
  const shown = p => {
    if (directed() || p.id === playerId) return true;
    const known = mine?.role === 'gladiator' && p.revealed > 0;
    if (mine && roofConceals(arenaMap, mine, p)) return false;
    if (p.cloak && !known) return false;
    return known || (scene?.visionPoints && scene.eye && scene.viewBounds ? inViewport(scene.viewBounds, p.x, p.y) && litPoint(scene.visionPoints, scene.eye, p.x, p.y) : false);
  };
  for (const p of state.players) {
    if (p.status !== 'active' || !shown(p)) continue;
    c.fillStyle = p.id === playerId ? '#ffffff' : p.role === 'gladiator' ? '#ff7d8a' : '#c5f16f';
    c.beginPath(); c.arc(p.x * sx, p.y * sy, p.id === playerId ? 3.5 : 2, 0, Math.PI * 2); c.fill();
  }
  c.strokeStyle = '#deff99'; c.strokeRect(arenaMap.exit.x * sx - 3, arenaMap.exit.y * sy - 4, 6, 8);
}
function toggleMap() { overview = !overview; $('map-toggle').classList.toggle('active', overview); scene?.updateCamera(true); }
function inputTick() {
  if (replay || !state || !predicted || !ws || ws.readyState !== WebSocket.OPEN || predicted.status !== 'active') return;
  const blocked = document.querySelector('dialog[open]');
  const input = { type: 'input', seq: seq++, x: blocked ? 0 : movementStick.active ? movementStick.x : Number(held.has('KeyD') || held.has('ArrowRight')) - Number(held.has('KeyA') || held.has('ArrowLeft')), y: blocked ? 0 : movementStick.active ? movementStick.y : Number(held.has('KeyS') || held.has('ArrowDown')) - Number(held.has('KeyW') || held.has('ArrowUp')), attack: !blocked && (pointerFire || aimingStick.active && Math.hypot(aimingStick.x, aimingStick.y) > 0.2), skill: !blocked && pulseSkill, interact: !blocked && pulseInteract, sneak: !blocked && (held.has('ShiftLeft') || held.has('ShiftRight') || sneakHeld), aim: currentAim };
  if (scene?.ready) {
    const point = scene.cameras.main.getWorldPoint(scene.input.activePointer.x, scene.input.activePointer.y);
    input.aim = Math.atan2(point.y - predicted.y, point.x - predicted.x);
    if (aimingStick.active) input.aim = Math.atan2(aimingStick.y, aimingStick.x);
    else if (matchMedia('(pointer:coarse)').matches) input.aim = currentAim;
  }
  currentAim = input.aim;
  if (!blocked && pendingMove) input.moveSlot = pendingMove; pendingMove = null;
  input.drop = !blocked && pulseDrop; pulseDrop = false;
  if (selectedSlot !== undefined) { input.slot = selectedSlot; selectedSlot = undefined; }
  ws.send(JSON.stringify(input)); pending.push(input); pending = pending.slice(-20);
  movePlayer(arenaMap, predicted, input); pulseSkill = false; pulseInteract = false;
  $('sneak').classList.toggle('active', input.sneak);
}
async function newArena() {
  if (connecting) return;
  connecting = true; $('deploy-error').hidden = true;
  try {
    if ($('matchmaking').checked) {
      await connect({ matchmake: true, role: $('role-preference').value, kit: $('kit').value, name: $('callsign').value || 'Runner' }); return;
    }
    const data = await json('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: Number($('seed').value) }) });
    await connect({ room: data.id, key: data.ownerKey, role: selectedRole, kit: $('kit').value, name: $('callsign').value || 'Runner' });
  } catch (error) { $('deploy-error').textContent = error.message; $('deploy-error').hidden = false; toast(error.message); }
  finally { connecting = false; }
}
async function loadArchive() {
  $('replay-list').textContent = 'Loading broadcasts...';
  $('finish-recording').hidden = !owner || !liveState || liveState.phase === 'finished';
  try {
    const list = await json('/api/replays'); $('replay-list').replaceChildren();
    if (!list.length) { const p = document.createElement('p'); p.className = 'empty-archive'; p.textContent = 'No completed broadcasts yet.'; $('replay-list').append(p); }
    for (const r of list) {
      const row = document.createElement('div'); row.className = 'replay-row';
      const details = document.createElement('div'); const title = document.createElement('strong'); title.textContent = `Arena ${r.seed}`;
      const sub = document.createElement('small'); sub.textContent = `${time(r.ticks)} / ${r.escaped} escaped / ${new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      details.append(title, sub); const actions = document.createElement('div');
      const play = document.createElement('button'); play.className = 'icon-button'; play.ariaLabel = `Play arena ${r.seed}`; play.innerHTML = icon('play'); play.onclick = () => watchReplay(r.id);
      const download = document.createElement('button'); download.className = 'icon-button'; download.ariaLabel = `Download arena ${r.seed}`; download.innerHTML = icon('download'); download.onclick = () => downloadReplay(r.id);
      actions.append(play, download); row.append(details, actions); $('replay-list').append(row);
    }
    icons();
  } catch (error) { $('replay-list').textContent = error.message; }
}
async function watchReplay(id) {
  try {
    const data = await json(`/api/replays/${id}`);
    if (!data.frames?.length) throw new Error('Replay contains no frames.');
    if (!data.map?.obstacles) throw new Error('This broadcast uses the earlier grid prototype. Its JSON can still be downloaded.');
    clearInput(); replay = data; playback = 0; playing = true;
    changeMap(data.map); state = data.frames[0].state;
    $('outcome').hidden = true; $('archive-dialog').close(); $('live-hud').hidden = true;
    $('replay-controls').hidden = false; $('replay-seek').max = data.frames.length - 1; $('replay-seek').value = 0;
    document.body.classList.add('replaying'); connection('REPLAY'); setPlaying(true); updateHUD(); scene?.updateCamera(true);
  } catch (error) { toast(error.message); }
}
function setPlaying(value) { playing = value; $('replay-play').innerHTML = icon(value ? 'pause' : 'play'); $('replay-play').ariaLabel = value ? 'Pause replay' : 'Play replay'; icons(); }
async function downloadReplay(id) {
  try {
    const data = replay?.id === id ? replay : await json(`/api/replays/${id}`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `last-exit-${id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); }
}
function closeReplay() {
  replay = null; $('replay-controls').hidden = true; $('live-hud').hidden = false; document.body.classList.remove('replaying');
  if (liveMap && liveState) { changeMap(liveMap); acceptState(liveState); }
  connection(ws?.readyState === WebSocket.OPEN ? 'LIVE' : 'OFFLINE'); scene?.updateCamera(true);
}
document.addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea') || document.querySelector('dialog[open]')) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  held.add(e.code);
  if (!e.repeat && e.code === 'KeyG') pulseDrop = true;
  if (/^Digit[1-6]$/.test(e.code)) selectSlot(Number(e.code.slice(-1)) - 1);
  if (!e.repeat && e.code === 'KeyR') toggleArrange();
  if (!e.repeat) { if (e.code === 'KeyQ') pulseSkill = true; if (e.code === 'KeyE') pulseInteract = true; if (e.code === 'KeyM') toggleMap(); if (e.code === 'Space' && replay) setPlaying(!playing); }
});
document.addEventListener('keyup', e => held.delete(e.code));
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });
window.addEventListener('pointerup', e => { if (e.pointerType !== 'touch') { pointerFire = false; sneakHeld = false; } });
$('skill').onclick = () => pulseSkill = true; $('interact').onclick = () => pulseInteract = true;
$('sneak').onpointerdown = e => { sneakHeld = true; e.currentTarget.setPointerCapture(e.pointerId); };
$('sneak').onpointerup = $('sneak').onpointercancel = () => sneakHeld = false;
function bindStick(id, stick) {
  const element = $(id), thumb = element.querySelector('span'); let activePointer;
  const move = e => {
    if (e.pointerId !== activePointer) return;
    const box = element.getBoundingClientRect(), dx = e.clientX - box.left - box.width / 2, dy = e.clientY - box.top - box.height / 2;
    const length = Math.max(34, Math.hypot(dx, dy)); stick.x = dx / length; stick.y = dy / length;
    thumb.style.transform = `translate(${stick.x * 28}px, ${stick.y * 28}px)`;
    if (id === 'aim-stick' && Math.hypot(stick.x, stick.y) > 0.1) currentAim = Math.atan2(stick.y, stick.x);
  };
  element.onpointerdown = e => { e.preventDefault(); activePointer = e.pointerId; stick.active = true; element.setPointerCapture(e.pointerId); move(e); };
  element.onpointermove = move;
  element.onpointerup = element.onpointercancel = element.onlostpointercapture = e => { if (e.pointerId !== activePointer) return; activePointer = null; Object.assign(stick, { x: 0, y: 0, active: false }); thumb.style.transform = ''; };
}
bindStick('move-stick', movementStick); bindStick('aim-stick', aimingStick);
$('map-toggle').onclick = $('minimap-button').onclick = toggleMap;
$('new-game').onclick = $('play-again').onclick = () => { clearInput(); $('deploy-error').hidden = true; $('loadout-dialog').showModal(); };
$('deploy-form').onsubmit = e => { e.preventDefault(); void newArena(); };
$('random-seed').onclick = () => { $('seed').value = 1 + crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646; };
document.querySelectorAll('[data-role]').forEach(button => button.onclick = () => {
  selectedRole = button.dataset.role; $('kit-options').hidden = selectedRole !== 'gladiator';
  document.querySelectorAll('[data-role]').forEach(b => { const selected = b === button; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', selected); });
});
document.querySelectorAll('.close-dialog').forEach(button => button.onclick = () => button.closest('dialog').close());
$('share').onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('Arena link copied'); } catch { toast('Arena link: ' + location.href); } };
$('copy-lobby-link').onclick = $('share').onclick;
$('drop-item').onclick = () => pulseDrop = true;
$('arrange-item').onclick = toggleArrange;
$('matchmaking').onchange = () => {
  const matching = $('matchmaking').checked;
  $('preference-field').hidden = !matching; $('matchmaking-note').hidden = !matching;
  $('seed').disabled = matching; $('random-seed').disabled = matching;
  document.querySelector('.role-select').hidden = matching;
  $('kit-options').hidden = !matching && selectedRole !== 'gladiator';
};
setInterval(() => {
  if (lobbyStartsAt && $('lobby-dialog').open) $('lobby-waiting').textContent = `Match starts in ${Math.max(0, Math.ceil((lobbyStartsAt - Date.now()) / 1000))}s. Open slots will be filled by bots.`;
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
$('watch-match').onclick = () => { if (savedReplay) void watchReplay(savedReplay.id); };
$('replay-play').onclick = () => { if (replay && playback >= replay.frames.length - 1) playback = 0; setPlaying(!playing); };
$('replay-seek').oninput = () => { if (!replay) return; playback = Number($('replay-seek').value); state = replay.frames[playback].state; arenaMap.gates = state.gates; $('replay-time').textContent = time(state.tick); updateHUD(); };
$('replay-download').onclick = () => { if (replay) void downloadReplay(replay.id); };
$('replay-close').onclick = closeReplay;
document.addEventListener('pointerover', e => {
  const target = e.target.closest('[data-tip]'); if (!target || e.pointerType === 'touch') return;
  const tip = $('tooltip'); tip.textContent = target.dataset.tip; tip.hidden = false;
  const box = target.getBoundingClientRect(); tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, box.left + box.width / 2 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${box.top > tip.offsetHeight + 14 ? box.top - tip.offsetHeight - 9 : box.bottom + 9}px`;
});
document.addEventListener('pointerout', e => { if (e.target.closest('[data-tip]')) $('tooltip').hidden = true; });
icons();
new Phaser.Game({ type: Phaser.AUTO, parent: 'game', backgroundColor: '#253f3f', antialias: true, scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: ArenaScene, audio: { noAudio: true }, render: { preserveDrawingBuffer: true } });
setInterval(inputTick, 50);
const initialParams = new URLSearchParams(location.search);
const initialRoom = initialParams.get('room');
if (initialRoom) void connect({ room: initialRoom, key: initialParams.get('ownerKey') }); else void newArena();
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
    bytes ? `state ${(bytes.mean / 1024).toFixed(1)} KiB` : ''].filter(Boolean);
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
window.arenaDebug = () => ({ tick: state?.tick, room: roomId, directed: directed(), spectating: !!state && !playerId, shots: scene?.shots, me: state?.players.find(p => p.id === playerId), replay: !!replay, overview, phase: state?.phase, actorCount: scene?.actors.size, roofs: scene && [...scene.roofs].map(([id, roof]) => ({ id, visible: roof.visible })), actors: scene && [...scene.actors].map(([id, a]) => ({ id, visible: a.container.visible })), aim: currentAim, cameraWidth: scene?.cameras.main.worldView.width, camera: scene && { x: scene.cameras.main.worldView.x, y: scene.cameras.main.worldView.y, zoom: scene.cameras.main.zoom }, mapWidth: arenaMap?.width, vision: scene?.visionPoints, predicted: predicted && { x: predicted.x, y: predicted.y } });
