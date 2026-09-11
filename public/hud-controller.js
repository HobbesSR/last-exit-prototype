import { litPoint, lineClear } from '/shared/movement.js';
import { inViewport, roofConceals } from '/shared/view.js';
import { carriedCell, SLOT_COUNT } from '/shared/equipment.js';
import { slotPresentation } from '/equipment-ui.js';
import * as profiler from '/shared/profiler.js';
const $ = id => document.getElementById(id);
const HZ = 20;
const KIT = { warden: ['Warden', 'Shockwave', 'zap'], specter: ['Specter', 'Pulse scan', 'radar'], striker: ['Striker', 'Overdrive', 'flame'] };
const time = ticks => { const seconds = Math.max(0, Math.floor(ticks / HZ)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };

// Render supplied state without mutating it; application callbacks own all user actions.
export function createHUDController(actions) {
  const listeners = new AbortController(), buttons = [];
  const listen = (target, type, handler) => target.addEventListener(type, handler, { signal: listeners.signal });
  for (let index = 0; index < SLOT_COUNT; index++) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.slot = index;
    listen(button, 'click', () => actions.selectSlot(index)); $('equipment-slots').append(button); buttons.push(button);
  }
  for (const [id, action] of [['skill', 'skill'], ['interact', 'interact'], ['drop-item', 'drop'], ['arrange-item', 'arrange'], ['map-toggle', 'toggleMap'], ['minimap-button', 'toggleMap']]) {
    listen($(id), 'click', () => actions[action]());
  }
  listen(document, 'pointerover', e => {
    const target = e.target.closest('[data-tip]'); if (!target || e.pointerType === 'touch') return;
    const tip = $('tooltip'); tip.textContent = target.dataset.tip; tip.hidden = false;
    const box = target.getBoundingClientRect(); tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, box.left + box.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${box.top > tip.offsetHeight + 14 ? box.top - tip.offsetHeight - 9 : box.bottom + 9}px`;
  });
  listen(document, 'pointerout', e => { if (e.target.closest('[data-tip]')) $('tooltip').hidden = true; });
  function hud({ state, arenaMap, playerId, replay, savedReplay, selection: { moveFrom }, visibility }) {
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
    profiler.start('render.minimap'); drawMinimap({ arenaMap, state, playerId, visibility }); profiler.stop('render.minimap');
  }
  function drawMinimap({ arenaMap, state, playerId, visibility }) {
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
      if (visibility.directed || p.id === playerId) return true;
      const known = mine?.role === 'gladiator' && p.revealed > 0;
      if (mine && roofConceals(arenaMap, mine, p)) return false;
      if (p.cloak && !known) return false;
      return known || (visibility.points && visibility.eye && visibility.bounds ? inViewport(visibility.bounds, p.x, p.y) && litPoint(visibility.points, visibility.eye, p.x, p.y) : false);
    };
    for (const p of state.players) {
      if (p.status !== 'active' || !shown(p)) continue;
      c.fillStyle = p.id === playerId ? '#ffffff' : p.role === 'gladiator' ? '#ff7d8a' : '#c5f16f';
      c.beginPath(); c.arc(p.x * sx, p.y * sy, p.id === playerId ? 3.5 : 2, 0, Math.PI * 2); c.fill();
    }
    c.strokeStyle = '#deff99'; c.strokeRect(arenaMap.exit.x * sx - 3, arenaMap.exit.y * sy - 4, 6, 8);
  }
  return {
    render(props) {
      if (!props.state) return;
      profiler.start('render.hud');
      try { hud(props); } finally { profiler.stop('render.hud'); }
    },
    setSneak: value => $('sneak').classList.toggle('active', value),
    destroy() { listeners.abort(); for (const button of buttons) button.remove(); $('tooltip').hidden = true; }
  };
}
