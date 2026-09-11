import { canOccupy } from '../shared/movement.js';

// Benchmark-only arrangement: keep the observer still and compare identical actors with/without AI.
export function arrangeCrowd(game, playerId, { location, ai = true }) {
  const me = game.players.find(p => p.id === playerId);
  const center = { x: game.map.width / 2, y: game.map.height / 2 };
  const node = game.map.nodes.reduce((best, n) => Math.hypot(n.x - center.x, n.y - center.y) < Math.hypot(best.x - center.x, best.y - center.y) ? n : best);
  Object.assign(me, { x: node.x, y: node.y, shield: 1000000, input: {} });
  const target = location === 'offscreen' ? { x: node.x + 1200, y: node.y } : node;
  const occupied = [me];
  for (const [index, p] of game.players.filter(p => p !== me).entries()) {
    let placed = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const angle = (index * 41 + attempt) * 2.39996, radius = 40 + Math.floor(attempt / 12) * 20;
      const point = { x: target.x + Math.cos(angle) * radius, y: target.y + Math.sin(angle) * radius };
      if (!canOccupy(game.map, point.x, point.y, 25) || occupied.some(q => Math.hypot(q.x - point.x, q.y - point.y) < 65)) continue;
      Object.assign(p, point, { bot: ai, shield: 1000000, input: {}, path: [], inputTick: game.tick });
      if (p.inventory) { p.inventory.fill(null); p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 192 }; p.selectedSlot = 0; p.weapon = 1; }
      occupied.push(p); placed = true; break;
    }
    if (!placed) throw new Error('Unable to place crowd benchmark actors');
  }
  game.map.traps = []; // Isolate actor AI/render work from autonomous trap activation.
  return { location, ai, stationary: true, actors: game.players.length, seed: game.seed, observer: { x: me.x, y: me.y } };
}
