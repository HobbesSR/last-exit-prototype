// Playback deliberately has no imports: seeking uses retained state only.
export function retainedFrame(witness, tick) {
  let held = witness.frames[0];
  for (const frame of witness.frames) {
    if (frame.tick > tick) break;
    held = frame;
  }
  return structuredClone(held);
}

export function drawBallisticFrame(ctx, witness, frame) {
  ctx.clearRect(0, 0, 800, 420);
  ctx.save(); ctx.translate(30, 140); ctx.scale(3.5, 2);
  const { bounds, obstacles, holes, decorativeRoofs = [] } = witness.scene;
  ctx.fillStyle = '#173339'; ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
  ctx.fillStyle = '#080e15';
  for (const h of holes) ctx.fillRect(h.x, h.y, h.w, h.h);
  ctx.strokeStyle = '#8dacc0'; ctx.setLineDash([2, 2]);
  for (const roof of decorativeRoofs) ctx.strokeRect(roof.x, roof.y, roof.w, roof.h);
  ctx.setLineDash([]);
  for (const o of obstacles) {
    ctx.fillStyle = '#947452'; ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.fillStyle = '#bc9a70'; ctx.fillRect(o.x, o.y - o.zMax, o.w, o.zMax - o.zMin);
  }
  const d = frame.display;
  ctx.fillStyle = '#05090c'; ctx.beginPath(); ctx.ellipse(d.shadow.x, d.shadow.y, 3, 1.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#69b6b8'; ctx.beginPath(); ctx.moveTo(d.shadow.x, d.shadow.y); ctx.lineTo(d.sprite.x, d.sprite.y); ctx.stroke();
  ctx.fillStyle = '#ffd36b'; ctx.fillRect(d.sprite.x - 2, d.sprite.y - 4, 4, 4);
  ctx.restore();
}

export function mountPlayback(recording, doc = document) {
  const select = doc.querySelector('select'), slider = doc.querySelector('input');
  const canvas = doc.querySelector('canvas'), output = doc.querySelector('output');
  for (const witness of recording.witnesses) {
    const option = doc.createElement('option'); option.textContent = witness.name; select.append(option);
  }
  function show(reset = false) {
    const witness = recording.witnesses[select.selectedIndex];
    slider.max = witness.frames.at(-1).tick;
    if (reset) slider.value = 0;
    const frame = retainedFrame(witness, Number(slider.value));
    drawBallisticFrame(canvas.getContext('2d'), witness, frame);
    output.textContent = `tick ${frame.tick} · ${frame.display.status} · height ${frame.display.z.toFixed(2)} · ground ${frame.display.groundPlaneId}`;
    doc.querySelector('pre').textContent = JSON.stringify({ tick: frame.tick, state: frame.state, events: frame.events }, null, 2);
    return frame;
  }
  select.addEventListener('change', () => show(true));
  slider.addEventListener('input', () => show()); show(true);
}
