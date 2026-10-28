import { JELLY, PhysicsLab, sceneConfig, TICK_HZ, TICK_MS } from './physics-lab-model.js';
import { SQUISH } from './squish-shell.js';

const lab = new PhysicsLab();
const byId = id => document.getElementById(id);
const canvas = byId('arena'), ctx = canvas.getContext('2d');
const keys = new Set();
let playing = null, aim = 0, skillPending = false, interactPending = false;
// The live client's bindings (input-controller.js): WASD or arrows move, Q is the skill, E interacts.
// Both are one-shot presses. Space is the live replay toggle and has no meaning here.
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
// I queues the impulse dial's current value; the live game has no such key, so it takes one the live client leaves free.
const ARENA_KEYS = [...MOVE_KEYS, 'KeyQ', 'KeyE', 'KeyI', 'Space'];
const status = message => { byId('status').textContent = message; };
const button = (id, action) => byId(id).addEventListener('click', () => Promise.resolve(action()).catch(error => status(error.message)));

const TRAIL_TICKS = 40;
/** The selected actor's body at each of the last TRAIL_TICKS + 1 retained frames, oldest first. */
function trail() {
  const id = `actor:${lab.selected}`, points = [];
  for (const past of lab.frames.slice(-(TRAIL_TICKS + 1))) {
    const body = past.bodies?.find(entry => entry.id === id);
    if (body) points.push(body);
  }
  return points;
}

function shape(body, color, dashed = false) {
  ctx.save(); ctx.translate(body.x, body.y); ctx.rotate(body.angle || 0);
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.beginPath();
  if (body.shape.kind === 'circle') ctx.arc(0, 0, body.shape.radius, 0, Math.PI * 2);
  else if (body.shape.kind === 'box') ctx.rect(-body.shape.hx, -body.shape.hy, 2 * body.shape.hx, 2 * body.shape.hy);
  else {
    const points = body.shape.vertices;
    if (points.length) { ctx.moveTo(points[0].x, points[0].y); for (const p of points.slice(1)) ctx.lineTo(p.x, p.y); ctx.closePath(); }
  }
  ctx.stroke(); ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, 800, 800);
  ctx.fillStyle = '#263b37'; ctx.fillRect(0, 0, 800, 800);
  ctx.strokeStyle = '#526c64'; ctx.lineWidth = 1;
  for (let n = 100; n < 800; n += 100) { ctx.beginPath(); ctx.moveTo(n, 0); ctx.lineTo(n, 800); ctx.moveTo(0, n); ctx.lineTo(800, n); ctx.stroke(); }
  const frame = lab.frame(); if (!frame) return;
  ctx.fillStyle = '#667773';
  for (const obstacle of lab.config.map.obstacles) ctx.fillRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h);
  const bodies = new Map((frame.bodies ?? []).map(body => [body.id, body]));
  const anchors = new Map((frame.physics?.world?.constraints ?? []).map(constraint => [constraint.id, constraint]));
  for (const tether of frame.tethers ?? []) {
    const a = bodies.get(tether.a), b = bodies.get(tether.b);
    if (!a || !b) continue;
    const descriptor = anchors.get(tether.id);
    const point = (body, local) => ({ x: body.x + (local?.x ?? 0) * Math.cos(body.angle) - (local?.y ?? 0) * Math.sin(body.angle),
      y: body.y + (local?.x ?? 0) * Math.sin(body.angle) + (local?.y ?? 0) * Math.cos(body.angle) });
    const start = point(a, descriptor?.anchorA), end = point(b, descriptor?.anchorB);
    ctx.strokeStyle = '#e3ea83'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    for (const p of [start, end]) { ctx.fillStyle = '#e3ea83'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); }
  }
  for (const flight of frame.hookFlights ?? []) {
    const a = bodies.get(flight.a); if (!a) continue;
    const previous = lab.frames.at(-2)?.hookFlights?.find(item => item.id === flight.id);
    if (previous) { ctx.strokeStyle = '#f5f5ee'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(previous.x, previous.y); ctx.lineTo(flight.x, flight.y); ctx.stroke(); }
    ctx.fillStyle = '#e9f5d4'; ctx.beginPath(); ctx.arc(flight.x, flight.y, 4, 0, Math.PI * 2); ctx.fill();
  }
  if (byId('squish-show').checked) for (const shell of lab.shells.values()) {
    ctx.beginPath();
    shell.radii.forEach((radius, index) => {
      const angle = index * 2 * Math.PI / shell.radii.length, x = shell.x + radius * Math.cos(angle), y = shell.y + radius * Math.sin(angle);
      if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = shell.crushed ? 'rgba(255, 107, 96, .28)' : 'rgba(123, 240, 192, .14)';
    ctx.strokeStyle = shell.crushed ? '#ff6b60' : '#7bf0c0'; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
    if (shell.crushed) { ctx.fillStyle = '#ff6b60'; ctx.fillText('CRUSHED', shell.x - 20, shell.y + shell.reach + 12); }
  }
  // The jelly is one object: a filled ring through its nodes, over the individual bodies drawn below.
  const ring = Array.from({ length: JELLY.nodes }, (_, i) => bodies.get(`jelly:n${i}`));
  if (ring.every(Boolean)) {
    ctx.beginPath(); ring.forEach((node, i) => { if (i) ctx.lineTo(node.x, node.y); else ctx.moveTo(node.x, node.y); }); ctx.closePath();
    ctx.fillStyle = 'rgba(123, 240, 192, .22)'; ctx.strokeStyle = '#7bf0c0'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
  }
  const path = trail();
  path.forEach((point, index) => {
    ctx.fillStyle = `rgba(255, 252, 230, ${0.15 + 0.7 * index / Math.max(1, path.length - 1)})`;
    ctx.beginPath(); ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2); ctx.fill();
  });
  for (const body of frame.bodies ?? []) {
    if (body.kind === 'actor') {
      const player = frame.players.find(p => p.id === body.actorId);
      const geometry = lab.config.content.actorPhysics.geometry[player?.role ?? 'contestant'];
      shape({ ...body, shape: { kind: 'circle', radius: geometry.hurtRadius } }, '#ff80bb', body.sleeping);
      shape({ ...body, shape: { kind: 'circle', radius: geometry.headRadius } }, '#5be1d8', body.sleeping);
      shape(body, '#ffbc54', body.sleeping);
      ctx.fillStyle = body.actorId === lab.selected ? '#fff' : '#d1e3d8';
      const cooling = player?.kit && player.cooldown > 0 ? ` · skill ${(player.cooldown / TICK_HZ).toFixed(1)} s` : '';
      ctx.fillText(`${body.actorId}${cooling}`, body.x + 24, body.y - 20);
    } else shape(body, '#a6b5ff', body.sleeping);
  }
  // The jelly's springs and node contacts would bury it in labels; its ring is the readout, so skip its own bodies.
  const jelly = id => id.startsWith('jelly:');
  for (const contact of (lab.contacts.at(-1) ?? []).filter(item => !jelly(item.a) && !jelly(item.b))) {
    const { x, y } = contact.point, nx = contact.normal.x, ny = contact.normal.y;
    ctx.strokeStyle = '#ff6b60'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + nx * 22, y + ny * 22); ctx.stroke();
    ctx.fillStyle = '#ff6b60'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
  for (const sample of (lab.forces.at(-1) ?? []).filter(item => !jelly(item.id))) {
    const magnitude = Math.hypot(sample.force.x, sample.force.y);
    if (magnitude < 0.001) continue;
    const length = Math.min(80, magnitude * 0.01), dx = sample.force.x / magnitude * length, dy = sample.force.y / magnitude * length;
    ctx.strokeStyle = '#d59bff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sample.point.x, sample.point.y);
    ctx.lineTo(sample.point.x + dx, sample.point.y + dy); ctx.stroke();
    ctx.fillStyle = '#d59bff'; ctx.fillText('external force', sample.point.x + dx + 4, sample.point.y + dy);
  }
  // These are pending commands and motor targets from the captured state, not measured solver forces.
  for (const body of frame.physics?.world?.bodies ?? []) {
    if (!body.motor || body.spec.kind !== 'actor') continue;
    const p = body.transform, m = body.motor;
    ctx.strokeStyle = '#8dc8ff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + m.x * 0.08, p.y + m.y * 0.08); ctx.stroke();
  }
  if (lab.lastImpulse) {
    const body = bodies.get(`actor:${lab.lastImpulse.actorId}`);
    if (body) {
      ctx.strokeStyle = '#9bf09a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(body.x, body.y);
      ctx.lineTo(body.x + lab.lastImpulse.value.x * 0.12, body.y + lab.lastImpulse.value.y * 0.12); ctx.stroke();
      ctx.fillStyle = '#9bf09a'; ctx.fillText('requested impulse', body.x + 12, body.y + 38);
    }
  }
  if (lab.lastCast) {
    const { from, to, point, radius, fraction } = lab.lastCast;
    ctx.save(); ctx.strokeStyle = '#ff9d53'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(point.x, point.y); ctx.stroke();
    if (fraction !== null) { ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = '#ff9d53'; ctx.fillText(fraction === null ? 'cast ahead: clear' : 'cast ahead: stops here', point.x + 10, point.y - radius - 8);
    ctx.restore();
  }
}

/** Speed comes from retained positions, so a fast kick and its recovery show without any engine accessor. */
function readout(frame) {
  const id = lab.selected, path = trail(), player = frame.players.find(p => p.id === id);
  const speeds = path.slice(1).map((point, index) => Math.hypot(point.x - path[index].x, point.y - path[index].y) * TICK_HZ);
  const motor = frame.physics?.world?.bodies?.find(body => body.spec.id === `actor:${id}`)?.motor;
  const skill = !player?.kit ? '' : player.cooldown > 0 ? ` · skill cooldown ${(player.cooldown / TICK_HZ).toFixed(1)} s` : ' · skill ready';
  const shell = lab.shells.get(id), squish = shell ? ` · squish ${Math.round(shell.squeeze * 100)}%${shell.crushed ? ' CRUSHED' : ''}` : '';
  return `${id}: speed ${Math.round(speeds.at(-1) ?? 0)} u/s · target ${Math.round(motor ? Math.hypot(motor.x, motor.y) : 0)} u/s`
    + ` · peak ${Math.round(Math.max(0, ...speeds))} u/s in the last ${TRAIL_TICKS / TICK_HZ} s${skill}${squish}`;
}

function refresh() {
  const frame = lab.frame(); draw();
  if (!frame) return;
  const actor = byId('actor');
  actor.replaceChildren(...lab.game.players.map(player => {
    const option = document.createElement('option'); option.value = player.id;
    option.textContent = `${player.id} · ${player.role}${player.kit ? ` · ${player.kit}` : ''}`; return option;
  }));
  actor.value = lab.selected;
  const external = lab.forces.at(-1)?.filter(sample => Math.hypot(sample.force.x, sample.force.y) >= 0.001).length ?? 0;
  status(`Tick ${frame.tick} · ${frame.bodies?.length ?? 0} bodies · ${lab.contacts.at(-1)?.length ?? 0} final-substep contacts · ${external} external-force samples · ${frame.tethers?.length ?? 0} tethers`);
  byId('readout').textContent = readout(frame);
  byId('events').textContent = lab.squishEvents.slice(-4).map(event => `tick ${event.tick}: ${event.actorId} ${event.type}`).join(' · ');
}

function input() {
  const held = codes => codes.some(code => keys.has(code));
  const axis = (positive, negative) => Number(held(positive)) - Number(held(negative));
  const value = { x: axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']), y: axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']), aim,
    skill: skillPending, interact: interactPending };
  skillPending = false; interactPending = false; return value;
}
function tick() { if (lab.game) { lab.tick(input()); refresh(); } }
function stop() { if (playing) clearInterval(playing); playing = null; byId('play').textContent = 'Play'; }
async function reset() {
  stop(); keys.clear(); skillPending = false; interactPending = false;
  const tuning = Object.fromEntries([...document.querySelectorAll('[data-tune]')].map(field => [field.dataset.tune, Number(field.value)]));
  const config = sceneConfig(byId('scene').value, Number(byId('seed').value), tuning);
  await lab.start(config); refresh();
}
const base = sceneConfig().content, defaults = base.actorPhysics;
for (const field of document.querySelectorAll('[data-tune]')) {
  field.value = field.dataset.tune === 'hookCooldown' ? base.hook.cooldownTicks
    : field.dataset.tune.endsWith('BodyRadius')
    ? defaults.geometry[field.dataset.tune.startsWith('contestant') ? 'contestant' : 'gladiator'].bodyRadius
    : defaults[field.dataset.tune];
  field.addEventListener('change', () => status('Tuning changed. Reset to apply it to a new pinned match.'));
}
byId('actor').addEventListener('change', event => { lab.selected = event.target.value; refresh(); });
button('reset', reset);
button('step', tick);
button('skill', () => { skillPending = true; status('Skill queued for the next tick.'); });
button('cast', () => { const result = lab.cast(aim); refresh();
  status(`Cast ahead from ${result.actorId} along your aim: ${result.fraction === null
    ? 'nothing solid within 200 units'
    : `a wall or crate would stop a body ${(result.fraction * 200).toFixed(1)} units out of 200`}. A look-ahead only; nothing moved.`);
});
function queueImpulse() {
  const value = impulseValue(); lab.impulse(value); refresh();
  status(`Impulse (${value.x}, ${value.y}) queued for ${lab.selected}; it lands on the next tick.`);
}
button('impulse', queueImpulse);

// The dial sets the same two numbers the fields hold, so the fields stay the exact, typeable form.
const dial = byId('impulse-dial'), dialCtx = dial.getContext('2d'), DIAL = 140, DIAL_RADIUS = 60;
const impulseValue = () => ({ x: Number(byId('impulse-x').value) || 0, y: Number(byId('impulse-y').value) || 0 });
const maxImpulse = () => Number(document.querySelector('[data-tune="maxImpulse"]').value) || 300;
function drawDial() {
  const { x, y } = impulseValue(), full = maxImpulse(), c = DIAL / 2, over = Math.hypot(x, y) > full + 0.5;
  dialCtx.clearRect(0, 0, DIAL, DIAL); dialCtx.fillStyle = '#0e191a'; dialCtx.fillRect(0, 0, DIAL, DIAL);
  dialCtx.strokeStyle = '#49635e'; dialCtx.lineWidth = 1;
  for (const r of [DIAL_RADIUS, DIAL_RADIUS / 2]) { dialCtx.beginPath(); dialCtx.arc(c, c, r, 0, Math.PI * 2); dialCtx.stroke(); }
  dialCtx.beginPath(); dialCtx.moveTo(c - DIAL_RADIUS, c); dialCtx.lineTo(c + DIAL_RADIUS, c);
  dialCtx.moveTo(c, c - DIAL_RADIUS); dialCtx.lineTo(c, c + DIAL_RADIUS); dialCtx.stroke();
  const scale = Math.min(1, full / Math.max(Math.hypot(x, y), 1e-9)) * DIAL_RADIUS / full, tip = { x: c + x * scale, y: c + y * scale };
  dialCtx.strokeStyle = dialCtx.fillStyle = over ? '#ff6b60' : '#9bf09a'; dialCtx.lineWidth = 3;
  dialCtx.beginPath(); dialCtx.moveTo(c, c); dialCtx.lineTo(tip.x, tip.y); dialCtx.stroke();
  dialCtx.beginPath(); dialCtx.arc(tip.x, tip.y, 5, 0, Math.PI * 2); dialCtx.fill();
}
// The squish shell reads the world and writes nothing, so its controls apply live and are never recorded.
byId('squish-thickness').value = SQUISH.thickness; byId('squish-hold').value = SQUISH.holdTicks;
function applySquish() {
  lab.setSquishTuning({ thickness: Number(byId('squish-thickness').value), holdTicks: Number(byId('squish-hold').value) });
  if (lab.game) refresh();
}
for (const id of ['squish-show', 'squish-thickness', 'squish-hold']) byId(id).addEventListener('input', applySquish);

function setImpulseFromDial(event) {
  const rect = dial.getBoundingClientRect(), k = DIAL / rect.width;
  let dx = (event.clientX - rect.left) * k - DIAL / 2, dy = (event.clientY - rect.top) * k - DIAL / 2;
  const length = Math.hypot(dx, dy);
  if (length > DIAL_RADIUS) { dx *= DIAL_RADIUS / length; dy *= DIAL_RADIUS / length; }
  byId('impulse-x').value = Math.round(dx / DIAL_RADIUS * maxImpulse());
  byId('impulse-y').value = Math.round(dy / DIAL_RADIUS * maxImpulse());
  drawDial();
}
dial.addEventListener('pointerdown', event => { dial.setPointerCapture(event.pointerId); setImpulseFromDial(event); });
dial.addEventListener('pointermove', event => { if (dial.hasPointerCapture(event.pointerId)) setImpulseFromDial(event); });
for (const field of [byId('impulse-x'), byId('impulse-y'), document.querySelector('[data-tune="maxImpulse"]')]) field.addEventListener('input', drawDial);
drawDial();
// A slower speed stretches the wall-clock gap between the same fixed ticks; it never changes a tick or its substeps.
function play() {
  playing = setInterval(() => { try { tick(); } catch (error) { stop(); status(error.message); } }, TICK_MS / Number(byId('speed').value));
  byId('play').textContent = 'Pause';
}
button('play', () => { if (playing) stop(); else play(); });
byId('speed').addEventListener('change', () => { if (playing) { stop(); play(); } });
button('export', () => { byId('recording').value = JSON.stringify(lab.export(), null, 2); status('Pinned configuration, ordered trace, and retained frames exported.'); });
button('download', () => {
  const data = JSON.stringify(lab.export(), null, 2), url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `physics-${lab.config.scene}-${lab.config.seed}-${lab.game.tick}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
button('import', async () => { stop(); await lab.import(JSON.parse(byId('recording').value)); refresh(); status(`Imported and reran ${lab.trace.length} ticks; retained frames match.`); });
window.addEventListener('keydown', event => {
  // Only keys pressed on the arena act, so editing a field or operating a button never moves anyone.
  // Enter and Space belong to buttons again; Space is swallowed on the arena only to stop the page scrolling.
  if (event.target !== canvas || !ARENA_KEYS.includes(event.code)) return;
  event.preventDefault();
  if (event.repeat) return;
  if (event.code === 'KeyQ') skillPending = true;
  else if (event.code === 'KeyE') interactPending = true;
  else if (event.code === 'KeyI') { try { queueImpulse(); } catch (error) { status(error.message); } }
  else if (MOVE_KEYS.includes(event.code)) keys.add(event.code);
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());
canvas.addEventListener('blur', event => {
  // Keep held movement available while clicking Step; editable fields stop it.
  if (!(event.relatedTarget instanceof HTMLButtonElement) || !event.relatedTarget.closest('main')) keys.clear();
});
document.addEventListener('focusin', event => {
  if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select')) keys.clear();
});
canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }));
canvas.addEventListener('pointermove', event => {
  const rect = canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * 800 / rect.width, y = (event.clientY - rect.top) * 800 / rect.height;
  const selected = lab.frame()?.players.find(p => p.id === lab.selected);
  if (selected) aim = Math.atan2(y - selected.y, x - selected.x);
});
window.addEventListener('pagehide', () => { stop(); lab.dispose(); });
reset().catch(error => status(error.message));
