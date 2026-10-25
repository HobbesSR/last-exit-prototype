import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGame, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';

// L2 controls (#444): R reloads, M moves/merges, and the reserve chips and Reload button are the touch path.
export async function checkReloadControls(browser, base) {
  const page = await browser.newPage();
  page.on('pageerror', e => { throw e; });
  const html = (await readFile('public/index.html', 'utf8')).replace('<script type="module" src="/client.js"></script>', '');
  await page.route('**/reload-fixture', route => route.fulfill({ contentType: 'text/html', body: html }));
  const game = createGame(4217, undefined, contentById('content-ammo-1')), me = game.players[0];
  Object.assign(me, { inventory: [{ kind: 'weapon', weaponType: 'pistol', ammo: 3, instanceId: 'gun' }, { kind: 'med', count: 1 }, null, null, null, null], selectedSlot: 0,
    reserves: { pistol: 36, rifle: 0, shell: 4 } });
  game.players = [me];
  try {
    await page.goto(`${base}/reload-fixture`);
    const result = await page.evaluate(async ({ state, arenaMap }) => {
      const { createInputController } = await import('/input-controller.js');
      const { createHUDController } = await import('/hud-controller.js');
      const $ = id => document.getElementById(id);
      let me = state.players[0];
      const input = createInputController({ getPlayer: () => me, onSelectionChange: () => {}, onToggleFullscreen: () => {}, onToggleReplay: () => {} });
      const hud = createHUDController({ selectSlot: input.selectSlot, arrange: input.toggleArrange, skill: input.skill, interact: input.interact, drop: input.drop, reload: input.reload, dropAmmo: input.dropAmmo,
        moveSlot: input.moveSlot, dropSlot: input.dropSlot, cancelPointerFire: () => input.setPointerFire(false), toggleFullscreen: () => {} });
      const key = code => document.body.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      const collect = (blocked = false) => input.collectIntent({ blocked, pointerAim: 0 });
      const render = (extra = {}) => hud.render({ state: { ...state, players: [me] }, arenaMap, playerId: me.id, view: 'play', savedReplay: null, selection: input.selection(), visibility: { directed: false }, ...extra });
      const panel = () => ({ hidden: $('ammo-panel').hidden, reload: $('reload-item').textContent, arrange: $('arrange-item').textContent,
        chips: [...$('ammo-reserves').children].map(chip => [chip.textContent, chip.disabled, chip.ariaLabel]) });
      render();
      const shown = panel();
      key('KeyR'); const reloaded = collect(); const once = collect();
      key('KeyM'); render(); const arranging = panel(); key('Digit2'); const moved = collect();
      key('KeyR'); key('KeyM'); key('Digit3'); const both = collect();
      key('KeyR'); const blocked = collect(true), afterBlocked = collect();
      $('reload-item').click(); const button = collect();
      $('ammo-reserves').children[0].click(); const dropped = collect(), afterDrop = collect();
      $('ammo-reserves').children[1].click(); const emptyFamily = collect();
      me = { ...me, reload: { slot: 0, instanceId: 'gun', until: 999 } }; render(); const reloading = panel();
      render({ view: 'replay' }); const replay = panel();
      me = { ...me, reserves: undefined, reload: undefined }; render(); const legacy = panel();
      hud.destroy(); input.destroy();
      return { shown, reloaded, once, arranging, moved, both, blocked, afterBlocked, button, dropped, afterDrop, emptyFamily, reloading, replay, legacy };
    }, { state: snapshot(game), arenaMap: game.map });
    assert.equal(result.shown.hidden, false);
    assert.equal(result.shown.reload, 'Reload · R');
    assert.equal(result.shown.arrange, 'Move / merge · M');
    assert.deepEqual(result.shown.chips.map(([text, disabled]) => [text, disabled]), [['Pistol rounds 36', false], ['Rifle rounds 0', true], ['Shells 4', false]]);
    assert.match(result.shown.chips[0][2], /36 in reserve\. Drop them/);
    assert.equal(result.reloaded.reload, true); assert.equal(result.reloaded.moveSlot, undefined);
    assert.equal(Object.hasOwn(result.once, 'reload'), false, 'R is a one-shot press');
    assert.equal(result.arranging.arrange, 'Choose destination · M cancels');
    assert.deepEqual(result.moved.moveSlot, { from: 0, to: 1 }); assert.equal(Object.hasOwn(result.moved, 'reload'), false, 'M never reloads');
    assert.equal(result.both.reload, true); assert.deepEqual(result.both.moveSlot, { from: 0, to: 2 }, 'R and M in one tick send both; the server orders them');
    assert.equal(Object.hasOwn(result.blocked, 'reload'), false); assert.equal(Object.hasOwn(result.afterBlocked, 'reload'), false, 'a blocked press is discarded');
    assert.equal(result.button.reload, true);
    assert.deepEqual(result.dropped.dropAmmo, { family: 'pistol', count: 36 }); assert.equal(result.afterDrop.dropAmmo, undefined);
    assert.equal(result.emptyFamily.dropAmmo, undefined, 'an empty reserve chip is disabled');
    assert.equal(result.reloading.reload, 'Reloading…');
    assert.equal(result.replay.hidden, true, 'replays show no live reload controls');
    assert.equal(result.legacy.hidden, true, 'content without reserves shows none');
  } finally { await page.close(); }
}
