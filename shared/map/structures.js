import { BLOCK_SIZE } from './world.js';
import { distance } from './context.js';

export function buildStructures(context) {
  const { map, entryNode, exitNode, lookup, reserve, reservations, clearFootprint, spots, range, rect, nextId } = context;
  for (const n of map.nodes) reserve(n.x, n.y, 110);
  reserve(entryNode.x, entryNode.y, 490); reserve(exitNode.x, exitNode.y, 300);
  // Spread contestants across four nearby connected blocks, rather than a single firing line.
  const startBlocks = [entryNode];
  for (let i = 0; i < startBlocks.length && startBlocks.length < 4; i++) for (const id of startBlocks[i].neighbors) {
    const n = lookup.get(id);
    if (!startBlocks.includes(n)) startBlocks.push(n);
    if (startBlocks.length === 4) break;
  }
  map.spawns = startBlocks.flatMap(n => [-200, 200].map(dy => ({ x: n.x - 100, y: n.y + dy })));
  for (const p of map.spawns) reserve(p.x, p.y, 165);
  for (const st of map.streets) {
    // Keep all center-to-port approaches free of props and building footprints.
    for (const a of [st.a, st.b]) {
      const steps = Math.ceil(distance(a, st.port) / 80);
      for (let i = 0; i <= steps; i++) reserve(a.x + (st.port.x - a.x) * i / steps, a.y + (st.port.y - a.y) * i / steps, 85);
    }
  }
  for (const [index, n] of map.nodes.entries()) {
    const kind = ['yard', 'depot', 'garden'][range(0, 2)];
    const module = { id: index, x: n.x, y: n.y, width: BLOCK_SIZE, height: BLOCK_SIZE, kind }; map.modules.push(module);
    const corners = [[-390, -390], [140, -390], [-390, 140], [140, 140]];
    for (const [i, [dx, dy]] of corners.entries()) {
      const box = { x: n.x + dx, y: n.y + dy, w: 250, h: 250 };
      if (!clearFootprint(box)) continue;
      if (i === index % 4 && index % 2 === 0) {
        const building = { id: nextId('building-'), ...box, nodeId: n.id }; map.buildings.push(building);
        // Door in south wall; two north-facing windows admit sight and bullets, never bodies.
        const extra = { buildingId: building.id };
        rect(box.x, box.y, 65, 18, 'building', extra);
        rect(box.x + 65, box.y, 60, 18, 'window', extra);
        rect(box.x + 125, box.y, 60, 18, 'window', extra);
        rect(box.x + 185, box.y, 65, 18, 'building', extra);
        rect(box.x, box.y + 18, 18, 214, 'building', extra); rect(box.x + 232, box.y + 18, 18, 214, 'building', extra);
        rect(box.x, box.y + 232, 75, 18, 'building', extra); rect(box.x + 175, box.y + 232, 75, 18, 'building', extra);
        map.gates.push({ id: nextId('door-'), x: box.x + 125, y: box.y + 241, w: 100, h: 18, open: false, locked: index % 10 === 0, kind: 'door', buildingId: building.id });
        spots.push({ x: box.x + 125, y: box.y + 125, nodeId: n.id, buildingId: building.id });
        reservations.push({ x: box.x - 30, y: box.y - 30, w: 310, h: 350 });
      } else {
        const prop = { x: box.x + range(0, 90), y: box.y + range(0, 90), w: range(65, 140), h: range(65, 140) };
        if (clearFootprint(prop)) rect(prop.x, prop.y, prop.w, prop.h, kind === 'depot' ? 'container' : 'crate', { color: index % 3 });
      }
    }
    // Loot courtyard is in a different quarter than the through-route center.
    spots.push({ x: n.x + 220, y: n.y - 220, nodeId: n.id });
  }
}
