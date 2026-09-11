import { canOccupy } from '../movement.js';
import { WORLD_WIDTH } from './world.js';
import { distance } from './context.js';

export function buildObjectives(context) {
  const { map, entryNode, main, place, occupied, spots, range, nextId } = context;
  // One easy starter weapon per separated spawn.
  for (const spawn of map.spawns) place(spawn.x + 40, spawn.y, 'weapon', { weaponType: 'pistol' });
  place(entryNode.x - 100, entryNode.y + 240, 'access'); place(entryNode.x + 100, entryNode.y + 240, 'access');
  for (const [i, n] of main.entries()) if (i > 3 && i < main.length - 3 && i % 6 === 0) {
    const station = { id: nextId('rail-'), x: n.x, y: n.y, nodeId: n.id }; map.stations.push(station); occupied.push(station);
  }
  map.stations.sort((a, b) => a.x - b.x || a.y - b.y);
  for (const index of [10, 20, 30]) if (main[index]) { const n = main[index]; map.sensors.push({ id: nextId('sensor-'), x: n.x + 80, y: n.y - 80 }); }
  // Put objective choices in upper and lower neighborhoods rather than on one centerline.
  const objectiveNodes = map.nodes.filter(n => n.x > WORLD_WIDTH * 0.18 && n.x < WORLD_WIDTH * 0.75);
  for (const [i, n] of objectiveNodes.entries()) if (i % 9 === 0) {
    const charger = { id: nextId('charger-'), x: n.x - 130, y: n.y + 100, nodeId: n.id };
    if (canOccupy(map, charger.x, charger.y, 30) && occupied.every(o => distance(o, charger) > 90)) { map.chargers.push(charger); occupied.push(charger); }
  }
  for (const [i, spot] of spots.entries()) {
    if (!spot.buildingId && distance(spot, entryNode) < 800 || !canOccupy(map, spot.x, spot.y, 24)) continue;
    const kind = spot.buildingId ? (i % 3 === 0 ? 'cell' : 'weapon') : i % 7 === 0 ? 'cell' : ['weapon', 'med', 'shield', 'access'][range(0, 3)];
    place(spot.x, spot.y, kind, { ...(kind === 'weapon' ? { weaponType: ['pistol', 'rifle', 'scattergun'][range(0, 2)] } : {}), ...(spot.buildingId ? { buildingId: spot.buildingId } : {}) });
  }
  // Add early outdoor cells, so finding a building is a choice, not an undocumented prerequisite.
  for (const n of main.slice(1, 5)) place(n.x - 120, n.y + 100, 'cell');
  for (const [i, n] of map.nodes.entries()) if (i % 11 === 0 && distance(n, entryNode) > 2500) {
    const point = { x: n.x + 130, y: n.y + 100 };
    if (!canOccupy(map, point.x, point.y, 25) || occupied.some(o => distance(o, point) < 100) || map.chargers.some(st => distance(st, point) < 850)) continue;
    const kind = ['mine', 'turret', 'flame', 'spider'][range(0, 3)];
    map.traps.push({ id: nextId('trap-'), kind, ...point, homeX: point.x, homeY: point.y, heading: -Math.PI / 2, offset: range(0, 159), cooldown: 35, spent: false }); occupied.push(point);
  }
}
