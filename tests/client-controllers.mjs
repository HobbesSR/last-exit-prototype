import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGame, snapshot } from '../shared/simulation.ts';

// Exercise the controllers without the application, socket, prediction, or Phaser scene.
export async function checkClientControllers(browser, base) {
  const page = await browser.newPage();
  const html = (await readFile('public/index.html', 'utf8')).replace('<script type="module" src="/client.js"></script>', '');
  await page.route('**/controller-fixture', route => route.fulfill({ contentType: 'text/html', body: html }));
  const game = createGame(4217), me = game.players[0], enemy = game.players[8];
  Object.assign(me, { x: 12000, y: 6000, inventory: [{ kind: 'weapon', weaponType: 'pistol', ammo: 7 }, null, null, null, null, { kind: 'cell', charge: 100 }], selectedSlot: 0 });
  Object.assign(enemy, { x: 12100, y: 6000 });
  game.players = [me, enemy]; game.map.buildings = []; game.map.gates = []; game.map.obstacles = [];
  try {
    await page.goto(`${base}/controller-fixture`);
    const result = await page.evaluate(async ({ state, arenaMap }) => {
      const { createInputController } = await import('/input-controller.js');
      const { createHUDController } = await import('/hud-controller.js');
      const $ = id => document.getElementById(id), me = state.players[0];
      const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
      freeze(state); freeze(arenaMap);
      let selectionChanges = 0, mapActions = 0, replayActions = 0;
      const input = createInputController({ getPlayer: () => me, onSelectionChange: () => selectionChanges++, onToggleMap: () => mapActions++, onToggleReplay: () => replayActions++ });
      const hud = createHUDController({ selectSlot: input.selectSlot, arrange: input.toggleArrange, skill: input.skill, interact: input.interact, drop: input.drop, moveSlot: input.moveSlot, dropSlot: input.dropSlot, cancelPointerFire: () => input.setPointerFire(false), toggleMap: () => mapActions++ });
      const key = code => document.body.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      const collect = blocked => input.collectIntent({ blocked, pointerAim: 0.75 });
      key('KeyD'); key('KeyQ'); key('KeyE'); key('KeyG'); key('Digit6');
      input.setPointerFire(true);
      const first = collect(false); input.consumeActions(); const second = collect(false);
      window.dispatchEvent(new Event('blur')); const blurred = collect(false);
      input.toggleArrange(); input.selectSlot(5); const arranged = collect(false);
      input.toggleArrange(); input.selectSlot(4); input.drop(); input.skill();
      const blocked = collect(true); input.consumeActions(); const afterBlocked = collect(false);
      input.selectSlot(5); input.interact(); input.reset(); const reset = collect(false);
      key('KeyM'); key('Space');
      $('archive-dialog').showModal(); key('KeyD'); key('KeyQ'); key('Digit4'); $('archive-dialog').close();
      const dialog = collect(false);
      // A hidden document must release held input, just like blur.
      key('KeyD'); input.drop();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange')); delete document.hidden;
      const hidden = collect(false);
      const sneakRelease = new PointerEvent('pointerup', { cancelable: true });
      $('sneak').dispatchEvent(sneakRelease);
      const eye = { x: me.x, y: me.y }, points = Array.from({ length: 64 }, (_, i) => {
        const angle = -Math.PI + i * Math.PI * 2 / 64;
        return { angle, x: eye.x + Math.cos(angle) * 500, y: eye.y + Math.sin(angle) * 500 };
      });
      const visibility = { directed: false, eye, points, bounds: { x: 11500, y: 5500, width: 1000, height: 1000 } };
      const props = { state, arenaMap, playerId: me.id, replay: false, savedReplay: null, selection: input.selection(), visibility };
      const canvas = $('minimap').getContext('2d'), arc = canvas.arc.bind(canvas); let dots = 0;
      canvas.arc = (...args) => { dots++; arc(...args); };
      function render(extra) { dots = 0; hud.render({ ...props, ...extra }); return dots; }
      const visible = render({}), noSight = render({ visibility: { directed: false } });
      const cloakedState = { ...state, players: [me, { ...state.players[1], cloak: 10 }] };
      const cloaked = render({ state: freeze(cloakedState) });
      const roof = render({ arenaMap: freeze({ ...arenaMap, buildings: [{ id: 'roof', x: 12075, y: 5975, w: 50, h: 50 }] }) });
      const outsideViewport = render({ visibility: { ...visibility, bounds: { x: 11990, y: 5990, width: 20, height: 20 } } });
      const directed = render({ state: cloakedState, visibility: { directed: true } });
      render({});
      const slots = [...$('equipment-slots').children].map(b => b.ariaLabel);
      const slot = index => $('equipment-slots').children[index];
      // Synthetic events have no native active pointer; real capture is covered by browser.mjs.
      for (const button of $('equipment-slots').children) {
        button.setPointerCapture = () => {}; button.hasPointerCapture = () => false;
      }
      const gesture = (button, type, x, y, pointerId, pointerType = 'mouse') => button.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType, isPrimary: true, clientX: x, clientY: y }));
      const canvasTarget = document.createElement('canvas'); $('game').append(canvasTarget);
      const elementFromPoint = document.elementFromPoint;
      document.elementFromPoint = () => slot(1);
      input.reset(); input.setPointerFire(true);
      gesture(slot(5), 'pointerdown', 10, 10, 71); gesture(slot(5), 'pointermove', 28, 10, 71); gesture(slot(5), 'pointerup', 28, 10, 71);
      const draggedMove = collect(false);
      document.elementFromPoint = () => canvasTarget;
      input.reset(); input.setPointerFire(true);
      gesture(slot(5), 'pointerdown', 10, 10, 72, 'touch'); gesture(slot(5), 'pointermove', 28, 10, 72, 'touch'); gesture(slot(5), 'pointerup', 28, 10, 72, 'touch');
      const draggedDrop = collect(false);
      document.elementFromPoint = () => slot(1);
      input.reset();
      gesture(slot(5), 'pointerdown', 10, 10, 73); gesture(slot(5), 'pointermove', 28, 10, 73); gesture(slot(5), 'pointercancel', 28, 10, 73);
      const cancelledDrag = collect(false);
      input.reset();
      gesture(slot(5), 'pointerdown', 10, 10, 74); gesture(slot(5), 'pointerup', 10, 10, 74); slot(5).click();
      const tappedSlot = collect(false);
      const cancelledGestures = [];
      for (const reason of ['lostcapture', 'blur', 'dialog', 'reset', 'replay', 'inactive', 'ui']) {
        input.reset(); render({});
        document.elementFromPoint = () => canvasTarget;
        gesture(slot(5), 'pointerdown', 10, 10, 75); gesture(slot(5), 'pointermove', 28, 10, 75);
        if (reason === 'lostcapture') gesture(slot(5), 'lostpointercapture', 28, 10, 75);
        if (reason === 'blur') window.dispatchEvent(new Event('blur'));
        if (reason === 'dialog') $('archive-dialog').showModal();
        if (reason === 'reset') { hud.cancelDrag(); input.reset(); }
        if (reason === 'replay') render({ replay: true });
        if (reason === 'inactive') render({ state: { ...state, players: [{ ...me, status: 'stranded' }] } });
        if (reason === 'ui') document.elementFromPoint = () => $('map-toggle');
        gesture(slot(5), 'pointerup', 28, 10, 75);
        cancelledGestures.push({ reason, intent: collect(false) });
        if (reason === 'dialog') $('archive-dialog').close();
      }
      render({}); input.reset();
      input.dropSlot(5); input.selectSlot(0); input.moveSlot(0, 1);
      const pinnedDrop = collect(false), afterPinnedDrop = collect(false);
      input.dropSlot(5); const blockedDragDrop = collect(true);
      document.elementFromPoint = elementFromPoint;
      $('arrange-item').click(); $('equipment-slots').children[5].click(); $('drop-item').click(); $('interact').click();
      const clicked = collect(false);
      const beforeDestroy = { selectionChanges, mapActions, replayActions };
      input.destroy(); hud.destroy(); key('KeyD'); key('KeyM'); $('map-toggle').click(); $('drop-item').click();
      const destroyed = collect(false);
      return { first, second, blurred, arranged, blocked, afterBlocked, reset, dialog, hidden, clicked, draggedMove, draggedDrop, cancelledDrag, tappedSlot, cancelledGestures, pinnedDrop, afterPinnedDrop, blockedDragDrop, destroyed,
        dots: { visible, noSight, cloaked, roof, outsideViewport, directed }, slots,
        beforeDestroy, afterDestroy: { selectionChanges, mapActions, replayActions }, buttonsAfterDestroy: $('equipment-slots').children.length,
        sneakReleaseCancelled: sneakRelease.defaultPrevented };
    }, { state: snapshot(game), arenaMap: game.map });
    assert.equal(result.first.x, 1); assert.equal(result.first.aim, 0.75); assert.equal(result.first.slot, 5);
    for (const action of ['skill', 'interact', 'drop', 'attack']) assert.equal(result.first[action], true);
    assert.equal(result.second.attack, true); assert.equal(result.second.skill, false); assert.equal(result.second.interact, false); assert.equal(result.second.drop, false); assert.equal(result.second.slot, undefined);
    for (const name of ['blurred', 'blocked', 'afterBlocked', 'reset', 'dialog', 'hidden', 'destroyed']) {
      assert.equal(result[name].x, 0, name);
      for (const action of ['attack', 'skill', 'interact', 'drop']) assert.equal(result[name][action], false, `${name} ${action}`);
      assert.equal(result[name].moveSlot, undefined, name); assert.equal(result[name].slot, undefined, name);
    }
    assert.deepEqual(result.arranged.moveSlot, { from: 0, to: 5 });
    assert.deepEqual(result.clicked.moveSlot, { from: 0, to: 5 }); assert.equal(result.clicked.drop, true); assert.equal(result.clicked.interact, true);
    assert.deepEqual(result.draggedMove.moveSlot, { from: 5, to: 1 }); assert.equal(result.draggedMove.slot, 5); assert.equal(result.draggedMove.attack, false);
    assert.equal(result.draggedDrop.slot, 5); assert.equal(result.draggedDrop.drop, true); assert.equal(result.draggedDrop.moveSlot, undefined); assert.equal(result.draggedDrop.attack, false);
    assert.equal(result.cancelledDrag.slot, undefined); assert.equal(result.cancelledDrag.moveSlot, undefined); assert.equal(result.cancelledDrag.drop, false);
    assert.equal(result.tappedSlot.slot, 5); assert.equal(result.tappedSlot.moveSlot, undefined); assert.equal(result.tappedSlot.drop, false);
    for (const { reason, intent } of result.cancelledGestures) {
      assert.equal(intent.slot, undefined, reason); assert.equal(intent.moveSlot, undefined, reason); assert.equal(intent.drop, false, reason);
    }
    assert.equal(result.pinnedDrop.slot, 5); assert.equal(result.pinnedDrop.drop, true); assert.equal(result.pinnedDrop.moveSlot, undefined);
    for (const intent of [result.afterPinnedDrop, result.blockedDragDrop]) {
      assert.equal(intent.slot, undefined); assert.equal(intent.drop, false); assert.equal(intent.moveSlot, undefined);
    }
    assert.deepEqual(result.dots, { visible: 2, noSight: 1, cloaked: 1, roof: 1, outsideViewport: 1, directed: 2 });
    assert.equal(result.slots.length, 6); assert.match(result.slots[5], /^Slot 6: /);
    assert.deepEqual(result.beforeDestroy, result.afterDestroy); assert.equal(result.buttonsAfterDestroy, 0);
    assert.equal(result.sneakReleaseCancelled, true, 'preserve the original property handler return-false behavior');
  } finally { await page.close(); }
}
