import { PhysicsLab, sceneConfig } from './physics-lab-model.js';

const lab = new PhysicsLab();
const byId = id => document.getElementById(id);
const canvas = byId('arena'), ctx = canvas.getContext('2d');
const keys = new Set();
let playing = null, aim = 0, skillPending = false;
const status = message => { byId('status').textContent = message; };
const button = (id, action) => byId(id).addEventListener('click', () => Promise.resolve(action()).catch(error => status(error.message)));

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
  for (const body of frame.bodies ?? []) {
    if (body.kind === 'actor') {
      const player = frame.players.find(p => p.id === body.actorId);
      const geometry = lab.config.content.actorPhysics.geometry[player?.role ?? 'contestant'];
      shape({ ...body, shape: { kind: 'circle', radius: geometry.hurtRadius } }, '#ff80bb', body.sleeping);
      shape({ ...body, shape: { kind: 'circle', radius: geometry.headRadius } }, '#5be1d8', body.sleeping);
      shape(body, '#ffbc54', body.sleeping);
      ctx.fillStyle = body.actorId === lab.selected ? '#fff' : '#d1e3d8';
      ctx.fillText(body.actorId, body.x + 24, body.y - 20);
    } else shape(body, '#a6b5ff', body.sleeping);
  }
  for (const contact of lab.contacts.at(-1) ?? []) {
    const { x, y } = contact.point, nx = contact.normal.x, ny = contact.normal.y;
    ctx.strokeStyle = '#ff6b60'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + nx * 22, y + ny * 22); ctx.stroke();
    ctx.fillStyle = '#ff6b60'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
  for (const sample of lab.forces.at(-1) ?? []) {
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
    ctx.fillStyle = '#ff9d53'; ctx.fillText('static/solid-prop diagnostic cast', point.x + 10, point.y - radius - 8);
    ctx.restore();
  }
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
}

function input() {
  const axis = (positive, negative) => Number(keys.has(positive)) - Number(keys.has(negative));
  const value = { x: axis('KeyD', 'KeyA'), y: axis('KeyS', 'KeyW'), aim,
    skill: skillPending, interact: keys.has('Enter') };
  skillPending = false; return value;
}
function tick() { if (lab.game) { lab.tick(input()); refresh(); } }
function stop() { if (playing) clearInterval(playing); playing = null; byId('play').textContent = 'Play'; }
async function reset() {
  stop(); keys.clear(); skillPending = false;
  const tuning = Object.fromEntries([...document.querySelectorAll('[data-tune]')].map(field => [field.dataset.tune, Number(field.value)]));
  const config = sceneConfig(byId('scene').value, Number(byId('seed').value), tuning);
  await lab.start(config); refresh();
}
const defaults = sceneConfig().content.actorPhysics;
for (const field of document.querySelectorAll('[data-tune]')) {
  field.value = field.dataset.tune.endsWith('BodyRadius')
    ? defaults.geometry[field.dataset.tune.startsWith('contestant') ? 'contestant' : 'gladiator'].bodyRadius
    : defaults[field.dataset.tune];
  field.addEventListener('change', () => status('Tuning changed. Reset to apply it to a new pinned match.'));
}
byId('actor').addEventListener('change', event => { lab.selected = event.target.value; refresh(); });
button('reset', reset);
button('step', tick);
button('skill', () => { skillPending = true; status('Skill queued for the next tick.'); });
button('cast', () => { const result = lab.cast(aim); refresh();
  status(`Static/solid-prop diagnostic cast at tick ${result.tick}: ${result.fraction === null ? 'clear' : `blocked at ${(result.fraction * 200).toFixed(1)} of 200 world units`}.`);
});
button('impulse', () => { lab.impulse({ x: Number(byId('impulse-x').value), y: Number(byId('impulse-y').value) }); refresh(); });
button('play', () => { if (playing) stop(); else {
  playing = setInterval(() => { try { tick(); } catch (error) { stop(); status(error.message); } }, 50);
  byId('play').textContent = 'Pause';
} });
button('export', () => { byId('recording').value = JSON.stringify(lab.export(), null, 2); status('Pinned configuration, ordered trace, and retained frames exported.'); });
button('download', () => {
  const data = JSON.stringify(lab.export(), null, 2), url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `physics-${lab.config.scene}-${lab.config.seed}-${lab.game.tick}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
button('import', async () => { stop(); await lab.import(JSON.parse(byId('recording').value)); refresh(); status(`Imported and reran ${lab.trace.length} ticks; retained frames match.`); });
window.addEventListener('keydown', event => {
  // A key pressed on the arena stays a simulation key through button focus.
  // Suppress native button activation on repeats without blocking fresh presses.
  if (keys.has(event.code)) event.preventDefault();
  if (event.target !== canvas) return;
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Enter'].includes(event.code)) {
    if (event.code === 'Space' && !keys.has('Space')) skillPending = true;
    keys.add(event.code); event.preventDefault();
  }
});
window.addEventListener('keyup', event => {
  if (keys.has(event.code)) event.preventDefault();
  keys.delete(event.code);
});
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
