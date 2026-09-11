const $ = id => document.getElementById(id);

// Device state and one-shot intent only. No socket, sequence, prediction or authoritative writes.
export function createInputController({ getPlayer, onSelectionChange, onToggleMap, onToggleReplay }) {
  const listeners = new AbortController(), releaseCaptures = [];
  const listen = (target, type, handler) => target.addEventListener(type, handler, { signal: listeners.signal });
  let pulseSkill = false, pulseInteract = false, pointerFire = false, sneakHeld = false, currentAim = 0;
  let selectedSlot;
  let pulseDrop = false;
  let moveFrom = null, pendingMove = null;
  function selectSlot(index) {
    if (moveFrom !== null) { pendingMove = { from: moveFrom, to: index }; moveFrom = null; }
    else selectedSlot = index;
  }
  function toggleArrange() {
    const me = getPlayer();
    moveFrom = moveFrom === null && me?.inventory?.[me.selectedSlot] ? me.selectedSlot : null;
    onSelectionChange();
  }
  const movementStick = { x: 0, y: 0, active: false }, aimingStick = { x: 0, y: 0, active: false };
  const held = new Set();
  function clearInput() { moveFrom = null; pendingMove = null; held.clear(); pointerFire = false; sneakHeld = false; pulseSkill = false; pulseInteract = false; pulseDrop = false; selectedSlot = undefined; for (const stick of [movementStick, aimingStick]) Object.assign(stick, { x: 0, y: 0, active: false }); document.querySelectorAll('.virtual-stick span').forEach(el => el.style.transform = ''); }
  listen(document, 'keydown', e => {
    if (e.target.matches('input,select,textarea') || document.querySelector('dialog[open]')) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    held.add(e.code);
    if (!e.repeat && e.code === 'KeyG') pulseDrop = true;
    if (/^Digit[1-6]$/.test(e.code)) selectSlot(Number(e.code.slice(-1)) - 1);
    if (!e.repeat && e.code === 'KeyR') toggleArrange();
    if (!e.repeat) { if (e.code === 'KeyQ') pulseSkill = true; if (e.code === 'KeyE') pulseInteract = true; if (e.code === 'KeyM') onToggleMap(); if (e.code === 'Space') onToggleReplay(); }
  });
  listen(document, 'keyup', e => held.delete(e.code));
  listen(window, 'blur', clearInput);
  listen(document, 'visibilitychange', () => { if (document.hidden) clearInput(); });
  listen(window, 'pointerup', e => { if (e.pointerType !== 'touch') { pointerFire = false; sneakHeld = false; } });
  listen($('sneak'), 'pointerdown', e => { sneakHeld = true; e.currentTarget.setPointerCapture(e.pointerId); });
  // The original onpointerup/onpointercancel handlers returned false, cancelling default handling.
  for (const type of ['pointerup', 'pointercancel']) listen($('sneak'), type, e => { sneakHeld = false; e.preventDefault(); });
  function bindStick(id, stick) {
    const element = $(id), thumb = element.querySelector('span'); let activePointer;
    const move = e => {
      if (e.pointerId !== activePointer) return;
      const box = element.getBoundingClientRect(), dx = e.clientX - box.left - box.width / 2, dy = e.clientY - box.top - box.height / 2;
      const length = Math.max(34, Math.hypot(dx, dy)); stick.x = dx / length; stick.y = dy / length;
      thumb.style.transform = `translate(${stick.x * 28}px, ${stick.y * 28}px)`;
      if (id === 'aim-stick' && Math.hypot(stick.x, stick.y) > 0.1) currentAim = Math.atan2(stick.y, stick.x);
    };
    listen(element, 'pointerdown', e => { e.preventDefault(); activePointer = e.pointerId; stick.active = true; element.setPointerCapture(e.pointerId); move(e); });
    listen(element, 'pointermove', move);
    const release = e => { if (e.pointerId !== activePointer) return; activePointer = null; Object.assign(stick, { x: 0, y: 0, active: false }); thumb.style.transform = ''; };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(element, type, release);
    releaseCaptures.push(() => { if (activePointer != null && element.hasPointerCapture(activePointer)) element.releasePointerCapture(activePointer); });
  }
  bindStick('move-stick', movementStick); bindStick('aim-stick', aimingStick);
  function collectIntent({ blocked, pointerAim }) {
    const input = { x: blocked ? 0 : movementStick.active ? movementStick.x : Number(held.has('KeyD') || held.has('ArrowRight')) - Number(held.has('KeyA') || held.has('ArrowLeft')), y: blocked ? 0 : movementStick.active ? movementStick.y : Number(held.has('KeyS') || held.has('ArrowDown')) - Number(held.has('KeyW') || held.has('ArrowUp')), attack: !blocked && (pointerFire || aimingStick.active && Math.hypot(aimingStick.x, aimingStick.y) > 0.2), skill: !blocked && pulseSkill, interact: !blocked && pulseInteract, sneak: !blocked && (held.has('ShiftLeft') || held.has('ShiftRight') || sneakHeld), aim: currentAim };
    if (pointerAim !== undefined) {
      input.aim = pointerAim;
      if (aimingStick.active) input.aim = Math.atan2(aimingStick.y, aimingStick.x);
      else if (matchMedia('(pointer:coarse)').matches) input.aim = currentAim;
    }
    currentAim = input.aim;
    if (!blocked && pendingMove) input.moveSlot = pendingMove; pendingMove = null;
    input.drop = !blocked && pulseDrop; pulseDrop = false;
    if (selectedSlot !== undefined) { input.slot = selectedSlot; selectedSlot = undefined; }
    return input;
  }
  return {
    collectIntent, reset: clearInput, selectSlot, toggleArrange,
    selection: () => ({ moveFrom }), aim: () => currentAim,
    setPointerFire: value => pointerFire = value,
    skill: () => pulseSkill = true, interact: () => pulseInteract = true, drop: () => pulseDrop = true,
    // Preserve consumption after the application has sent and predicted this input.
    consumeActions: () => { pulseSkill = false; pulseInteract = false; },
    destroy() { listeners.abort(); for (const release of releaseCaptures) release(); clearInput(); }
  };
}
