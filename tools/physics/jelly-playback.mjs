// Retained-state playback: this module has no solver, WASM, or network imports.
export function retainedJellyFrame(witness, tick) {
  let held = witness.frames[0];
  for (const frame of witness.frames) {
    if (frame.tick > tick) break;
    held = frame;
  }
  return structuredClone(held);
}

function extent(body) {
  return body.shape === 'box' ? Math.hypot(body.hx, body.hy) : (body.radius ?? 4);
}

function viewFor(witness) {
  const bodies = [...(witness.scene.bodies ?? []), ...witness.frames.flatMap(frame => frame.bodies)];
  const left = Math.min(...bodies.map(body => body.x - extent(body))) - 12;
  const right = Math.max(...bodies.map(body => body.x + extent(body))) + 12;
  const top = Math.min(...bodies.map(body => body.y - extent(body))) - 12;
  const bottom = Math.max(...bodies.map(body => body.y + extent(body))) + 12;
  const width = Math.max(60, right - left), height = Math.max(60, bottom - top);
  const scale = Math.min(740 / width, 360 / height, 5);
  return { x: 400 - (left + right) * scale / 2, y: 210 - (top + bottom) * scale / 2, scale };
}

function shape(ctx, body) {
  ctx.save();
  ctx.translate(body.x, body.y);
  ctx.rotate(body.angle ?? 0);
  ctx.beginPath();
  if (body.shape === 'box') ctx.rect(-body.hx, -body.hy, body.hx * 2, body.hy * 2);
  else ctx.arc(0, 0, body.radius ?? 4, 0, Math.PI * 2);
  ctx.restore();
}

export function drawJellyFrame(ctx, witness, frame) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = '#102333'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const view = viewFor(witness);
  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.scale, view.scale);
  const bodies = new Map(frame.bodies.map(body => [body.id, body]));
  const ring = witness.jelly.ringIds.map(id => bodies.get(id)).filter(Boolean);
  const core = bodies.get(witness.jelly.coreId);
  const ringIds = new Set(witness.jelly.ringIds);
  for (const body of frame.bodies) {
    if (body.id === witness.jelly.coreId || ringIds.has(body.id)) continue;
    shape(ctx, body);
    ctx.fillStyle = body.kind === 'static' ? '#415b66' : '#7894a1'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#a9bec5'; ctx.stroke();
  }
  if (ring.length >= 3) {
    ctx.beginPath(); ctx.moveTo(ring[0].x, ring[0].y);
    for (const node of ring.slice(1)) ctx.lineTo(node.x, node.y);
    ctx.closePath(); ctx.fillStyle = 'rgba(73,214,183,.45)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#62e8c6'; ctx.stroke();
  }
  for (const node of ring) {
    shape(ctx, node); ctx.fillStyle = '#95ffe0'; ctx.fill();
  }
  if (core) {
    if (witness.jelly.ringIds.length === 0) {
      const compression = frame.compression ?? {};
      const amount = Math.max(0, Math.min(1, compression.amount ?? 0));
      const angle = Math.atan2(compression.axisY ?? 0, compression.axisX ?? 1);
      ctx.save(); ctx.translate(core.x, core.y); ctx.rotate(angle);
      ctx.beginPath(); ctx.ellipse(0, 0, witness.jelly.restRadius * (1 - .35 * amount),
        witness.jelly.restRadius, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#4db3dc'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#d5f4ff'; ctx.stroke(); ctx.restore();
    }
    shape(ctx, core);
    if (ring.length) { ctx.fillStyle = '#183849'; ctx.fill(); }
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffd485'; ctx.stroke();
  }
  ctx.restore();
  const compression = frame.compression ?? {};
  ctx.font = '15px system-ui';
  ctx.fillStyle = compression.crushed ? '#ff8e81' : '#9ec9b6';
  ctx.fillText(`Lab crush signal: ${compression.crushed ? 'threshold reached' : 'below threshold'}`, 20, 28);
}

export function mountPlayback(recording, doc = document) {
  const witnessSelect = doc.getElementById('witness');
  const tick = doc.getElementById('tick');
  const speed = doc.getElementById('speed');
  const play = doc.getElementById('play');
  const reset = doc.getElementById('reset');
  const exportButton = doc.getElementById('export');
  const output = doc.querySelector('output');
  const details = doc.querySelector('pre');
  const ctx = doc.querySelector('canvas').getContext('2d');
  let timer;
  for (const witness of recording.witnesses) {
    const option = doc.createElement('option'); option.textContent = witness.name;
    witnessSelect.append(option);
  }
  const current = () => recording.witnesses[witnessSelect.selectedIndex];
  function stop() { if (timer) clearInterval(timer); timer = undefined; play.textContent = 'Play'; }
  function show() {
    const witness = current();
    const frame = retainedJellyFrame(witness, Number(tick.value));
    drawJellyFrame(ctx, witness, frame);
    output.textContent = `tick ${frame.tick} · compression ${(frame.compression?.amount ?? 0).toFixed(3)} · lab crush signal ${frame.compression?.crushed ? 'threshold reached' : 'below threshold'}`;
    details.textContent = JSON.stringify({ tick: frame.tick, compression: frame.compression, events: frame.events, bodies: frame.bodies }, null, 2);
    return frame;
  }
  witnessSelect.addEventListener('change', () => {
    stop(); tick.max = current().frames.at(-1).tick; tick.value = current().frames[0].tick; show();
  });
  tick.addEventListener('input', show);
  play.addEventListener('click', () => {
    if (timer) { stop(); return; }
    if (Number(tick.value) >= Number(tick.max)) tick.value = current().frames[0].tick;
    show(); play.textContent = 'Pause';
    timer = setInterval(() => {
      if (Number(tick.value) >= Number(tick.max)) { stop(); return; }
      tick.value = String(Number(tick.value) + 1); show();
    }, recording.profile.tickSeconds * 1000 / Number(speed.value));
  });
  speed.addEventListener('change', () => {
    if (timer) { stop(); play.click(); }
  });
  reset.addEventListener('click', () => { stop(); tick.value = current().frames[0].tick; show(); });
  exportButton.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(recording, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a'); link.href = url; link.download = 'physics-jelly.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  witnessSelect.dispatchEvent(new Event('change'));
  return { show, stop };
}
