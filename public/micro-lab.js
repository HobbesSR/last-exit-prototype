import { generateMicroRegion, validateMicroRegion } from '/map/micro/index.ts';
import { builtMapCollision, builtMapFrame, regionCollisionMap } from '/map/micro/adapter.ts';
import { microExample } from '/map/micro/examples.ts';
import { buildRegion } from '/map/micro/region-types.ts';
import { canOccupy, moveBody } from '/shared/movement.ts';
import { microMetrics } from '/map/micro/metrics.ts';
import { createRegionMask, elementShapes, OUTSIDE, portalStands, spreadPoints, validatePortalReach } from '/map/micro/sdk.ts';
import { outline, transform } from '/shared/shape.ts';

const $ = id => document.getElementById(id);
const canvas = $('preview'), ctx = canvas.getContext('2d');
canvas.tabIndex = 0;
canvas.addEventListener('pointerdown', () => canvas.focus());
const MICRO_ORIGIN = { x: 12000, y: 6000 };
/** A region type's brief: one zone, at the loot tier, with this chance of loot in each cell. */
const LOOT_CHANCE = 0.04;
let result = null, collision = null, avatar = null, keys = new Set(), scale = 1, offset = { x: 0, y: 0 }, origin = MICRO_ORIGIN;
/** Region types: the buildings their strategy made from designs, held in memory only (17.2.8 M30), and the portal check. */
let traces = [], promise = null, drawn = {};
const regionType = () => $('builder').value.startsWith('region:') ? $('builder').value.slice(7) : null;
/** Region results carry a brief; the lab walks them at cell proportions. */
const specOf = r => r.brief ? { ...r.brief, bodyProfile: 'cell' } : r.spec;

function setControlEnabled(control, enabled, note) {
  const label = $(control);
  const input = label.querySelector('input, select');
  input.disabled = !enabled;
  label.title = note;
  label.classList.toggle('not-applicable', !enabled);
}
function updateApplicableControls() {
  const builder = $('builder').value, entry = builder === 'entry', ruins = builder === 'ruins', type = regionType(), example = !entry && !type;
  const typeNote = 'Region types take a brief, not example builder parameters.';
  setControlEnabled('body-profile-control', !type, type ? 'Region types are walked at cell proportions.' : 'Applies to example builders.');
  setControlEnabled('entry-count-control', entry, entry ? 'Applies to contestant entry layouts.' : 'Applies only to Contestant entry.');
  setControlEnabled('density-control', example, entry ? 'Entry layouts use spacing instead of architecture density.' : type ? typeNote : 'Applies to architecture builders.');
  setControlEnabled('room-cells-control', example, entry ? 'Entry layouts do not place rooms.' : type ? typeNote : 'Applies to architecture builders.');
  setControlEnabled('decay-control', ruins, ruins ? 'Collapsed rubble increases as decay rises.' : 'Applies only to Ruins.');
  setControlEnabled('loot-budget-control', example, entry ? 'Entry layouts do not place loot.' : type ? `A brief gives each cell a ${LOOT_CHANCE} loot chance instead.` : 'Applies to architecture builders.');
  setControlEnabled('loot-tier-control', !entry, entry ? 'Entry layouts do not place loot.' : type ? 'The tier of the brief\'s one zone.' : 'Applies to architecture builders.');
  for (const id of ['design-graph', 'allocation', 'spans', 'openings']) setControlEnabled(`${id}-control`, !!type, type ? 'Draws the buildings this region type made from designs.' : 'Applies to region types that build from a design.');
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
/** The lab's example region as a brief: its cells, its ports as portals, and one zone. */
function briefFromControls() {
  const example = specFromControls();
  const portals = example.ports.map(({ id, side, start, length }) => side === 'W' || side === 'E'
    ? { id, axis: 'v', x: start.x + (side === 'E' ? 1 : 0), y: start.y, length }
    : { id, axis: 'h', x: start.x, y: start.y + (side === 'S' ? 1 : 0), length });
  return { id: example.id, seed: example.seed, type: regionType(), cellSize: example.cellSize, cells: example.cells, portals,
    zones: [{ tier: Number($('loot-tier').value), bonus: 0, lootChance: LOOT_CHANCE, cells: example.cells }] };
}
function local(point) { return { x: point.x - origin.x, y: point.y - origin.y }; }
function resetAvatar() {
  if (!result) return;
  const spec = specOf(result), radius = microMetrics(spec).body[$('role').value === 'gladiator' ? 'hunter' : 'contestant'];
  const port = result.brief ? { inside: portalStands(spec).find(stand => stand.points.length)?.points[0] }
    : result.ports.find(port => port.required === 'hunter') || result.ports.find(port => port.required === 'contestant' && $('role').value === 'contestant');
  const point = port?.inside || spreadPoints(createRegionMask(spec), { count: 1, radius, blockers: result.elements.flatMap(e => elementShapes(e, true)) }).points[0];
  if (!point) { avatar = null; return; }
  avatar = { role: $('role').value, x: origin.x + point.x, y: origin.y + point.y };
}
function generate() {
  clearTimeout(generationTimer);
  try {
    const type = regionType();
    if (type) {
      const found = [], built = buildRegion(briefFromControls(), undefined, trace => found.push(trace));
      // A lone region: its portals lead off the map, so it pairs with nothing and isn't composed.
      const map = { cellSize: built.brief.cellSize, regions: [built], pairs: [] };
      const check = validatePortalReach({ ...built.brief, blockers: built.elements.flatMap(e => elementShapes(e)) });
      result = built; traces = found; promise = check.errors; origin = builtMapFrame(map).origin; collision = builtMapCollision(map);
    } else {
      result = generateMicroRegion(specFromControls()); traces = []; promise = null; origin = MICRO_ORIGIN;
      collision = regionCollisionMap(result, origin);
    }
    resetAvatar(); $('download').disabled = false; $('reset').disabled = false;
    $('status').textContent = `Generated ${type ?? result.manifest.builder} region from seed ${specOf(result).seed}.`;
    diagnostics(); draw();
  } catch (error) { result = collision = avatar = null; traces = []; promise = null; $('buildings').replaceChildren(); $('download').disabled = true; $('reset').disabled = true; $('status').textContent = `Could not generate this region: ${error.message}`; $('diagnostics').replaceChildren(); $('ports').replaceChildren(); draw(); }
}
function diagnostics() {
  const spec = specOf(result), metrics = microMetrics(spec), unit = spec.cellSize;
  const tuning = result.brief ? ` Region type ${spec.type}: ${traces.length ? 'its strategy built from a design.' : 'no building from a design in this region.'}` : spec.builder === 'ruins' ? ` Ruin decay ${(result.spec.parameters?.decay ?? .35).toFixed(2)} changes intact spans into collapsed rubble.` : spec.builder === 'entry' ? ' Seed selects a deterministic equally-spaced entry layout.' : ' Ruin decay applies only to the Ruins builder.';
  $('scale-note').textContent = `Diameters: contestant ${2 * metrics.body.contestant / unit} cells; hunter ${2 * metrics.body.hunter / unit} cells. Doorway ${metrics.doorway / unit} cells; squeeze ${metrics.squeeze / unit} cells.${tuning}`;
  const values = [['Cells', result.manifest.cells], ['Structures', result.manifest.structures], ['Obstacles', result.manifest.obstacles], ['Gates', result.manifest.gates], ['Loot', result.manifest.loot]];
  if (!result.brief) values.push(['Placement refusals', `${result.manifest.rejected} / ${result.manifest.attempted}`]);
  else values.push(['Buildings from designs', traces.length], ['Portal promise', promise.length ? 'broken' : 'kept']);
  if (result.entry) values.push(['Entry positions', `${result.entry.points.length} / ${result.entry.requested}`], ['Unplaced contestants', result.entry.shortfall], ['Minimum spacing', result.entry.minimumSpacing === null ? '—' : `${(result.entry.minimumSpacing / unit).toFixed(2)} cells`]);
  $('diagnostics').replaceChildren(...values.flatMap(([name, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; return [dt, dd]; }));
  const item = (text, className) => { const li = document.createElement('li'); li.textContent = text; if (className) li.className = className; return li; };
  $('ports').replaceChildren(...(result.brief ? result.brief.portals.map(p => item(`${p.id}: portal ${p.axis === 'h' ? 'across' : 'down'} from (${p.x}, ${p.y}), ${p.length} cells`))
    : result.ports.map(port => item(`${port.id}: ${port.side}, ${port.length} cells (${port.required})`))));
  // The portal promise is the one requirement; unmet connections are guidance (17.2.8 M29).
  $('buildings').replaceChildren(...(promise?.length ? promise.map(error => item(`Portal promise broken: ${error}`, 'error')) : []), ...traces.flatMap(trace => {
    const { design, realization } = trace, spaces = design.spaces.length;
    return [item(`${trace.label}: ${spaces} space${spaces === 1 ? '' : 's'}, ${design.connections.length} connections, ${realization.openings.length} openings, ${spansOf(trace).length} spans`),
      ...unmet(trace).map(c => item(`Guidance not met: ${c.id} (${c.kind}, ${c.a}–${c.b}), ${realization.misses.find(m => m.connectionId === c.id)?.reason ?? 'no opening'}`, 'warning'))];
  }));
}
/** Connections whose two spaces got no opening between them. Guidance, so a warning, never an error. */
function unmet(trace) { const placed = new Set(trace.realization.openings.map(o => o.connectionId)); return trace.design.connections.filter(c => !placed.has(c.id)); }
function spansOf(trace) { return trace.realization.boundaries.flatMap(boundary => boundary.spans.map(span => ({ boundary, span }))); }
function project(point) { return { x: offset.x + point.x * scale, y: offset.y + point.y * scale }; }
function path(points) { ctx.beginPath(); points.forEach((p, i) => { const q = project(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); }
function draw() {
  const { width, height } = canvas; ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#0b1515'; ctx.fillRect(0, 0, width, height);
  if (!result) return;
  const spec = specOf(result), cellSize = spec.cellSize;
  drawn = {};
  const bounds = result.bounds ?? builtBounds(spec), pad = 44; scale = Math.min((width - pad * 2) / bounds.w, (height - pad * 2) / bounds.h); offset = { x: (width - bounds.w * scale) / 2 - bounds.x * scale, y: (height - bounds.h * scale) / 2 - bounds.y * scale };
  ctx.fillStyle = '#263c37'; for (const cell of spec.cells) { const p = project({ x: cell.x * cellSize, y: cell.y * cellSize }); ctx.fillRect(p.x + .5, p.y + .5, cellSize * scale - 1, cellSize * scale - 1); }
  if ($('allocation').checked && result.brief) drawAllocation();
  if ($('routes').checked) for (const route of result.routes ?? []) { ctx.strokeStyle = route.role === 'hunter' ? '#e9ad59' : '#72d8d2'; ctx.lineWidth = Math.max(2, route.radius * scale / 4); ctx.beginPath(); route.points.forEach((p, i) => { const q = project(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke(); }
  for (const element of result.elements) for (const part of element.template.parts) if (part.part === 'obstacle') { const points = outline(transform(part.shape, element.x, element.y)); path(points); ctx.fillStyle = part.kind === 'tree' ? '#567d4e' : '#84918c'; ctx.fill(); ctx.strokeStyle = '#c4d3bd'; ctx.lineWidth = 1; ctx.stroke(); }
  if ($('roofs').checked) for (const element of result.elements) if (element.template.encloses) { const p = project({ x: element.x, y: element.y }); ctx.fillStyle = '#3d2c3bb8'; ctx.fillRect(p.x, p.y, element.template.w * scale, element.template.h * scale); }
  for (const gate of collision.gates) { const p = project(local(gate)); ctx.fillStyle = gate.open ? '#6abf87' : '#d66955'; ctx.fillRect(p.x - gate.w * scale / 2, p.y - gate.h * scale / 2, gate.w * scale, gate.h * scale); }
  for (const loot of result.loot) { const p = project(loot); ctx.fillStyle = '#f2ca55'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff1ae'; ctx.lineWidth = 1; ctx.stroke(); }
  for (const port of result.ports ?? []) { const p = project(port.centre); ctx.fillStyle = '#e9f7c4'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); }
  for (const portal of result.brief?.portals ?? []) line(gridPoint(portal.x, portal.y, cellSize), gridPoint(portal.x + (portal.axis === 'h' ? portal.length : 0), portal.y + (portal.axis === 'v' ? portal.length : 0), cellSize), '#e9f7c4', 4);
  if (result.brief) {
    if ($('spans').checked) drawSpans();
    if ($('openings').checked) drawOpenings();
    if ($('design-graph').checked) drawDesignGraph();
  }
  for (const [i, point] of (result.entry?.points || []).entries()) { const p = project(point); ctx.beginPath(); ctx.arc(p.x, p.y, microMetrics(spec).body.contestant * scale, 0, Math.PI * 2); ctx.fillStyle = '#a78bd866'; ctx.fill(); ctx.strokeStyle = '#ccafff'; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), p.x, p.y); }
  if (avatar) { const p = project(local(avatar)); ctx.fillStyle = avatar.role === 'gladiator' ? '#ed7770' : '#8ee1e0'; ctx.beginPath(); ctx.arc(p.x, p.y, walkerRadius() * scale, 0, Math.PI * 2); ctx.fill(); }
}
function builtBounds(spec) {
  const xs = spec.cells.map(c => c.x), ys = spec.cells.map(c => c.y), x = Math.min(...xs), y = Math.min(...ys);
  return { x: x * spec.cellSize, y: y * spec.cellSize, w: (Math.max(...xs) + 1 - x) * spec.cellSize, h: (Math.max(...ys) + 1 - y) * spec.cellSize };
}
const SPACE_COLOURS = ['#5fa8d3', '#c77dff', '#e9c46a', '#80ed99', '#f28482', '#4cc9f0', '#f4a261', '#b5e48c'];
const KIND_COLOURS = { door: '#ff8a5c', open: '#7ee08a', window: '#6fc8ff' };
const WARNING = '#e9ad59';
const gridPoint = (x, y, size, at = { x: 0, y: 0 }) => ({ x: at.x + x * size, y: at.y + y * size });
const runEnd = run => ({ x: run.x + (run.axis === 'h' ? run.length : 0), y: run.y + (run.axis === 'v' ? run.length : 0) });
function line(a, b, colour, width, dash = []) { const p = project(a), q = project(b); ctx.save(); ctx.setLineDash(dash); ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.restore(); }
function label(point, text, colour) { const p = project(point); ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = 3; ctx.strokeStyle = '#0b1515'; ctx.strokeText(text, p.x, p.y); ctx.fillStyle = colour; ctx.fillText(text, p.x, p.y); }
/** The centre of some of a building's allocation cells, in world units. */
function centroid(trace, cells) { const n = cells.length || 1; return gridPoint(cells.reduce((s, c) => s + c.x + .5, 0) / n, cells.reduce((s, c) => s + c.y + .5, 0) / n, trace.cellSize, trace.origin); }
/** A placed opening's two ends along its run, in world units. */
function openingEnds(trace, { run, center, length }) {
  const along = d => gridPoint(run.x + (run.axis === 'h' ? d : 0), run.y + (run.axis === 'v' ? d : 0), trace.cellSize, trace.origin);
  return [along(center - length / 2), along(center + length / 2)];
}
function drawAllocation() {
  let cells = 0;
  for (const trace of traces) trace.allocation.spaces.forEach((space, i) => {
    ctx.fillStyle = `${SPACE_COLOURS[i % SPACE_COLOURS.length]}66`;
    for (const c of space.cells) { const p = project(gridPoint(c.x, c.y, trace.cellSize, trace.origin)); ctx.fillRect(p.x + 1, p.y + 1, trace.cellSize * scale - 2, trace.cellSize * scale - 2); cells++; }
  });
  // Above the centre, where the design graph's node sits.
  for (const trace of traces) trace.allocation.spaces.forEach((space, i) => { const c = centroid(trace, space.cells); label({ x: c.x, y: c.y - trace.cellSize * .8 }, `${space.cells.length} cells`, SPACE_COLOURS[i % SPACE_COLOURS.length]); });
  drawn.allocation = { cells };
}
/** Each span between two owners, dashed: blue onto the outside, violet between spaces. */
function drawSpans() {
  let spans = 0;
  for (const trace of traces) for (const { boundary, span } of spansOf(trace)) {
    const colour = boundary.a === OUTSIDE || boundary.b === OUTSIDE ? '#7fb2ff' : '#d38cff', at = (x, y) => gridPoint(x, y, trace.cellSize, trace.origin);
    for (const { run } of span.steps) { const end = runEnd(run); line(at(run.x, run.y), at(end.x, end.y), colour, 3, [6, 4]); }
    const { run } = span.steps[0], end = runEnd(run);
    // A quarter along the first run, clear of an opening centred on it.
    label(at(run.x + (end.x - run.x) / 4, run.y + (end.y - run.y) / 4), `${boundary.a} | ${boundary.b}`, colour);
    spans++;
  }
  drawn.spans = { spans };
}
function drawOpenings() {
  let openings = 0;
  for (const trace of traces) for (const opening of trace.realization.openings) {
    const [a, b] = openingEnds(trace, opening), colour = KIND_COLOURS[opening.kind];
    line(a, b, colour, 7); label({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, opening.connectionId, colour); openings++;
  }
  drawn.openings = { openings };
}
/** Spaces as nodes at their cells' centre; connections as edges in their kind's colour, through their opening where placed. */
function drawDesignGraph() {
  let nodes = 0, edges = 0, warnings = 0;
  for (const trace of traces) {
    const cells = new Map(trace.allocation.spaces.map(s => [s.id, s.cells])), whole = centroid(trace, trace.allocation.footprint);
    const at = id => cells.get(id)?.length ? centroid(trace, cells.get(id)) : whole;
    const missing = new Set(unmet(trace).map(c => c.id));
    for (const connection of trace.design.connections) {
      const opening = trace.realization.openings.find(o => o.connectionId === connection.id), miss = missing.has(connection.id);
      const colour = miss ? WARNING : KIND_COLOURS[connection.kind], dash = miss ? [5, 5] : [], outside = connection.a === OUTSIDE || connection.b === OUTSIDE;
      const inner = connection.a === OUTSIDE ? connection.b : connection.a, from = at(inner);
      let mid = from, to;
      if (opening) { const [a, b] = openingEnds(trace, opening); mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
      if (outside) {
        // The outside sits a cell beyond the opening, or beyond the footprint on the preferred side when there is none.
        const dir = opening ? { x: mid.x - from.x, y: mid.y - from.y } : { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 }, E: { x: 1, y: 0 } }[connection.side ?? 'N'];
        const n = Math.hypot(dir.x, dir.y) || 1, reach = opening ? trace.cellSize : trace.cellSize * 3;
        to = { x: mid.x + dir.x / n * reach, y: mid.y + dir.y / n * reach };
      } else to = at(connection.a === inner ? connection.b : connection.a);
      line(from, mid, colour, 2, dash); line(mid, to, colour, 2, dash);
      if (outside) label(to, miss ? `! ${connection.id}` : OUTSIDE, colour);
      else if (miss) label(mid, `! ${connection.id}`, colour);
      edges++; if (miss) warnings++;
    }
    for (const space of trace.design.spaces) {
      const centre = at(space.id), p = project(centre); ctx.fillStyle = '#f1f7ee'; ctx.strokeStyle = '#0b1515'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      label({ x: centre.x, y: centre.y + 16 / scale }, space.id, '#f1f7ee'); nodes++;
    }
  }
  drawn.graph = { nodes, edges, warnings };
}
function walkerRadius() { return microMetrics(specOf(result)).body[avatar.role === 'gladiator' ? 'hunter' : 'contestant']; }
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
for (const id of ['design-graph', 'allocation', 'spans', 'openings']) $(id).addEventListener('change', draw);
$('builder').addEventListener('change', updateApplicableControls);
for (const id of ['builder', 'body-profile', 'entry-count', 'region-shape', 'seed', 'loot-budget', 'loot-tier', 'north-port']) $(id).addEventListener('change', generate);
$('download').addEventListener('click', () => { const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = result.brief ? `region-${result.brief.type}-${result.brief.seed}.json` : `micro-region-${result.spec.seed}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); });
window.microLabDebug = () => structuredClone({ result, buildings: traces, promise, drawn, avatar: avatar && { x: avatar.x, y: avatar.y, role: avatar.role }, collision: collision && { obstacles: collision.obstacles.length, gates: collision.gates.length } });
$('import').addEventListener('change', async event => {
  clearTimeout(generationTimer);
  const file = event.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text()), candidate = data.version ? data : generateMicroRegion(data);
    const errors = validateMicroRegion(candidate);
    if (errors.length) throw new Error(errors.join(' '));
    const map = regionCollisionMap(candidate, MICRO_ORIGIN);
    result = candidate; collision = map; origin = MICRO_ORIGIN; traces = []; promise = null; avatar = null; keys.clear(); resetAvatar();
    $('download').disabled = false; $('reset').disabled = false;
    $('status').textContent = `Loaded ${file.name}. Controls generate a new example; download preserves this artifact.`;
    diagnostics(); draw();
  } catch (error) { $('status').textContent = `Import rejected: ${error.message}`; }
  event.target.value = '';
});
updateApplicableControls(); generate();
