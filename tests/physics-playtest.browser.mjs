import assert from 'node:assert/strict';
import { serveWithBrowser } from './helpers/browser.js';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';

const { server, base, browser } = await serveWithBrowser({ profileSummary: false,
  replayDir: 'test-results/physics-playtest-replays', devTools: 'all' });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}/dev/physics`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Tick 0'), undefined, { timeout: 5000 })
    .catch(async error => { throw new Error(`${error.message}: ${await page.locator('body').innerText()}\n${errors.join('\n')}`); });
  const initial = await page.locator('#status').textContent();
  assert.match(initial, /bodies/);
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => {
      const box = selector => {
        const { left, right, top, bottom, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      return { arena: box('#arena'), scene: box('#scene'), tuning: box('#tuning'),
        actions: ['#reset', '#step', '#play', '#skill', '#cast'].map(box),
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.ok(!layout.overflow, `${width} desktop has no horizontal overflow: ${JSON.stringify(layout)}`);
    assert.ok(layout.scene.right < layout.arena.left && layout.arena.right < layout.tuning.left,
      `${width} desktop keeps scene, arena, and tuning in separate columns: ${JSON.stringify(layout)}`);
    for (const [name, box] of [['arena', layout.arena], ...layout.actions.map((box, index) => [`action ${index}`, box])]) {
      assert.ok(box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= width + 1 && box.top >= 0 && box.bottom <= height + 1,
        `${name} is visible without scrolling at ${width}x${height}: ${JSON.stringify(layout)}`);
    }
    await page.screenshot({ path: `test-results/physics-playtest-desktop-${width}x${height}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const selector of ['#scene', '#actor', '#reset', '#step', '#play', '#tuning', '#export', '#recording', '#import']) {
    const control = page.locator(selector);
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.x + box.width <= 391,
      `${selector} remains horizontally reachable in the narrow layout: ${JSON.stringify(box)}`);
  }
  await page.screenshot({ path: 'test-results/physics-playtest-narrow-390x844.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('#arena').focus();
  await page.keyboard.down('KeyD');
  await page.getByRole('button', { name: 'Step tick' }).click();
  await page.keyboard.up('KeyD');
  await page.getByRole('button', { name: 'Queue impulse' }).click();
  await page.getByRole('button', { name: 'Step tick' }).click();
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const exportA = JSON.parse(await page.locator('#recording').inputValue());
  assert.equal(exportA.format, 'last-exit-physics-lab-1');
  assert.equal(exportA.content.id, 'content-physics-8');
  assert.equal(exportA.frames[0].bodies.filter(body => body.kind === 'actor').length, 4, 'A offers a four-actor crowd');
  assert.deepEqual(exportA.map.obstacles.map(obstacle => obstacle.id), ['doorway-top', 'doorway-bottom']);
  assert.equal(exportA.trace.length, 3);
  assert.equal(exportA.trace[0].input.x, 1);
  assert.deepEqual(exportA.trace[1], { kind: 'impulse', tick: 1, actorId: 'c0', value: { x: 300, y: 0 } });
  assert.equal(exportA.frames.length, 3);
  await page.locator('[data-tune="acceleration"]').fill('3000');
  await page.getByRole('button', { name: 'Start / Reset' }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Tick 0'));
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const tuned = JSON.parse(await page.locator('#recording').inputValue());
  assert.equal(tuned.content.actorPhysics.acceleration, 3000);
  assert.equal(tuned.trace.length, 0);
  await page.locator('#recording').fill(JSON.stringify(exportA));
  await page.getByRole('button', { name: 'Import and rerun' }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('retained frames match'));
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const imported = JSON.parse(await page.locator('#recording').inputValue());
  assert.deepEqual(imported.frames, exportA.frames);
  assert.deepEqual(imported.trace, exportA.trace);
  await page.locator('#arena').focus();
  await page.keyboard.down('KeyD');
  await page.evaluate(() => { for (let i = 0; i < 35; i++) document.getElementById('step').click(); });
  await page.keyboard.up('KeyD');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const contactRun = JSON.parse(await page.locator('#recording').inputValue());
  assert.ok(contactRun.contacts.some(frame => frame.length), 'real actor/crowd contact is retained');
  assert.equal(contactRun.forces.length, contactRun.frames.length, 'external-force samples align with retained frames');
  await page.locator('#scene').selectOption('B');
  await page.getByRole('button', { name: 'Start / Reset' }).click();
  await page.getByRole('button', { name: 'Export JSON' }).click();
  assert.ok(JSON.parse(await page.locator('#recording').inputValue()).frames[0].bodies.some(body => body.id === 'prop:crate'));
  await page.getByRole('button', { name: 'Cast ahead' }).click();
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const castRecord = JSON.parse(await page.locator('#recording').inputValue());
  const cast = castRecord.trace[0];
  assert.equal(cast.kind, 'cast');
  assert.equal(cast.result.tick, 0);
  assert.ok(cast.result.fraction > 0 && cast.result.fraction < 1, 'B cast stops at the actual solid prop');
  assert.equal(cast.result.radius, castRecord.content.actorPhysics.geometry.contestant.bodyRadius);
  await page.getByRole('button', { name: 'Import and rerun' }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('retained frames match'));
  await page.getByRole('button', { name: 'Export JSON' }).click();
  assert.deepEqual(JSON.parse(await page.locator('#recording').inputValue()).trace, castRecord.trace);
  const actor = castRecord.frames[0].players.find(player => player.id === castRecord.selected);
  assert.ok(actor, 'selected actor is present in the exported frame');
  const target = { x: actor.x + 80, y: actor.y + 120 };
  const expectedAim = Math.atan2(target.y - actor.y, target.x - actor.x);
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    const box = await page.locator('#arena').boundingBox();
    await page.mouse.move(box.x + target.x * box.width / 800, box.y + target.y * box.height / 800);
    await page.getByRole('button', { name: 'Cast ahead' }).click();
    await page.getByRole('button', { name: 'Export JSON' }).click();
    const record = JSON.parse(await page.locator('#recording').inputValue());
    const latestCast = record.trace.at(-1);
    assert.equal(latestCast.kind, 'cast');
    assert.ok(Math.abs(latestCast.aim - expectedAim) < 0.02,
      `pointer aim maps into world coordinates after resizing to ${width}x${height}: ${latestCast.aim} vs ${expectedAim}`);
  }
  await page.locator('#scene').selectOption('C');
  await page.getByRole('button', { name: 'Start / Reset' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#actor option')].some(option => option.textContent.toLowerCase().includes('hook')));
  const hookActors = await page.locator('#actor option').allTextContents();
  assert.ok(hookActors.some(name => name.toLowerCase().includes('hook')), JSON.stringify({ hookActors, status: await page.locator('#status').textContent() }));
  await page.locator('#actor').selectOption('g0');
  const hookArena = await page.locator('#arena').boundingBox();
  await page.mouse.move(hookArena.x + hookArena.width * 700 / 800, hookArena.y + hookArena.height * 400 / 800);
  await page.locator('#arena').focus();
  await page.keyboard.press('KeyQ');
  await page.evaluate(() => document.querySelector('#step').click());
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const hook = JSON.parse(await page.locator('#recording').inputValue());
  assert.equal(hook.trace[0].input.skill, true);
  assert.equal(hook.frames[1].hookFlights.length, 1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  assert.match((await download).suggestedFilename(), /^physics-C-449-1\.json$/);
  await page.evaluate(() => { for (let i = 0; i < 12; i++) document.getElementById('step').click(); });
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const pulling = JSON.parse(await page.locator('#recording').inputValue());
  assert.ok(pulling.frames.some(frame => frame.tethers?.length), 'hook attaches in C');
  assert.ok(pulling.forces.some(frame => frame.some(sample => Math.hypot(sample.force.x, sample.force.y) > 0.001)),
    'a real hook external force is retained');
  const cap = await page.evaluate(async () => {
    const { PhysicsLab, sceneConfig, MAX_TICKS } = await import('/dev/physics-lab-model.js');
    const limited = new PhysicsLab();
    try { await limited.start(sceneConfig('B')); limited.game.tick = MAX_TICKS;
      try { limited.tick(); return 'missed'; } catch (error) { return error.message; }
    } finally { limited.dispose(); }
  });
  assert.match(cap, /recording limit reached/);
  await page.locator('#scene').selectOption('A');
  for (const selector of ['#seed', '#scene', '[data-tune="acceleration"]', '#recording']) {
    await page.getByRole('button', { name: 'Start / Reset' }).click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Tick 0'));
    await page.locator(selector).focus();
    // A number field accepts "e" and a select moves on an arrow, so only the text area takes E and arrows.
    const typed = selector === '#recording' ? ['KeyD', 'ArrowRight', 'KeyQ', 'KeyE'] : ['KeyD', 'KeyQ'];
    for (const key of typed) await page.keyboard.down(key);
    await page.evaluate(() => document.querySelector('#step').click());
    for (const key of typed.toReversed()) await page.keyboard.up(key);
    await page.getByRole('button', { name: 'Export JSON' }).click();
    const record = JSON.parse(await page.locator('#recording').inputValue());
    assert.equal(record.trace.length, 1, `${selector} editing leaves one stepped input; status=${await page.locator('#status').textContent()}; seed=${await page.locator('#seed').inputValue()}`);
    assert.equal(record.trace[0].input.x, 0, `${selector} editing does not move the actor`);
    assert.equal(record.trace[0].input.skill, false, `${selector} editing does not use skill`);
    assert.equal(record.trace[0].input.interact, false, `${selector} editing does not interact`);
  }
  await page.getByRole('button', { name: 'Start / Reset' }).click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Tick 0'));
  await page.locator('#arena').focus();
  await page.keyboard.down('KeyD');
  await page.locator('#seed').focus();
  await page.evaluate(() => document.querySelector('#step').click());
  await page.keyboard.up('KeyD');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const focusRecord = JSON.parse(await page.locator('#recording').inputValue());
  assert.equal(focusRecord.trace[0].input.x, 0, 'focusing a form field clears held movement');
  for (const key of ['KeyE', 'KeyQ']) {
    await page.getByRole('button', { name: 'Start / Reset' }).click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Tick 0'));
    await page.locator('#arena').focus();
    await page.keyboard.down(key);
    await page.getByRole('button', { name: 'Step tick' }).click();
    for (let repeat = 0; repeat < 3; repeat++) await page.keyboard.down(key);
    await page.keyboard.up(key);
    await page.getByRole('button', { name: 'Step tick' }).click();
    await page.getByRole('button', { name: 'Export JSON' }).click();
    const record = JSON.parse(await page.locator('#recording').inputValue());
    assert.equal(record.trace.length, 2, `held ${key} adds no extra Step clicks after button focus`);
    assert.equal(record.frames.length, 3, `held ${key} advances exactly the stepped ticks`);
    assert.equal(record.trace[0].input.interact, key === 'KeyE', `${key} pressed on the arena interacts only for E`);
    assert.equal(record.trace[0].input.skill, key === 'KeyQ', `${key} pressed on the arena uses skill only for Q`);
    assert.equal(record.trace[1].input.interact || record.trace[1].input.skill, false, `${key} is a one-shot press like the live client, not held`);
  }
  await page.getByRole('button', { name: 'Start / Reset' }).click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Tick 0'));
  await page.locator('#arena').focus();
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowDown');
  await page.getByRole('button', { name: 'Step tick' }).click();
  await page.keyboard.up('ArrowRight');
  await page.keyboard.up('ArrowDown');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const arrows = JSON.parse(await page.locator('#recording').inputValue());
  assert.deepEqual([arrows.trace[0].input.x, arrows.trace[0].input.y], [1, 1], 'arrow keys move like WASD');
  const dial = await page.locator('#impulse-dial').boundingBox();
  const pick = async (dx, dy) => {
    await page.mouse.click(dial.x + dial.width / 2 + dx, dial.y + dial.height / 2 + dy);
    return [Number(await page.locator('#impulse-x').inputValue()), Number(await page.locator('#impulse-y').inputValue())];
  };
  const maxImpulse = Number(await page.locator('[data-tune="maxImpulse"]').inputValue());
  assert.deepEqual(await pick(0, 0), [0, 0], 'the dial centre is no impulse');
  assert.deepEqual(await pick(60, 0), [maxImpulse, 0], 'the dial rim at right is the full impulse along +x');
  assert.deepEqual(await pick(0, -60), [0, -maxImpulse], 'up on the dial is -y, as in the arena');
  const [cx, cy] = await pick(48, 48);
  assert.ok(Math.hypot(cx, cy) <= maxImpulse + 0.5 && cx > 0 && cy > 0, `a pick outside the rim clamps to it: ${cx}, ${cy}`);
  await pick(0, 60);
  await page.locator('#arena').focus();
  await page.keyboard.press('KeyI');
  await page.getByRole('button', { name: 'Step tick' }).click();
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const keyed = JSON.parse(await page.locator('#recording').inputValue());
  const queued = keyed.trace.find(action => action.kind === 'impulse');
  assert.deepEqual(queued?.value, { x: 0, y: maxImpulse }, 'I queues the dial value for the selected actor');
  assert.deepEqual([queued.tick, keyed.trace.at(-1).tick], [1, 2], 'the key-queued impulse lands before the next stepped tick');
  await page.locator('#impulse-y').fill('-150');
  await page.locator('#arena').focus();
  await page.keyboard.press('KeyI');
  assert.match(await page.locator('#status').textContent(), /Impulse \(0, -150\) queued/, 'typed fields remain the exact form');
  await page.getByRole('button', { name: 'Start / Reset' }).click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Tick 0'));
  await page.getByRole('button', { name: 'Step tick' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const buttonKeyboardRecord = JSON.parse(await page.locator('#recording').inputValue());
  assert.equal(buttonKeyboardRecord.trace.length, 2, 'fresh Enter and Space activate a focused Step button');
  assert.equal(buttonKeyboardRecord.frames.length, 3, 'fresh keyboard button activation advances two ticks');
  await page.getByRole('button', { name: 'Start / Reset' }).click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Tick 0'));
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => /Tick [2-9]\b/.test(document.querySelector('#status')?.textContent), undefined, { timeout: 3000 });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await page.locator('#status').textContent();
  await page.waitForTimeout(120);
  assert.equal(await page.locator('#status').textContent(), paused, 'Pause stops fixed ticks');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test-results/physics-playtest.png', fullPage: true });
  console.log(JSON.stringify({ passed: true, checks: ['desktop and narrow layout', 'pointer aim after resize', 'form input isolation', 'held shortcut repeat and fresh button activation', 'play/pause', 'local start and movement', 'reset pins tuning', 'export/import exact rerun', 'A/B/C scenes', 'no console errors'] }));
  await page.close();
} finally { await browser.close(); await server.close(); }

const disabled = await createArenaServer({ profileSummary: false, devTools: 'none',
  replayDir: 'test-results/physics-playtest-disabled-replays' });
try {
  const disabledBase = await listen(disabled);
  for (const path of ['/dev/physics', '/dev/physics-lab.html', '/dev/physics-lab.js', '/dev/physics-lab-model.js']) {
    assert.equal((await fetch(`${disabledBase}${path}`)).status, 404, `${path} stays hidden without dev tools`);
  }
} finally { await disabled.close(); }
