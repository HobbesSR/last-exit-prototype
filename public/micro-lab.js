import { generateMicroRegion, validateMicroRegion } from '/shared/map/micro/index.ts';
import { regionCollisionMap } from '/shared/map/micro/adapter.ts';
import { microExample } from '/shared/map/micro/examples.ts';
import { canOccupy, moveBody } from '/shared/movement.ts';
import { microMetrics } from '/shared/map/micro/metrics.ts';
import { createRegionMask, elementShapes, spreadPoints } from '/shared/map/micro/sdk.ts';
import { outline, transform } from '/shared/shape.ts';

const $ = id => document.getElementById(id);
const canvas = $('preview'), ctx = canvas.getContext('2d');
canvas.tabIndex = 0;
canvas.addEventListener('pointerdown', () => canvas.focus());
const origin = { x: 12000, y: 6000 };
let result = null, collision = null, avatar = null, keys = new Set(), scale = 1, offset = { x: 0, y: 0 };

function setControlEnabled(control, enabled, note) {
  const label = $(control);
  const input = label.querySelector('input, select');
  input.disabled = !enabled;
  label.title = note;
  label.classList.toggle('not-applicable', !enabled);
}
function updateApplicableControls() {
  const builder = $('builder').value, entry = builder === 'entry', ruins = builder === 'ruins';
  setControlEnabled('entry-count-control', entry, entry ? 'Applies to contestant entry layouts.' : 'Applies only to Contestant entry.');
  setControlEnabled('density-control', !entry, entry ? 'Entry layouts use spacing instead of architecture density.' : 'Applies to architecture builders.');
  setControlEnabled('room-cells-control', !entry, entry ? 'Entry layouts do not place rooms.' : 'Applies to architecture builders.');
  setControlEnabled('decay-control', ruins, ruins ? 'Collapsed rubble increases as decay rises.' : 'Applies only to Ruins.');
  setControlEnabled('loot-budget-control', !entry, entry ? 'Entry layouts do not place loot.' : 'Applies to architecture builders.');
  setControlEnabled('loot-tier-control', !entry, entry ? 'Entry layouts do not place loot.' : 'Applies to architecture builders.');
}

function specFromControls() {
  const shape = $('region-shape').value === 'rect' ? 'rectangle' : $('region-shape').value;
  const example = microExample($('builder').value, Number($('seed').value), shape);
  const ports = [...example.ports];
  if ($('north-port').checked) ports.push({ id: 'contestant-north', side: 'N', start: { x: 10, y: 0 }, length: 2, required: 'contestant', allowed: 'contestant' });
  return { ...example, ports, bodyProfile: $('body-profile').value,
    ...(example.builder === 'entry' ? { entry: { count: Number($('entry-count').value) } } : {}),
    parameters: { density: Number($('density').value), roomCells: Number($('room-cells').value), decay: Number($('decay').value) },
    loot: { budget: example.builder === 'entry' ? 0 : Number($('loot-budget').value), tier: Number($('loot-tier').value) } };
}
function local(point) { return { x: point.x - origin.x, y: point.y - origin.y }; }
function resetAvatar() {
  if (!result) return;
  const radius = microMetrics(result.spec).body[$('role').value === 'gladiator' ? 'hunter' : 'contestant'];
  const port = result.ports.find(port => port.required === 'hunter') || result.ports.find(port => port.required === 'contestant' && $('role').value === 'contestant');
  const point = port?.inside || spreadPoints(createRegionMask(result.spec), { count: 1, radius, blockers: result.elements.flatMap(e => elementShapes(e, true)) }).points[0];
  if (!point) { avatar = null; return; }
  avatar = { role: $('role').value, x: origin.x + point.x, y: origin.y + point.y };
}
function generate() {
  clearTimeout(generationTimer);
  try {
    result = generateMicroRegion(specFromControls());
    collision = regionCollisionMap(result, origin);
    resetAvatar(); $('download').disabled = false; $('reset').disabled = false;
    $('status').textContent = `Generated ${result.manifest.builder} region from seed ${result.spec.seed}.`;
    diagnostics(); draw();
  } catch (error) { result = collision = avatar = null; $('download').disabled = true; $('reset').disabled = true; $('status').textContent = `Could not generate this region: ${error.message}`; $('diagnostics').replaceChildren(); $('ports').replaceChildren(); draw(); }
}
function diagnostics() {
  const metrics = microMetrics(result.spec), unit = result.spec.cellSize;
  const tuning = result.spec.builder === 'ruins' ? ` Ruin decay ${(result.spec.parameters?.decay ?? .35).toFixed(2)} changes intact spans into collapsed rubble.` : result.spec.builder === 'entry' ? ' Seed selects a deterministic equally-spaced entry layout.' : ' Ruin decay applies only to the Ruins builder.';
  $('scale-note').textContent = `Diameters: contestant ${2 * metrics.body.contestant / unit} cells; hunter ${2 * metrics.body.hunter / unit} cells. Doorway ${metrics.doorway / unit} cells; squeeze ${metrics.squeeze / unit} cells.${tuning}`;
  const values = [['Cells', result.manifest.cells], ['Structures', result.manifest.structures], ['Obstacles', result.manifest.obstacles], ['Gates', result.manifest.gates], ['Loot', result.manifest.loot], ['Placement refusals', `${result.manifest.rejected} / ${result.manifest.attempted}`]];
  if (result.entry) values.push(['Entry positions', `${result.entry.points.length} / ${result.entry.requested}`], ['Unplaced contestants', result.entry.shortfall], ['Minimum spacing', result.entry.minimumSpacing === null ? '—' : `${(result.entry.minimumSpacing / unit).toFixed(2)} cells`]);
  $('diagnostics').replaceChildren(...values.flatMap(([name, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; return [dt, dd]; }));
  $('ports').replaceChildren(...result.ports.map(port => { const li = document.createElement('li'); li.textContent = `${port.id}: ${port.side}, ${port.length} cells (${port.required})`; return li; }));
}
function project(point) { return { x: offset.x + point.x * scale, y: offset.y + point.y * scale }; }
function path(points) { ctx.beginPath(); points.forEach((p, i) => { const q = project(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); }
function draw() {
  const { width, height } = canvas; ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#0b1515'; ctx.fillRect(0, 0, width, height);
  if (!result) return;
  const cellSize = result.spec.cellSize;
  const bounds = result.bounds, pad = 44; scale = Math.min((width - pad * 2) / bounds.w, (height - pad * 2) / bounds.h); offset = { x: (width - bounds.w * scale) / 2 - bounds.x * scale, y: (height - bounds.h * scale) / 2 - bounds.y * scale };
  ctx.fillStyle = '#263c37'; for (const cell of result.spec.cells) { const p = project({ x: cell.x * cellSize, y: cell.y * cellSize }); ctx.fillRect(p.x + .5, p.y + .5, cellSize * scale - 1, cellSize * scale - 1); }
  if ($('routes').checked) for (const route of result.routes) { ctx.strokeStyle = route.role === 'hunter' ? '#e9ad59' : '#72d8d2'; ctx.lineWidth = Math.max(2, route.radius * scale / 4); ctx.beginPath(); route.points.forEach((p, i) => { const q = project(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke(); }
  for (const element of result.elements) for (const part of element.template.parts) if (part.part === 'obstacle') { const points = outline(transform(part.shape, element.x, element.y)); path(points); ctx.fillStyle = part.kind === 'tree' ? '#567d4e' : '#84918c'; ctx.fill(); ctx.strokeStyle = '#c4d3bd'; ctx.lineWidth = 1; ctx.stroke(); }
  if ($('roofs').checked) for (const element of result.elements) if (element.template.encloses) { const p = project({ x: element.x, y: element.y }); ctx.fillStyle = '#3d2c3bb8'; ctx.fillRect(p.x, p.y, element.template.w * scale, element.template.h * scale); }
  for (const gate of collision.gates) { const p = project(local(gate)); ctx.fillStyle = gate.open ? '#6abf87' : '#d66955'; ctx.fillRect(p.x - gate.w * scale / 2, p.y - gate.h * scale / 2, gate.w * scale, gate.h * scale); }
  for (const loot of result.loot) { const p = project(loot); ctx.fillStyle = '#f2ca55'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff1ae'; ctx.lineWidth = 1; ctx.stroke(); }
  for (const port of result.ports) { const p = project(port.centre); ctx.fillStyle = '#e9f7c4'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); }
  for (const [i, point] of (result.entry?.points || []).entries()) { const p = project(point); ctx.beginPath(); ctx.arc(p.x, p.y, microMetrics(result.spec).body.contestant * scale, 0, Math.PI * 2); ctx.fillStyle = '#a78bd866'; ctx.fill(); ctx.strokeStyle = '#ccafff'; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), p.x, p.y); }
  if (avatar) { const p = project(local(avatar)); ctx.fillStyle = avatar.role === 'gladiator' ? '#ed7770' : '#8ee1e0'; ctx.beginPath(); ctx.arc(p.x, p.y, walkerRadius() * scale, 0, Math.PI * 2); ctx.fill(); }
}
function walkerRadius() { return microMetrics(result.spec).body[avatar.role === 'gladiator' ? 'hunter' : 'contestant']; }
function toggleNearbyGate() {
  if (!avatar || !collision) return;
  const gate = collision.gates.filter(g => Math.hypot(g.x - avatar.x, g.y - avatar.y) < 85).sort((a, b) => Math.hypot(a.x - avatar.x, a.y - avatar.y) - Math.hypot(b.x - avatar.x, b.y - avatar.y))[0];
  if (!gate) return;
  if (gate.open) {
    const closedMap = { ...collision, gates: collision.gates.map(candidate => candidate === gate ? { ...candidate, open: false } : candidate) };
    const radius = walkerRadius();
    if (!canOccupy(closedMap, avatar.x, avatar.y, radius)) { $('status').textContent = 'Cannot close a gate on the walker.'; draw(); return; }
  }
  gate.open = !gate.open; $('status').textContent = `${gate.open ? 'Opened' : 'Closed'} nearby gate.`; draw();
}
setInterval(() => { if (!avatar || !collision) return; const input = { x: (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), y: (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0) }; if (input.x || input.y) { moveBody(collision, avatar, input, walkerRadius(), avatar.role === 'contestant' ? 9 : 8); draw(); } }, 50);
function editing(target) { return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)); }
addEventListener('keydown', event => { if (editing(event.target)) return; if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) { keys.add(event.code); event.preventDefault(); } if (event.code === 'KeyE' && !event.repeat) toggleNearbyGate(); });
addEventListener('keyup', event => { if (!editing(event.target)) keys.delete(event.code); });
addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => { if (document.hidden) keys.clear(); });
document.addEventListener('focusin', () => keys.clear());
let generationTimer;
function scheduleGeneration() { clearTimeout(generationTimer); generationTimer = setTimeout(generate, 150); }
['density', 'room-cells', 'decay'].forEach(id => $(id).addEventListener('input', () => { $(`${id}-value`).value = Number($(id).value).toFixed(id === 'room-cells' ? 0 : 2); scheduleGeneration(); }));
$('generate').addEventListener('click', generate); $('reset').addEventListener('click', () => { resetAvatar(); draw(); }); $('role').addEventListener('change', () => { if (avatar) { resetAvatar(); draw(); } }); $('roofs').addEventListener('change', draw); $('routes').addEventListener('change', draw);
$('builder').addEventListener('change', updateApplicableControls);
for (const id of ['builder', 'body-profile', 'entry-count', 'region-shape', 'seed', 'loot-budget', 'loot-tier', 'north-port']) $(id).addEventListener('change', generate);
$('download').addEventListener('click', () => { const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `micro-region-${result.spec.seed}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); });
window.microLabDebug = () => structuredClone({ result, avatar: avatar && { x: avatar.x, y: avatar.y, role: avatar.role }, collision: collision && { obstacles: collision.obstacles.length, gates: collision.gates.length } });
$('import').addEventListener('change', async event => {
  clearTimeout(generationTimer);
  const file = event.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text()), candidate = data.version ? data : generateMicroRegion(data);
    const errors = validateMicroRegion(candidate);
    if (errors.length) throw new Error(errors.join(' '));
    const map = regionCollisionMap(candidate, origin);
    result = candidate; collision = map; avatar = null; keys.clear(); resetAvatar();
    $('download').disabled = false; $('reset').disabled = false;
    $('status').textContent = `Loaded ${file.name}. Controls generate a new example; download preserves this artifact.`;
    diagnostics(); draw();
  } catch (error) { $('status').textContent = `Import rejected: ${error.message}`; }
  event.target.value = '';
});
updateApplicableControls(); generate();
