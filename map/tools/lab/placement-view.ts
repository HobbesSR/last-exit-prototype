import type { PlacementRecording } from '../placement-trace.ts';
import type { PlacementTraceEvent } from '../../macro/src/chain/placement-trace.ts';
import type { ChainLibrary } from '../../macro/src/chain/library.ts';
import { orientedDesigns } from '../../macro/src/chain/declared-grid.ts';
import { drawPlacementTiles } from './placement-drawing.ts';
import type { Slot, Tile } from './placement-drawing.ts';

type Refusal = Extract<PlacementTraceEvent, { type: 'refusal' }>;

/** A recording is a delta log. Seeking backwards rebuilds only the selected attempt. */
export function mountPlacementView(host: HTMLElement, run: () => void, cancel: () => void) {
  host.innerHTML = `
    <header class="solve-header"><h1>Placement</h1>
      <button id="solveRecord" class="primary" type="button">Record placement</button>
      <button id="solveCancel" type="button" disabled>Cancel</button>
      <span id="solveStatus" role="status">Record a seed to inspect its solve.</span></header>
    <div class="solve-recipe-controls">
      <label>Seed<input id="solveSeed" /></label>
      <label>Zone size<select id="solveSize"></select></label>
      <button id="solveRandom" type="button">New seed</button>
    </div>
    <p id="solveRecipe" class="hint">Edit seed and size here. Mode and library use the World recipe. Placement only; no regions are built.</p>
    <div class="solve-controls">
      <label>Attempt <select id="solveAttempt" disabled></select></label>
      <button id="solvePrev" type="button" disabled>← Step</button>
      <button id="solvePlay" type="button" disabled>Play</button>
      <button id="solveNext" type="button" disabled>Step →</button>
      <button id="solvePrevRefusal" type="button" disabled>← Refusal</button>
      <button id="solveNextRefusal" type="button" disabled>Refusal →</button>
      <button id="solveFit" type="button">Fit map</button>
      <label>Events / second <select id="solveSpeed"><option>5</option><option selected>30</option><option>120</option></select></label>
    </div>
    <label class="solve-timeline">Event <input id="solveStep" aria-label="Placement event" type="range" min="0" max="0" value="0" disabled><output id="solvePosition">0 / 0</output></label>
    <div class="solve-workspace"><div class="solve-canvas-wrap"><canvas id="solveCanvas" aria-label="Placement solve"></canvas></div>
      <aside class="solve-inspector"><h2>At this step</h2><p id="solveCounters"></p><p id="solveEvent"></p><p id="solveHover" class="hint">Hover a slot for its tile and depth.</p>
      <h2>Legend</h2><p class="hint">Wheel to zoom / Drag to pan / Fit to reset.</p><p class="hint">Unfilled: dark. Set pieces: continuous blue, shown internally passable. Fill: colour by collapse depth, cool to warm. Outer hinted segments: thick dark lines; passable: pale lines; any: dashed.</p>
      <p class="hint">Refused component: red. Cut faces: pink. Cause slots: yellow. These are macro prescriptions and connectivity diagnostics.</p>
      <pre id="solveDetails"></pre></aside></div>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`#${id}`)!;
  const step = el<HTMLInputElement>('solveStep'), attempts = el<HTMLSelectElement>('solveAttempt');
  const canvas = el<HTMLCanvasElement>('solveCanvas'), ctx = canvas.getContext('2d')!;
  let recording: PlacementRecording | null = null;
  let byAttempt: PlacementTraceEvent[][] = [];
  let events: PlacementTraceEvent[] = [];
  let slots: Slot[] = [], tiles = new Map<number, Tile>();
  let index = 0, applied = -1, depth = 0, stall = 0, iterations = 0;
  let maxDepth = 1;
  let refusal: Refusal | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let turned: ReturnType<typeof orientedDesigns> | null = null;
  let frame = { x: 0, y: 0, scale: 1 };
  let zoom = 1, pan = { x: 0, y: 0 };
  let drag: { x: number; y: number } | null = null;
  const pause = () => { if (timer !== undefined) clearInterval(timer); timer = undefined; el('solvePlay').textContent = 'Play'; };
  function apply(event: PlacementTraceEvent) {
    if (event.type === 'attempt-start') slots = event.slots;
    if (event.type === 'set-piece-slot') tiles.set(event.slot, { design: event.design, orientation: event.orientation, depth: -1, piece: event.instance });
    if (event.type === 'node') { depth = event.depth; stall = event.stall; iterations = event.iterations; }
    if (event.type === 'backtrack') depth = event.toDepth;
    if (event.type === 'collapse') for (const slot of event.slots) {
      const existing = tiles.get(slot.slot);
      tiles.set(slot.slot, { design: slot.design, orientation: slot.orientation, depth: event.depth, ...(existing?.piece ? { piece: existing.piece } : {}) });
    }
    if (event.type === 'undo') for (const slot of event.slots) tiles.delete(slot);
    if (event.type === 'conflict') stall = event.stall;
    if (event.type === 'refusal') stall++;
    if (event.type === 'give-up') { stall = event.stall; iterations = event.iterations; }
  }
  function seek(next: number) {
    index = Math.max(0, Math.min(events.length - 1, next));
    if (index < applied) { applied = -1; tiles = new Map(); slots = []; depth = stall = iterations = 0; }
    while (applied < index && applied + 1 < events.length) apply(events[++applied]!);
    const event = events[index];
    refusal = event?.type === 'refusal' ? event : null;
    // Keep the refusal visible at the following conflict, where its backjump is explained.
    if (event?.type === 'conflict') refusal = events.slice(Math.max(0, index - 2), index).find(previous => previous.type === 'refusal') as Refusal ?? null;
    step.value = String(index);
    el('solvePosition').textContent = events.length ? `${index + 1} / ${events.length}` : '0 / 0';
    el('solveCounters').textContent = `Depth ${depth} · Node ${iterations} · Stall ${stall} / 500 · ${tiles.size} collapsed slots`;
    el('solveEvent').textContent = event ? describe(event) : 'No events retained.';
    el('solveDetails').textContent = event ? JSON.stringify(event, (_key, value) => Array.isArray(value) && value.length > 40 ? [...value.slice(0, 40), `… ${value.length - 40} more`] : value, 2) : '';
    draw();
  }
  function describe(event: PlacementTraceEvent): string {
    if (event.type === 'refusal') {
      const conflict = events.slice(index + 1, index + 3).find(next => next.type === 'conflict');
      return `${event.reason}${conflict?.type === 'conflict' ? ` Cause depths ${conflict.depths.join(', ')}; backjump target ${conflict.backjump}.` : ''}`;
    }
    if (event.type === 'conflict') return `Refusal at depth ${event.depth}; cause depths ${event.depths.join(', ')}; backjump target ${event.backjump}.`;
    if (event.type === 'attempt-end') return `Attempt ended: ${event.outcome}. ${event.nodes} nodes; peak stall ${event.mostStall}.`;
    if (event.type === 'give-up') return `Giving up: ${event.reason} limit, at depth ${event.depth}.`;
    if (event.type === 'backtrack') return `Backtracking from depth ${event.fromDepth} to ${event.toDepth}.`;
    if (event.type === 'contradiction') return `Matching contradiction at depth ${event.depth}; empty domains in slots ${event.slots.join(', ')}.`;
    if (event.type === 'set-piece-failed') return `Set piece ${event.setPiece} failed: ${event.reason}`;
    return event.type.replaceAll('-', ' ');
  }
  function draw() {
    const box = canvas.parentElement!.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const ratio = devicePixelRatio || 1;
    canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#0b1015'; ctx.fillRect(0, 0, box.width, box.height);
    if (!slots.length) return;
    const minX = Math.min(...slots.map(s => s.x)) * 6, minY = Math.min(...slots.map(s => s.y)) * 6;
    const width = (Math.max(...slots.map(s => s.x)) + 1) * 6 - minX;
    const height = (Math.max(...slots.map(s => s.y)) + 1) * 6 - minY;
    const scale = Math.max(0.1, Math.min((box.width - 32) / width, (box.height - 32) / height)) * zoom;
    frame = { x: (box.width - width * scale) / 2 - minX * scale + pan.x, y: (box.height - height * scale) / 2 - minY * scale + pan.y, scale };
    ctx.translate(frame.x, frame.y); ctx.scale(scale, scale);
    drawPlacementTiles(ctx, slots, tiles, turned, scale, maxDepth);
    if (refusal) {
      ctx.fillStyle = '#ff3c5c88';
      for (const cell of refusal.cells) ctx.fillRect(cell.x, cell.y, 1, 1);
      ctx.strokeStyle = '#ff9aab'; ctx.lineWidth = 3 / scale;
      for (const face of refusal.faces) { ctx.beginPath(); ctx.moveTo(face.a.x, face.a.y); ctx.lineTo(face.b.x, face.b.y); ctx.stroke(); }
      ctx.strokeStyle = '#ffe477'; ctx.lineWidth = 2 / scale;
      for (const cause of refusal.causeSlots) { const slot = slots[cause]; if (slot) ctx.strokeRect(slot.x * 6 + .15, slot.y * 6 + .15, 5.7, 5.7); }
    }
  }
  function chooseAttempt() {
    pause(); events = byAttempt[Number(attempts.value)] ?? []; applied = -1; tiles.clear(); slots = []; depth = stall = iterations = 0;
    maxDepth = events.reduce((max, event) => event.type === 'collapse' ? Math.max(max, event.depth) : max, 1);
    step.max = String(Math.max(0, events.length - 1)); seek(0);
  }
  function jumpRefusal(direction: number) {
    pause();
    for (let n = index + direction; n >= 0 && n < events.length; n += direction) if (events[n]!.type === 'refusal') { seek(n); return; }
  }
  el('solveRecord').onclick = run; el('solveCancel').onclick = cancel;
  el('solvePrev').onclick = () => { pause(); seek(index - 1); };
  el('solveNext').onclick = () => { pause(); seek(index + 1); };
  el('solvePrevRefusal').onclick = () => jumpRefusal(-1); el('solveNextRefusal').onclick = () => jumpRefusal(1);
  step.oninput = () => { pause(); seek(Number(step.value)); }; attempts.onchange = chooseAttempt;
  el('solvePlay').onclick = () => {
    if (timer !== undefined) { pause(); return; }
    if (index >= events.length - 1) seek(0);
    el('solvePlay').textContent = 'Pause';
    timer = setInterval(() => { if (index >= events.length - 1) pause(); else seek(index + 1); }, 1000 / Number(el<HTMLSelectElement>('solveSpeed').value));
  };
  el('solveSpeed').onchange = pause;
  el('solveFit').onclick = () => { zoom = 1; pan = { x: 0, y: 0 }; draw(); };
  canvas.onwheel = event => {
    event.preventDefault();
    const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
    const before = { x: (x - frame.x) / frame.scale, y: (y - frame.y) / frame.scale };
    zoom = Math.max(0.5, Math.min(30, zoom * Math.exp(-event.deltaY * 0.0015)));
    draw(); pan.x += x - (frame.x + before.x * frame.scale); pan.y += y - (frame.y + before.y * frame.scale); draw();
  };
  canvas.onpointerdown = event => { canvas.setPointerCapture(event.pointerId); drag = { x: event.clientX, y: event.clientY }; };
  canvas.onpointerup = canvas.onpointercancel = () => { drag = null; };
  canvas.onlostpointercapture = () => { drag = null; };
  canvas.onpointermove = event => {
    if (drag) { pan.x += event.clientX - drag.x; pan.y += event.clientY - drag.y; drag = { x: event.clientX, y: event.clientY }; draw(); return; }
    const box = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - box.left - frame.x) / frame.scale / 6), y = Math.floor((event.clientY - box.top - frame.y) / frame.scale / 6);
    const slot = slots.find(s => s.x === x && s.y === y), tile = slot && tiles.get(slot.slot);
    el('solveHover').textContent = slot ? `Slot ${slot.slot} (${x}, ${y}): ${tile ? `${tile.design}@${tile.orientation}, depth ${tile.depth}${tile.piece ? `, ${tile.piece}` : ''}` : 'unfilled'}` : 'Outside the slot mask.';
  };
  new ResizeObserver(draw).observe(canvas.parentElement!);
  return {
    pending(recipe: string) {
      pause(); recording = null; byAttempt = []; events = []; slots = []; tiles.clear(); applied = -1;
      depth = stall = iterations = 0; attempts.replaceChildren(); step.max = '0';
      el('solveHover').textContent = 'Hover a slot for its tile and depth.';
      zoom = 1; pan = { x: 0, y: 0 };
      el('solveRecipe').textContent = recipe;
      el('solveStatus').textContent = 'Recording placement…';
      el<HTMLButtonElement>('solveCancel').disabled = false;
      for (const id of ['solveRecord', 'solveSeed', 'solveSize', 'solveRandom', 'solveAttempt', 'solveStep', 'solvePrev', 'solveNext', 'solvePlay', 'solvePrevRefusal', 'solveNextRefusal']) (el(id) as HTMLButtonElement).disabled = true;
      seek(0);
    },
    stopped(message: string) {
      pause(); el('solveStatus').textContent = message;
      el<HTMLButtonElement>('solveCancel').disabled = true; el<HTMLButtonElement>('solveRecord').disabled = false;
      for (const id of ['solveSeed', 'solveSize', 'solveRandom']) (el(id) as HTMLButtonElement).disabled = false;
    },
    received(result: PlacementRecording, library: ChainLibrary, ms: number) {
      recording = result; turned = orientedDesigns(library); byAttempt = [];
      for (const event of result.events) (byAttempt[event.attempt] ??= []).push(event);
      attempts.replaceChildren(...byAttempt.map((events, i) => {
        const end = events.find(event => event.type === 'attempt-end');
        return Object.assign(document.createElement('option'), { value: String(i), textContent: `${i + 1}: ${end?.type === 'attempt-end' ? end.outcome : 'partial'} (${events.length} events)` });
      }));
      attempts.value = '0';
      for (const id of ['solveAttempt', 'solveStep', 'solvePrev', 'solveNext', 'solvePlay', 'solvePrevRefusal', 'solveNextRefusal']) (el(id) as HTMLButtonElement).disabled = !result.events.length;
      this.stopped(`${result.events.length} events in ${(ms / 1000).toFixed(2)} s. ${result.truncated ? 'Trace limit reached: only the retained prefix is scrubbable. ' : ''}${result.error ?? 'Placement succeeded.'}`);
      chooseAttempt();
    },
    hide: pause,
    snapshot: () => ({ seed: recording?.seed, events: recording?.events.length ?? 0, attempt: Number(attempts.value), index, depth, stall, iterations, collapsed: tiles.size, event: events[index], truncated: recording?.truncated }),
  };
}
