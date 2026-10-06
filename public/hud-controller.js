import { lineClear } from '/shared/movement.ts';
import { seesActor } from '/shared/view.ts';
import { carriedCell, SLOT_COUNT } from '/shared/equipment.ts';
import { slotPresentation } from '/equipment-ui.js';
import * as profiler from '/shared/profiler.ts';
import { $, HZ, kitName, kitSkill, time } from '/ui.js';

// Render supplied state without mutating it; application callbacks own all user actions.
export function createHUDController(actions) {
  const listeners = new AbortController(), buttons = [];
  const listen = (target, type, handler) => target.addEventListener(type, handler, { signal: listeners.signal });
  let drag, dragEnabled = false;
  const suppressedClicks = new WeakSet();
  const cancelDrag = () => {
    if (!drag) return;
    const { button, pointerId, moved } = drag;
    drag = null;
    if (moved) suppressedClicks.add(button);
    if (button.hasPointerCapture?.(pointerId)) button.releasePointerCapture(pointerId);
    button.classList.remove('dragging'); document.body.classList.remove('inventory-dragging');
  };
  const slotAtPoint = (x, y) => {
    const target = document.elementFromPoint(x, y);
    const button = target?.closest?.('#equipment-slots button[data-slot]');
    return button ? Number(button.dataset.slot) : null;
  };
  const setText = (el, text) => { const s = String(text); if (el.textContent !== s) el.textContent = s; };
  const setHidden = (el, val) => { const b = Boolean(val); if (el.hidden !== b) el.hidden = b; };
  for (let index = 0; index < SLOT_COUNT; index++) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.slot = index;
    listen(button, 'click', e => {
      if (suppressedClicks.delete(button) && e.detail !== 0) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      actions.selectSlot(index);
    });
    listen(button, 'pointerdown', e => {
      suppressedClicks.delete(button);
      if (drag || !dragEnabled || (e.pointerType !== 'touch' && e.button !== 0) || document.querySelector('dialog[open]') || actions.canDrag?.() === false || button.dataset.occupied !== 'true') return;
      drag = { button, pointerId: e.pointerId, source: index, x: e.clientX, y: e.clientY, moved: false };
      button.setPointerCapture(e.pointerId);
    });
    listen(button, 'pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= 8) {
        drag.moved = true; actions.cancelPointerFire?.(); button.classList.add('dragging'); document.body.classList.add('inventory-dragging');
      }
      if (drag.moved) e.preventDefault();
    });
    listen(button, 'pointerup', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const active = drag; cancelDrag();
      if (!active.moved) return;
      suppressedClicks.add(button); e.preventDefault();
      if (!dragEnabled || document.querySelector('dialog[open]') || actions.canDrag?.() === false) return;
      const destination = slotAtPoint(e.clientX, e.clientY);
      if (destination !== null && destination !== active.source) actions.moveSlot(active.source, destination);
      else if (document.elementFromPoint(e.clientX, e.clientY) === document.querySelector('#game canvas')) actions.dropSlot(active.source);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) listen(button, type, e => {
      if (drag && e.pointerId === drag.pointerId) cancelDrag();
    });
    $('equipment-slots').append(button); buttons.push(button);
  }
  listen(window, 'blur', cancelDrag);
  listen(document, 'visibilitychange', () => { if (document.hidden) cancelDrag(); });
  let suppressNextClick = false;
  document.addEventListener('click', e => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, { capture: true, signal: listeners.signal });
  for (const [id, action] of [['skill', 'skill'], ['interact', 'interact'], ['drop-item', 'drop'], ['arrange-item', 'arrange'], ['fullscreen-toggle', 'toggleFullscreen']]) {
    listen($(id), 'click', () => actions[action]());
  }
  const showTooltip = (target) => {
    const tip = $('tooltip'); setText(tip, target.dataset.tip); setHidden(tip, false);
    const box = target.getBoundingClientRect(); tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, box.left + box.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${box.top > tip.offsetHeight + 14 ? box.top - tip.offsetHeight - 9 : box.bottom + 9}px`;
  };
  listen(document, 'pointerover', e => {
    const target = e.target.closest('[data-tip]'); if (!target || e.pointerType === 'touch') return;
    showTooltip(target);
  });
  listen(document, 'pointerout', e => { if (e.target.closest('[data-tip]') && e.pointerType !== 'touch') setHidden($('tooltip'), true); });

  let touchTipTimeout, activeTouchTip, touchStartX, touchStartY;
  listen(document, 'pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    const target = e.target.closest('[data-tip]');
    if (!target) return;
    touchStartX = e.clientX; touchStartY = e.clientY;
    touchTipTimeout = setTimeout(() => {
      activeTouchTip = target;
      showTooltip(target);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 500);
  });
  const cancelTouchTip = () => {
    clearTimeout(touchTipTimeout);
    if (activeTouchTip) { setHidden($('tooltip'), true); activeTouchTip = null; }
  };
  listen(document, 'pointerup', e => {
    if (activeTouchTip && e.pointerType === 'touch') {
      suppressNextClick = true;
      setTimeout(() => { suppressNextClick = false; }, 0);
    }
    cancelTouchTip();
  });
  listen(document, 'pointercancel', cancelTouchTip);
  listen(document, 'pointermove', e => {
    if (e.pointerType !== 'touch') return;
    if (Math.hypot(e.clientX - touchStartX, e.clientY - touchStartY) > 8) {
      clearTimeout(touchTipTimeout);
      cancelTouchTip();
    }
  });
  listen(document, 'contextmenu', e => {
    if (e.target.closest('[data-tip]')) e.preventDefault();
  });
  function hud({ state, arenaMap, playerId, replay, savedReplay, selection: { moveFrom }, visibility }) {
    const me = state.players.find(p => p.id === playerId) || (replay ? state.players[0] : null);
    dragEnabled = false;
    if (!me) { cancelDrag(); setHidden($('arrange-item'), true); setHidden($('objective'), true); setHidden($('equipment-slots'), true); setHidden($('drop-item'), true); }
    setText($('clock'), time((state.duration || 2400) - state.tick));
    setText($('slots'), state.slots);
    setText($('seed-label'), arenaMap.seed);
    setText($('sector'), String(Math.min(arenaMap.modules.length, 1 + Math.floor((me?.x || 0) / arenaMap.width * arenaMap.modules.length))).padStart(2, '0'));
    setText($('remaining'), `${state.contestantsActive ?? state.players.filter(p => p.role === 'contestant' && p.status === 'active').length} CONTESTANTS`);
    
    const feedTexts = state.events.slice(-3).map(e => e.text);
    const feedStr = feedTexts.join('|');
    if ($('event-feed').dataset.feed !== feedStr) {
      $('event-feed').replaceChildren(...feedTexts.map(text => { const line = document.createElement('div'); line.textContent = text; return line; }));
      $('event-feed').dataset.feed = feedStr;
    }
    
    if (me) {
      const gladiator = me.role === 'gladiator';
      dragEnabled = !gladiator && !replay && me.status === 'active' && !document.querySelector('dialog[open]');
      if (!dragEnabled) cancelDrag();
      const cell = carriedCell(me) || me.cell; // Older recordings stored a dedicated cell.
      setHidden($('drop-item'), gladiator || !!replay || me.status !== 'active');
      setHidden($('arrange-item'), $('drop-item').hidden);
      setText($('arrange-item'), moveFrom === null ? 'Move / merge · R' : 'Choose destination · R cancels');
      
      const arr = $('arrange-item');
      if (arr.getAttribute('aria-pressed') !== String(moveFrom !== null)) arr.setAttribute('aria-pressed', String(moveFrom !== null));
      
      setHidden($('equipment-slots'), gladiator || !!replay);
      setHidden($('skill'), !gladiator);
      for (const button of $('equipment-slots').children) {
        const index = Number(button.dataset.slot), item = me.inventory?.[index];
        const display = slotPresentation(item, state.cellChargeTicks || 100);
        if (button.dataset.item !== display.key) {
          button.innerHTML = '<span class="slot-number">' + (index + 1) + '</span>' + display.glyph + '<span class="slot-count">' + display.count + '</span>';
          button.dataset.item = display.key;
        }
        button.classList.toggle('selected', me.selectedSlot === index);
        button.classList.toggle('move-source', moveFrom === index);
        button.dataset.occupied = String(!!item);
        button.classList.toggle('empty-ammo', item?.kind === 'weapon' && item.ammo === 0);
        
        const ariaLabel = 'Slot ' + (index + 1) + ': ' + display.name + (display.count ? ' ' + display.count : '');
        if (button.ariaLabel !== ariaLabel) button.ariaLabel = ariaLabel;
        
        const title = display.name + (item?.kind === 'weapon' ? ' · ' + display.count + ' rounds' : '');
        if (button.title !== title) button.title = title;
        
        const ariaPressed = String(me.selectedSlot === index);
        if (button.getAttribute('aria-pressed') !== ariaPressed) button.setAttribute('aria-pressed', ariaPressed);
      }
      setHidden($('objective'), gladiator || !!replay || me.status !== 'active');
      const chargeTicks = state.cellChargeTicks || 100;
      setText($('objective'), !cell ? 'EXPLORE FOR A POWER CELL · requires one inventory slot'
        : cell.charge >= chargeTicks ? 'CELL CHARGED · bring it to the escape pods · E to escape'
        : me.charging ? `CHARGING ${Math.floor(cell.charge / chargeTicks * 100)}% · stay still`
        : `CELL ${Math.floor(cell.charge / chargeTicks * 100)}% · find a charging station · E to charge`);
      
      const portraitSrc = `/assets/${gladiator ? 'warden' : 'contestant'}.svg`;
      if ($('portrait').getAttribute('src') !== portraitSrc) $('portrait').src = portraitSrc;
      
      setText($('player-name'), gladiator ? kitName(me.kit).toUpperCase() : me.name.toUpperCase());
      setText($('player-level'), gladiator ? `LV ${me.level}` : 'RUNNER');
      
      const hpW = `${100 * me.hp / me.maxHp}%`;
      if ($('health-bar').style.width !== hpW) $('health-bar').style.width = hpW;
      const hpBg = me.hp < me.maxHp * 0.3 ? '#ff8185' : '#c5f16f';
      if ($('health-bar').style.background !== hpBg) $('health-bar').style.background = hpBg;
      
      setText($('health-value'), `${me.hp} HP`);
      setText($('shield-value'), gladiator ? `${me.kills} KILLS` : `${me.shield} SHIELD`);
      setText($('keys'), me.keys); 
      setText($('weapon'), gladiator ? me.level : me.weapon);
      
      const skillName = gladiator ? kitSkill(me.kit) : kitSkill(null);
      const skillTip = `${skillName} (Q)`;
      if ($('skill').dataset.tip !== skillTip) $('skill').dataset.tip = skillTip;
      
      setText($('skill-cd'), me.cooldown ? `${(me.cooldown / HZ).toFixed(1)}s` : 'READY');
      $('skill').classList.toggle('active', me.boost > 0 || me.cloak > 0);
      
      const skillDisabled = me.cooldown > 0 || me.status !== 'active';
      if ($('skill').disabled !== skillDisabled) $('skill').disabled = skillDisabled;
      
      setText($('interact-label'), gladiator ? (me.railCd ? `${(me.railCd / HZ).toFixed(1)}s` : 'RAIL') : 'USE');
      const nearbyDoor = arenaMap.gates.find(g => g.kind === 'door' && Math.hypot(g.x - me.x, g.y - me.y) < 85 && lineClear(arenaMap, me, g, g.id));
      if (nearbyDoor) setText($('interact-label'), nearbyDoor.open ? 'CLOSE' : nearbyDoor.locked ? 'UNLOCK' : 'OPEN');
      
      const interactTip = nearbyDoor ? `${nearbyDoor.open ? 'Close door' : nearbyDoor.locked ? 'Unlock door · one key' : 'Open door'} (E)` : 'Use / charge / extract / transit (E)';
      if ($('interact').dataset.tip !== interactTip) $('interact').dataset.tip = interactTip;
      
      setHidden($('sneak'), gladiator);
      setHidden($('hazard-warning'), replay || me.status !== 'active' || me.x - state.hazardX > 230);
      
      const ended = !replay && (state.phase === 'finished' || me.status !== 'active');
      setHidden($('outcome'), !ended);
      if (ended) {
        const escaped = me.status === 'escaped';
        setText($('outcome-label'), escaped ? 'EXTRACTION CONFIRMED' : state.phase === 'finished' ? 'BROADCAST COMPLETE' : 'CONTESTANT ELIMINATED');
        setText($('outcome-title'), escaped ? 'You made it out.' : gladiator ? 'The hunt is over.' : 'End of the line.');
        setText($('outcome-detail'), gladiator ? `${me.kills} eliminations. ${3 - state.slots} contestants escaped.` : escaped ? `${state.slots} escape slots remain.` : `${3 - state.slots} escaped. ${state.slots} exits unclaimed.`);
        
        const watchDisabled = !savedReplay;
        if ($('watch-match').disabled !== watchDisabled) $('watch-match').disabled = watchDisabled;
        
        if (me.status === 'respawning' && state.phase !== 'finished') {
          setText($('outcome-label'), 'GLADIATOR REDEPLOYMENT');
          setText($('outcome-title'), `Returning in ${Math.max(0, Math.ceil((me.respawnAt - state.tick) / HZ))}s`);
          setText($('outcome-detail'), 'Earned upgrades are retained. Waiting for a safe transit station.');
        }
      }
    }
    profiler.start('render.minimap'); drawMinimap({ arenaMap, state, playerId, visibility }); profiler.stop('render.minimap');
  }
  let mColors = null;
  const getMinimapColors = () => {
    if (mColors) return mColors;
    const style = getComputedStyle(document.body);
    return mColors = {
      wall: style.getPropertyValue('--minimap-wall').trim() || '#304e42',
      hazard: style.getPropertyValue('--minimap-hazard').trim() || '#f46c7a88',
      border: style.getPropertyValue('--minimap-border').trim() || '#668674',
      dash: style.getPropertyValue('--minimap-dash').trim() || '#729481',
      station: style.getPropertyValue('--minimap-station').trim() || '#92d6f0',
      charger: style.getPropertyValue('--minimap-charger').trim() || '#f4d26c',
      me: style.getPropertyValue('--minimap-me').trim() || '#ffffff',
      gladiator: style.getPropertyValue('--coral').trim() || '#ff7d8a',
      contestant: style.getPropertyValue('--lime').trim() || '#c5f16f',
      exit: style.getPropertyValue('--minimap-exit').trim() || '#deff99',
    };
  };

  function drawMinimap({ arenaMap, state, playerId, visibility }) {
    if (!arenaMap || !state) return;
    const cols = getMinimapColors();
    const c = $('minimap').getContext('2d'); const sx = 260 / arenaMap.width, sy = 124 / arenaMap.height;
    c.clearRect(0, 0, 260, 124);
    if (arenaMap.playableArea) {
      const { cellSize, rows } = arenaMap.playableArea;
      c.beginPath();
      for (const row of rows) for (const [start, end] of row.runs)
        c.rect(start * cellSize * sx, row.y * cellSize * sy, (end - start) * cellSize * sx, cellSize * sy);
      c.fillStyle = cols.wall; c.fill();
      c.save(); c.clip();
      c.fillStyle = cols.hazard; c.fillRect(0, 0, Math.max(0, state.hazardX * sx), 124);
      c.restore();
    } else {
      c.beginPath(); c.moveTo(2, 62); c.lineTo(130, 2); c.lineTo(258, 62); c.lineTo(130, 122); c.closePath(); c.fillStyle = cols.wall; c.fill(); c.strokeStyle = cols.border; c.stroke();
      c.strokeStyle = cols.dash; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(6, 62); c.lineTo(254, 62); c.stroke(); c.setLineDash([]);
      c.fillStyle = cols.hazard; c.fillRect(0, 0, Math.max(0, state.hazardX * sx), 124);
    }
    for (const station of arenaMap.stations) { c.fillStyle = cols.station; c.fillRect(station.x * sx - 2, station.y * sy - 2, 4, 4); }
    for (const station of arenaMap.chargers || []) { c.strokeStyle = cols.charger; c.strokeRect(station.x * sx - 2, station.y * sy - 2, 4, 4); }
    // The server sends more than the eye can reach, so the minimap applies the very same predicate the
    // renderer does — literally the same function, so the two views cannot drift apart again.
    const mine = state.players.find(q => q.id === playerId);
    const shown = p => visibility.directed || p.id === playerId || seesActor(visibility.sight, arenaMap, mine, p);
    for (const p of state.players) {
      if (p.status !== 'active' || !shown(p)) continue;
      c.fillStyle = p.id === playerId ? cols.me : p.role === 'gladiator' ? cols.gladiator : cols.contestant;
      c.beginPath(); c.arc(p.x * sx, p.y * sy, p.id === playerId ? 3.5 : 2, 0, Math.PI * 2); c.fill();
    }
    c.strokeStyle = cols.exit; c.strokeRect(arenaMap.exit.x * sx - 3, arenaMap.exit.y * sy - 4, 6, 8);
  }
  return {
    render(props) {
      if (!props.state) return;
      profiler.start('render.hud');
      try { hud(props); } finally { profiler.stop('render.hud'); }
    },
    setSneak: value => $('sneak').classList.toggle('active', value),
    cancelDrag,
    destroy() { cancelDrag(); listeners.abort(); for (const button of buttons) button.remove(); $('tooltip').hidden = true; }
  };
}
