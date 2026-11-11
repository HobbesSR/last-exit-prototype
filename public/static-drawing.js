import { insideMap } from '/shared/movement.ts';
import { roofGroups, roofOverhang, roofCellBorders, ROOF_OVERHANG } from '/shared/view.ts';
import { shapeOf, outline, bounds } from '/shared/shape.ts';
import { mix } from './palette.js';
import { resolveBuildingAppearance, resolveDeclaredRoofs, resolveObstacleAppearance, resolveGroundAppearance, recordAppearanceOps } from './appearance.js';

// The map's static drawing: terrain, structures, fixtures, canopies and roofs, drawn once per map or
// restyle into recorders that a tile cache bakes (tile-cache.js). Nothing here runs per frame.

const obstacleFill = (o, ink) => o.kind === 'fence' ? ink.fence : o.kind === 'building' ? ink.wall : ink.crates[o.color || 0];

/**
 * Record the map's static drawings into `cache` in `ink` and the art options, and its labels through
 * `label(x, y, text, color, size)`. `priorGroups` carries roof and canopy fades over a restyle; a new
 * map starts them afresh. Returns the roof groups the frame fades and what it reads to fade them.
 */
export function recordStatic(cache, map, { ink, palette, lighting, wear }, priorGroups, label) {
  const buildingsById = new Map((map.buildings || []).map(b => [b.id, b])), artOpts = { palette, lighting, wear, buildingsById }; let g;
  const roofs = new Map();
  const { cellSize, rows } = map.playableArea;
  for (const row of rows) for (const [start, end] of row.runs)
    cache.record(start * cellSize, row.y * cellSize, end * cellSize, (row.y + 1) * cellSize).fillStyle(ink.ground).fillRect(start * cellSize, row.y * cellSize, (end - start) * cellSize, cellSize);
  for (let i = 0; i < 430; i++) {
    const x = (i * 479 + map.seed * 7) % map.width, y = (i * 193 + map.seed * 13) % map.height;
    if (!insideMap(map, x, y, 5)) continue;
    g = cache.record(x - 8, y - 8, x + 4, y + 6);
    g.lineStyle(2, ink.tuft, 0.55); g.lineBetween(x - 3, y + 3, x - 5, y - 3); g.lineBetween(x, y + 3, x + 2, y - 5);
  }
  for (const h of map.hazards) {
    g = cache.record(h.x - 4, h.y - 4, h.x + h.w + 4, h.y + h.h + 4);
    g.fillStyle(0x56605a); g.fillRoundedRect(h.x, h.y, h.w, h.h, 10);
    g.lineStyle(3, 0xe9b758); g.strokeRoundedRect(h.x + 4, h.y + 4, h.w - 8, h.h - 8, 7);
    for (let x = h.x + 13; x < h.x + h.w - 12; x += 22) { g.lineStyle(7, 0xe6b357, 0.65); g.lineBetween(x, h.y + 13, x - 4, h.y + h.h - 13); }
  }
  // Floors go down before the obstacles: tiles replay drawings in the order recorded, so a floor
  // recorded after the walls painted over every interior wall and left only the doors showing.
  for (const building of map.buildings || []) {
    const resolved = resolveBuildingAppearance(building, map.appearance, artOpts);
    const floor = cache.record(building.x, building.y, building.x + building.w, building.y + building.h);
    floor.fillStyle(resolved.floorFill); floor.fillRect(building.x + 18, building.y + 18, building.w - 36, building.h - 36);
    if (resolved.floorMarks.length) recordAppearanceOps(floor, resolved.floorMarks);
  }
  // Static ground-plane material, commercial markings, neglect, competition scars and static washes (29.4).
  for (const item of resolveGroundAppearance(map.appearance, artOpts)) {
    const b = item.bounds;
    recordAppearanceOps(cache.record(b.x, b.y, b.x + b.w, b.y + b.h), item.ops);
  }
  // Door and window markings lie on the ground too, reaching past the roof's overhang (56.2).
  for (const d of map.decals || []) drawDecal(cache.record(d.x - 2, d.y - 2, d.x + d.w + 2, d.y + d.h + 2), d);
  for (const o of map.obstacles) {
    // Wide enough for the drop shadow (+5, +8), the outline stroke and a circle's highlight.
    const box = bounds(shapeOf(o));
    drawObstacle(cache.record(box.x - 6, box.y - 6, box.x + box.w + 12, box.y + box.h + 14), o, ink, map.appearance, artOpts);
  }
  const crownPad = map.obstacles.reduce((pad, o) => o.kind === 'tree' && o.r ? Math.max(pad, o.r * 1.9 + 8) : pad, 8);
  cache.group('canopy', 'canopy', { x: -crownPad, y: -crownPad, w: map.width + crownPad * 2, h: map.height + crownPad * 2 }, priorGroups.get('canopy'));
  for (const o of map.obstacles) if (o.kind === 'tree' && o.r) {
    // The simulation still sees the original trunk circle. The wider crown is presentation only.
    const radius = o.r * 1.9, crown = cache.record(o.x - radius - 8, o.y - radius - 8, o.x + radius + 8, o.y + radius + 8, 'canopy');
    crown.fillStyle(ink.canopy[0], 0.5); crown.fillCircle(o.x + 3, o.y + 5, radius);
    crown.fillStyle(ink.canopy[1], 0.42); crown.fillCircle(o.x - 3, o.y - 3, radius * 0.86);
    crown.fillStyle(ink.canopy[2], 0.25); crown.fillEllipse(o.x - radius * 0.35, o.y - radius * 0.4, radius * 0.9, radius * 0.65);
  }
  const roofMembers = roofGroups(map);
  // Buildings a declared roof covers; the frame's fade step skips them as well.
  const coveredBuildingIds = new Set(map.roofs?.map(r => r.buildingId).filter(Boolean));
  // Each declared roof's appearance, and whether it is its building's primary roof (the one carrying marks).
  for (const { roof, resolved, primary } of resolveDeclaredRoofs(map, artOpts)) {
    const key = `roof:${roof.id}`;
    const overhang = roof.overhang ?? ROOF_OVERHANG;
    const left = roof.bounds.x - overhang, top = roof.bounds.y - overhang;
    const width = roof.bounds.w + overhang * 2, height = roof.bounds.h + overhang * 2;
    roofs.set(roof.id, cache.group(key, 'roof', { x: left, y: top, w: width, h: height }, priorGroups.get(key)));
    drawDeclaredRoof(cache.record(left - 2, top - 2, left + width + 2, top + height + 2, key), roof, resolved, overhang, primary, map);
  }
  for (const building of map.buildings || []) {
    if (coveredBuildingIds.has(building.id)) continue;
    const resolved = resolveBuildingAppearance(building, map.appearance, artOpts);
    const key = `roof:${building.id}`, o = roofOverhang(building, roofMembers.get(building.id) || [building]);
    // The roof overhangs its walls, except along an edge it shares with another room of its group.
    const left = building.x - o.w, top = building.y - o.n, width = building.w + o.w + o.e, height = building.h + o.n + o.s;
    roofs.set(building.id, cache.group(key, 'roof', { x: left, y: top, w: width, h: height }, priorGroups.get(key)));
    const roof = cache.record(left - 2, top - 2, left + width + 2, top + height + 2, key);
    roof.fillStyle(resolved.roofEave); roof.fillRoundedRect(left + 2, top + 2, width - 4, height - 4, 5);
    roof.lineStyle(4, resolved.roofRim); roof.strokeRoundedRect(left + 4, top + 4, width - 8, height - 8, 4);
    roof.fillStyle(resolved.roofFill); roof.fillRect(left + 19, top + 14, width - 38, height - 28);
    if (resolved.roofMarks.length) recordAppearanceOps(roof, resolved.roofMarks);
    roof.lineStyle(2, resolved.roofRidge); for (let y = top + 24; y < top + height - 14; y += 24) roof.lineBetween(left + 19, y, left + width - 19, y);
    roof.fillStyle(resolved.roofVent); roof.fillRect(building.x + 70, building.y + 70, 60, 40);
  }
  for (const gap of map.gaps) {
    g = cache.record(gap.x - 30, gap.y - 10, gap.x - 15, gap.y + 10);
    g.lineStyle(2, 0xd1f4cd); g.lineBetween(gap.x - 27, gap.y - 8, gap.x - 18, gap.y); g.lineBetween(gap.x - 18, gap.y, gap.x - 27, gap.y + 8);
  }
  for (const st of map.stations) {
    g = cache.record(st.x - 43, st.y - 36, st.x + 43, st.y + 36);
    g.fillStyle(0x274c57); g.fillRoundedRect(st.x - 41, st.y - 34, 82, 68, 11);
    g.lineStyle(3, 0x9bd6e6); g.strokeRoundedRect(st.x - 36, st.y - 29, 72, 58, 7);
    g.lineStyle(3, 0x9bd6e6); g.lineBetween(st.x - 12, st.y - 16, st.x - 12, st.y + 16); g.lineBetween(st.x + 12, st.y - 16, st.x + 12, st.y + 16);
    for (let y = -12; y <= 12; y += 12) g.lineBetween(st.x - 12, st.y + y, st.x + 12, st.y + y);
    label(st.x, st.y + 48, 'TRANSIT', '#24483e', 10);
  }
  const ex = map.exit;
  for (const st of map.chargers || []) {
    g = cache.record(st.x - 37, st.y - 32, st.x + 37, st.y + 32);
    g.fillStyle(0x273947); g.fillRoundedRect(st.x - 35, st.y - 30, 70, 60, 8);
    g.lineStyle(3, 0xffe98a); g.strokeRoundedRect(st.x - 30, st.y - 25, 60, 50, 6);
    g.fillStyle(0xffe98a); g.fillTriangle(st.x + 4, st.y - 19, st.x - 11, st.y + 2, st.x + 6, st.y + 2);
    g.fillTriangle(st.x - 4, st.y + 19, st.x + 11, st.y - 2, st.x - 6, st.y - 2);
    label(st.x, st.y + 45, 'CHARGE CELL · E', '#ffe98a', 11);
  }
  // The waiting area before a match (#236) has no exit and no entry to mark.
  if (ex) {
    g = cache.record(ex.x - 46, ex.y - 44, ex.x + 46, ex.y + 44);
    g.fillStyle(0x264f42); g.fillRoundedRect(ex.x - 44, ex.y - 42, 88, 84, 12);
    g.lineStyle(4, 0xe6f59e); g.strokeRoundedRect(ex.x - 38, ex.y - 36, 76, 72, 8);
    g.lineStyle(6, 0xe6f59e); g.lineBetween(ex.x - 12, ex.y, ex.x + 14, ex.y); g.lineBetween(ex.x + 3, ex.y - 12, ex.x + 15, ex.y); g.lineBetween(ex.x + 15, ex.y, ex.x + 3, ex.y + 12);
    label(ex.x, ex.y - 60, 'LAST EXIT', '#e6f3a1', 14);
    label(map.entry?.x || 340, (map.entry?.y || map.height / 2) - 70, 'CONTESTANT ENTRY', '#b4d6cf', 12);
  }
  return { roofs, roofMembers, coveredBuildingIds, buildingsById };
}

/** A declared roof (`map.roofs`): its cells, the overhang along exposed edges, rims, marks and ridges. */
function drawDeclaredRoof(g, roof, resolved, overhang, primary, map) {
  for (const c of roof.cells) {
    const cx0 = roof.origin.x + c.x * roof.cellSize;
    const cy0 = roof.origin.y + c.y * roof.cellSize;
    const cx1 = cx0 + roof.cellSize;
    const cy1 = cy0 + roof.cellSize;

    const b = roofCellBorders(roof, c, map);

    const nwCorner = b.w.exposed.some(s => s.start <= cy0 + 1) && b.n.exposed.some(s => s.start <= cx0 + 1);
    const neCorner = b.e.exposed.some(s => s.start <= cy0 + 1) && b.n.exposed.some(s => s.end >= cx1 - 1);
    const swCorner = b.w.exposed.some(s => s.end >= cy1 - 1) && b.s.exposed.some(s => s.start <= cx0 + 1);
    const seCorner = b.e.exposed.some(s => s.end >= cy1 - 1) && b.s.exposed.some(s => s.end >= cx1 - 1);

    g.fillStyle(resolved.roofEave);
    g.fillRect(cx0, cy0, roof.cellSize, roof.cellSize);
    for (const seg of b.w.exposed) g.fillRect(cx0 - overhang, seg.start, overhang, seg.end - seg.start);
    for (const seg of b.e.exposed) g.fillRect(cx1, seg.start, overhang, seg.end - seg.start);
    for (const seg of b.n.exposed) g.fillRect(seg.start, cy0 - overhang, seg.end - seg.start, overhang);
    for (const seg of b.s.exposed) g.fillRect(seg.start, cy1, seg.end - seg.start, overhang);
    if (nwCorner) g.fillRect(cx0 - overhang, cy0 - overhang, overhang, overhang);
    if (neCorner) g.fillRect(cx1, cy0 - overhang, overhang, overhang);
    if (swCorner) g.fillRect(cx0 - overhang, cy1, overhang, overhang);
    if (seCorner) g.fillRect(cx1, cy1, overhang, overhang);

    g.fillStyle(resolved.roofFill);
    g.fillRect(cx0, cy0, roof.cellSize, roof.cellSize);
    const inExt = Math.max(0, overhang - 4);
    for (const seg of b.w.exposed) g.fillRect(cx0 - inExt, seg.start, inExt, seg.end - seg.start);
    for (const seg of b.e.exposed) g.fillRect(cx1, seg.start, inExt, seg.end - seg.start);
    for (const seg of b.n.exposed) g.fillRect(seg.start, cy0 - inExt, seg.end - seg.start, inExt);
    for (const seg of b.s.exposed) g.fillRect(seg.start, cy1, seg.end - seg.start, inExt);
    if (nwCorner) g.fillRect(cx0 - inExt, cy0 - inExt, inExt, inExt);
    if (neCorner) g.fillRect(cx1, cy0 - inExt, inExt, inExt);
    if (swCorner) g.fillRect(cx0 - inExt, cy1, inExt, inExt);
    if (seCorner) g.fillRect(cx1, cy1, inExt, inExt);

    g.lineStyle(4, resolved.roofRim);
    for (const seg of b.w.exposed) {
      const y0 = seg.start - (seg.start <= cy0 + 1 && nwCorner ? overhang : 0);
      const y1 = seg.end + (seg.end >= cy1 - 1 && swCorner ? overhang : 0);
      g.lineBetween(cx0 - overhang, y0, cx0 - overhang, y1);
      if (seg.start > cy0 + 1) g.lineBetween(cx0 - overhang, seg.start, cx0, seg.start);
      if (seg.end < cy1 - 1) g.lineBetween(cx0 - overhang, seg.end, cx0, seg.end);
    }
    for (const seg of b.e.exposed) {
      const y0 = seg.start - (seg.start <= cy0 + 1 && neCorner ? overhang : 0);
      const y1 = seg.end + (seg.end >= cy1 - 1 && seCorner ? overhang : 0);
      g.lineBetween(cx1 + overhang, y0, cx1 + overhang, y1);
      if (seg.start > cy0 + 1) g.lineBetween(cx1, seg.start, cx1 + overhang, seg.start);
      if (seg.end < cy1 - 1) g.lineBetween(cx1, seg.end, cx1 + overhang, seg.end);
    }
    for (const seg of b.n.exposed) {
      const x0 = seg.start - (seg.start <= cx0 + 1 && nwCorner ? overhang : 0);
      const x1 = seg.end + (seg.end >= cx1 - 1 && neCorner ? overhang : 0);
      g.lineBetween(x0, cy0 - overhang, x1, cy0 - overhang);
      if (seg.start > cx0 + 1) g.lineBetween(seg.start, cy0 - overhang, seg.start, cy0);
      if (seg.end < cx1 - 1) g.lineBetween(seg.end, cy0 - overhang, seg.end, cy0);
    }
    for (const seg of b.s.exposed) {
      const x0 = seg.start - (seg.start <= cx0 + 1 && swCorner ? overhang : 0);
      const x1 = seg.end + (seg.end >= cx1 - 1 && seCorner ? overhang : 0);
      g.lineBetween(x0, cy1 + overhang, x1, cy1 + overhang);
      if (seg.start > cx0 + 1) g.lineBetween(seg.start, cy1, seg.start, cy1 + overhang);
      if (seg.end < cx1 - 1) g.lineBetween(seg.end, cy1, seg.end, cy1 + overhang);
    }
  }
  if (resolved.roofMarks.length && primary) recordAppearanceOps(g, resolved.roofMarks);

  g.lineStyle(2, resolved.roofRidge);
  for (let ry = roof.bounds.y + 12; ry < roof.bounds.y + roof.bounds.h - 10; ry += 24) {
    for (const c of roof.cells) {
      const cy0 = roof.origin.y + c.y * roof.cellSize;
      if (ry >= cy0 && ry < cy0 + roof.cellSize) {
        const cx0 = roof.origin.x + c.x * roof.cellSize;
        g.lineBetween(cx0 + 4, ry, cx0 + roof.cellSize - 4, ry);
      }
    }
  }
}

/** One obstacle in `ink`, styled by its appearance when it or the map carries one. */
export function drawObstacle(g, o, ink, mapAppearance, artOpts) {
  const buildingsById = artOpts.buildingsById;
  const styled = Boolean(mapAppearance || o?.appearance || (o?.buildingId && buildingsById?.get(o.buildingId)?.appearance));
  const resolved = styled ? resolveObstacleAppearance(o, mapAppearance, artOpts) : null;
  // Generated geometry is drawn from the very description the simulation collides with, so a new
  // shape needs no matching renderer branch and cannot be drawn as something other than its body.
  if (o.points?.length) {
    const points = outline(shapeOf(o));
    g.fillStyle(ink.shadow, 0.3); g.fillPoints(points.map(p => ({ x: p.x + 5, y: p.y + 8 })), true);
    g.fillStyle(resolved ? resolved.fill : obstacleFill(o, ink)); g.fillPoints(points, true);
    g.lineStyle(3, resolved ? resolved.outline : ink.outline); g.strokePoints(points, true);
    g.lineStyle(2, 0xffffff, 0.22); g.strokePoints(points, true);
    return;
  }
  if (o.kind === 'window') {
    const fill = resolved ? resolved.fill : ink.glass;
    const edge = resolved ? resolved.outline : ink.glassEdge;
    g.fillStyle(fill, 0.65); g.fillRect(o.x, o.y, o.w, o.h);
    g.lineStyle(2, edge); g.strokeRect(o.x, o.y, o.w, o.h);
    // Specular graphic reflection highlights (11.1 §6, 29.4)
    const alongX = o.w >= o.h;
    g.lineStyle(2, 0xffffff, 0.28);
    if (alongX && o.w >= 16) {
      const sx = o.x + Math.round(o.w * 0.22);
      g.lineBetween(sx - 4, o.y + o.h - 2, sx + 4, o.y + 2);
      g.lineBetween(sx + 2, o.y + o.h - 2, sx + 10, o.y + 2);
    } else if (!alongX && o.h >= 16) {
      const sy = o.y + Math.round(o.h * 0.22);
      g.lineBetween(o.x + 2, sy + 4, o.x + o.w - 2, sy - 4);
      g.lineBetween(o.x + 2, sy + 10, o.x + o.w - 2, sy + 2);
    }
    return;
  }
  const drawFocalRim = () => {
    if (!resolved?.focalRim) return;
    g.lineStyle(3, resolved.focalRim.color, resolved.focalRim.alpha);
    if (o.r) {
      const angles = { N: [Math.PI * 1.25, Math.PI * 1.75], S: [Math.PI * 0.25, Math.PI * 0.75], W: [Math.PI * 0.75, Math.PI * 1.25], E: [-Math.PI * 0.25, Math.PI * 0.25] };
      const [start, end] = angles[resolved.focalRim.side || 'N'] || angles.N;
      g.beginPath(); g.arc(o.x, o.y, o.r, start, end); g.strokePath();
      return;
    }
    if (resolved.focalRim.side === 'N') g.lineBetween(o.x + 2, o.y + 1, o.x + o.w - 2, o.y + 1);
    else if (resolved.focalRim.side === 'S') g.lineBetween(o.x + 2, o.y + o.h - 1, o.x + o.w - 2, o.y + o.h - 1);
    else if (resolved.focalRim.side === 'W') g.lineBetween(o.x + 1, o.y + 2, o.x + 1, o.y + o.h - 2);
    else if (resolved.focalRim.side === 'E') g.lineBetween(o.x + o.w - 1, o.y + 2, o.x + o.w - 1, o.y + o.h - 2);
  };
  if (o.kind === 'pipe') {
    const pipeFill = resolved ? resolved.fill : ink.pipe;
    g.fillStyle(ink.shadow, 0.3); g.fillRect(o.x + 3, o.y + 4, o.w, o.h);
    g.fillStyle(pipeFill); g.fillRect(o.x, o.y, o.w, o.h);
    g.lineStyle(2, ink.pipeEdge, 0.6); o.w > o.h ? g.lineBetween(o.x, o.y + 2, o.x + o.w, o.y + 2) : g.lineBetween(o.x + 2, o.y, o.x + 2, o.y + o.h);
    drawFocalRim();
    return;
  }
  if (o.kind === 'hedge') {
    const hedgeFill = resolved ? resolved.fill : ink.hedge;
    const hedgeEdge = resolved ? (resolved.hedgeEdge ?? ink.hedgeEdge) : ink.hedgeEdge;
    g.fillStyle(ink.shadow, 0.3); g.fillRect(o.x + 3, o.y + 4, o.w, o.h);
    g.fillStyle(hedgeFill); g.fillRect(o.x, o.y, o.w, o.h);
    g.lineStyle(2, hedgeEdge, 0.7); g.strokeRect(o.x, o.y, o.w, o.h);
    drawFocalRim();
    return;
  }
  if (o.kind === 'ruin-wall') {
    const ruinFill = resolved ? resolved.fill : ink.ruin;
    const ruinEdge = resolved ? (resolved.ruinEdge ?? ink.ruinEdge) : ink.ruinEdge;
    g.fillStyle(ink.ruinShadow); g.fillRect(o.x + 5, o.y + 6, o.w, o.h);
    g.fillStyle(ruinFill); g.fillRect(o.x, o.y, o.w, o.h);
    g.lineStyle(2, ruinEdge); g.lineBetween(o.x + 2, o.y + 2, o.x + o.w - 2, o.y + 2);
    drawFocalRim();
    return;
  }
  if (o.r) {
    g.fillStyle(ink.circleShadow, 0.25); g.fillCircle(o.x + 6, o.y + 8, o.r + 2);
    if (o.kind === 'tree') {
      const trunkFill = resolved ? resolved.fill : ink.trunk;
      const trunkTop = resolved ? (resolved.trunkTop ?? mix(trunkFill, 0xffffff, 0.25)) : ink.trunkTop;
      g.fillStyle(trunkFill); g.fillCircle(o.x, o.y, o.r);
      g.fillStyle(trunkTop); g.fillCircle(o.x - o.r * 0.18, o.y - o.r * 0.2, o.r * 0.54);
      drawFocalRim();
    } else {
      const rockFill = resolved ? resolved.fill : ink.rock;
      g.fillStyle(rockFill); g.fillCircle(o.x, o.y, o.r);
      g.fillStyle(ink.rockMid); g.fillCircle(o.x - 3, o.y - 4, o.r - 5);
      g.fillStyle(ink.rockTop); g.fillEllipse(o.x - 8, o.y - 9, o.r * 0.9, o.r * 0.65);
    }
    return;
  }
  g.fillStyle(ink.shadow, 0.3); g.fillRoundedRect(o.x + 5, o.y + 8, o.w, o.h, 6);
  const fill = resolved ? resolved.fill : obstacleFill(o, ink);
  const outlineColor = resolved ? resolved.outline : ink.outline;
  g.fillStyle(outlineColor); g.fillRoundedRect(o.x - 2, o.y - 2, o.w + 4, o.h + 4, 6);
  g.fillStyle(fill); g.fillRoundedRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2, 4);
  g.lineStyle(3, 0xffffff, 0.22); g.lineBetween(o.x + 7, o.y + 7, o.x + o.w - 7, o.y + 7);
  if (o.kind === 'fence') {
    for (let y = o.y + 12; y < o.y + o.h - 6; y += 23) { g.lineStyle(2, ink.fenceLine); g.lineBetween(o.x + 3, y, o.x + o.w - 3, y); }
    drawFocalRim();
  } else if (o.kind === 'building') {
    g.fillStyle(resolved ? resolved.wallInset : ink.wallInset); g.fillRoundedRect(o.x + o.w * 0.25, o.y + o.h * 0.25, o.w * 0.5, o.h * 0.5, 4);
    g.lineStyle(2, resolved ? resolved.wallLine : ink.wallLine); g.lineBetween(o.x + 10, o.y + o.h - 12, o.x + o.w - 10, o.y + o.h - 12);
    drawFocalRim();
  } else {
    g.lineStyle(2, ink.crateLine, 0.3); for (let x = o.x + 13; x < o.x + o.w - 5; x += 16) g.lineBetween(x, o.y + 11, x, o.y + o.h - 7);
    drawFocalRim();
  }
}

/** A door or window marking on the ground outside a building wall. */
export function drawDecal(g, d) {
  // Drawn in the decal's own frame: `u` runs along its wall, `v` away from the building.
  const along = d.side === 'N' || d.side === 'S', length = along ? d.w : d.h, depth = along ? d.h : d.w;
  const at = (u, v) => d.side === 'S' ? { x: d.x + u, y: d.y + v } : d.side === 'N' ? { x: d.x + u, y: d.y + d.h - v }
    : d.side === 'E' ? { x: d.x + v, y: d.y + u } : { x: d.x + d.w - v, y: d.y + u };
  const quad = (u0, v0, u1, v1) => [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
  // A window lets light out onto the ground; it is fainter than a door's step in every theme.
  if (d.marks === 'window') {
    const tint = { hut: 0x9c8a62, depot: 0xc9d1d4, compound: 0x9a958a }[d.theme] ?? 0xb7bdb4;
    g.fillStyle(tint, 0.22); g.fillPoints(quad(0, 0, length, depth), true);
    g.fillStyle(tint, 0.2); g.fillPoints(quad(length * 0.15, 0, length * 0.85, depth * 0.7), true);
    return;
  }
  if (d.theme === 'hut') {
    // A worn dirt path, widening as it leaves the door.
    g.fillStyle(0x6b5a44, 0.6); g.fillPoints([at(3, 0), at(length - 3, 0), at(length, depth), at(0, depth)], true);
    g.fillStyle(0x87724f, 0.35); g.fillPoints([at(length * 0.3, 0), at(length * 0.7, 0), at(length * 0.75, depth - 3), at(length * 0.25, depth - 3)], true);
  } else if (d.theme === 'depot') {
    // Hazard stripes: dark bands slanting across a yellow ground, cut to the decal.
    g.fillStyle(0xe6b357, 0.7); g.fillPoints(quad(0, 0, length, depth), true);
    g.fillStyle(0x2b2a26, 0.75);
    const slant = depth * 0.6, band = 6;
    for (let u = -slant; u < length; u += band * 2) {
      const clip = x => Math.max(0, Math.min(length, x));
      g.fillPoints([at(clip(u), 0), at(clip(u + band), 0), at(clip(u + band + slant), depth), at(clip(u + slant), depth)], true);
    }
  } else if (d.theme === 'compound') {
    // A stone step with a darker lip at its outer edge.
    g.fillStyle(0x8d8a80, 0.85); g.fillPoints(quad(0, 0, length, depth), true);
    g.fillStyle(0x4e4b45, 0.85); g.fillPoints(quad(0, depth - 3, length, depth), true);
    g.fillStyle(0xbfbab0, 0.35); g.fillPoints(quad(2, 2, length - 2, 4), true);
  } else {
    g.fillStyle(0xa3a89e, 0.38); g.fillPoints(quad(0, 0, length, depth), true);
  }
}
