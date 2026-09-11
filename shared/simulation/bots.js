import PF from 'pathfinding';
import { canOccupy, lineClear, reachClear, TILE } from '../movement.js';
import { navigationGrid, blockAt, blockRoute } from '../map.js';
import { count, start, stop } from '../profiler.js';
import { WEAPONS, carriedCell, syncWeapon } from '../equipment.js';
import { HZ, CELL_CHARGE_TICKS } from './rules.js';
import { distance, tile, center } from './geometry.js';
import { visibleTo } from './visibility.js';
import { attack } from './combat.js';
import { dropEquipment } from './loot.js';
function nearestNode(matrix, point) {
  const t = tile(point);
  for (let r = 0; r < 5; r++) for (let y = t.y - r; y <= t.y + r; y++) for (let x = t.x - r; x <= t.x + r; x++) if (matrix[y]?.[x] === 0) return { x, y };
  return t;
}
export function botInput(s, p) {
  const cell = carriedCell(p);
  if (p.inventory) {
    const utility = p.inventory.findIndex(i => i && (i.kind === 'med' && p.hp < 65 || i.kind === 'shield' && p.shield < 45));
    const weapon = p.inventory.findIndex(i => i?.kind === 'weapon' && (i.ammo ?? WEAPONS[i.weaponType].ammo) > 0);
    p.selectedSlot = utility >= 0 ? utility : weapon >= 0 ? weapon : 0; syncWeapon(p);
    if (utility >= 0) attack(s, p);
  }
  // Mixed temperaments create occasional betrayal, rather than every converging bot starting
  // a deathmatch simultaneously. All bots can retaliate; roughly one third initiate disputes.
  const opportunistic = p.id.charCodeAt(p.id.length - 1) % 3 === 0;
  const nearest = s.players.filter(t => t.id !== p.id && (t.role !== p.role || p.aggressor === t.id && s.tick < p.aggressionUntil
    || p.role === 'contestant' && opportunistic && s.tick > 30 * HZ && distance(p, t) < (s.tick > 120 * HZ ? 320 : 180))
    && t.status === 'active' && visibleTo(s, p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  let target = p.role === 'gladiator' ? nearest || s.map.stations.find(st => st.x > s.hazardX + 1200) || s.map.exit : s.map.exit;
  if (p.role === 'contestant') {
    const accessible = i => p.keys > 0 || !i.buildingId || !s.map.gates.some(g => g.buildingId === i.buildingId && g.locked && !g.open);
    const objective = !cell ? s.map.items.filter(i => i.kind === 'cell' && i.x > s.hazardX + 100 && accessible(i))
      : cell.charge < CELL_CHARGE_TICKS ? s.map.chargers.filter(st => st.x > s.hazardX + 100) : [];
    if (objective.length) {
      const from = blockAt(s.map, p);
      const cost = t => blockRoute(s.map, from, blockAt(s.map, t)).length * 1000 + distance(p, t) * 0.05;
      target = objective.sort((a, b) => cost(a) - cost(b))[0];
      if (!cell && p.inventory.every(Boolean)) {
        const discard = p.inventory.findIndex(item => item.kind !== 'weapon' || item.ammo === 0);
        if (discard >= 0) { dropEquipment(s, p, p.inventory[discard]); p.inventory[discard] = null; }
      }
    }
    const loot = s.map.items.filter(i => i.kind !== 'cell' && i.x > s.hazardX + 100 && i.x >= p.x - 60 && distance(p, i) < 210 && accessible(i)
      && (i.kind !== 'med' || p.hp < 75)
      && (i.kind === 'access' || p.inventory.some(slot => !slot) || p.inventory.some(slot => slot?.kind === i.kind && (slot.count < 3 || slot.weaponType === i.weaponType && slot.ammo < WEAPONS[i.weaponType]?.maxAmmo)))
      && (i.kind !== 'weapon' || i.ammo !== 0 && !p.inventory.some(slot => slot?.weaponType === i.weaponType && slot.ammo >= WEAPONS[i.weaponType].maxAmmo))).sort((a, b) => distance(p, a) - distance(p, b))[0];
    if (loot && loot.kind !== 'cell' && !p.charging && (!nearest || distance(p, nearest) > 250)) target = loot;
  }
  if (!p.path?.length || s.tick % 20 === p.name.length % 20) {
    start('sim.repath'); count('work.repath');
    // The coarse street graph supplies the next block; local collision-aware A* handles its passage.
    const route = blockRoute(s.map, blockAt(s.map, p), blockAt(s.map, target));
    const localTarget = route.length > 1 ? route[1] : target;
    const bx = Math.max(0, Math.floor((Math.min(p.x, localTarget.x) - 600) / TILE));
    const by = Math.max(0, Math.floor((Math.min(p.y, localTarget.y) - 600) / TILE));
    const bounds = { x: bx, y: by, width: Math.min(Math.ceil((Math.max(p.x, localTarget.x) + 600) / TILE), Math.ceil(s.map.width / TILE)) - bx, height: Math.min(Math.ceil((Math.max(p.y, localTarget.y) + 600) / TILE), Math.ceil(s.map.height / TILE)) - by };
    const matrix = navigationGrid(s.map, p.role, bounds, p.keys > 0 ? 'all' : true);
    const from = nearestNode(matrix, { x: p.x - bx * TILE, y: p.y - by * TILE });
    const to = nearestNode(matrix, { x: localTarget.x - bx * TILE, y: localTarget.y - by * TILE });
    start('sim.repathGrid'); const grid = new PF.Grid(matrix); stop('sim.repathGrid');
    p.path = new PF.AStarFinder({ allowDiagonal: true, dontCrossCorners: true }).findPath(from.x, from.y, to.x, to.y, grid).slice(1).map(([x, y]) => [x + bx, y + by]);
    stop('sim.repath');
  }
  let waypoint = p.path?.[0] ? center(...p.path[0]) : target;
  if (distance(p, target) < 55 && lineClear(s.map, p, target)) waypoint = target;
  else if (distance(p, waypoint) < 11 && p.path?.length) { p.path.shift(); waypoint = p.path[0] ? center(...p.path[0]) : target; }
  let dx = waypoint.x - p.x, dy = waypoint.y - p.y;
  const hunter = p.role === 'contestant' && s.players.find(t => t.role === 'gladiator' && t.status === 'active' && distance(p, t) < 170 && visibleTo(s, p, t));
  if (hunter) {
    // Keep firing, but do not blindly follow an objective path straight into melee range.
    const away = Math.atan2(p.y - hunter.y, p.x - hunter.x);
    const goalLength = Math.max(1, Math.hypot(dx, dy));
    const options = [0, -0.5, 0.5, -1, 1, -1.5, 1.5].map(offset => {
      const x = Math.cos(away + offset), y = Math.sin(away + offset);
      const point = { x: p.x + x * 90, y: p.y + y * 90 };
      return { x, y, point, score: distance(point, hunter) + (x * dx + y * dy) / goalLength * 15 - (point.x < s.hazardX + 100 ? 1000 : 0) };
    }).filter(o => canOccupy(s.map, o.point.x, o.point.y, 12) && reachClear(s.map, p, o.point)).sort((a, b) => b.score - a.score);
    if (options.length) { dx = options[0].x * 9; dy = options[0].y * 9; }
  }
  const length = Math.max(9, Math.hypot(dx, dy));
  if (p.role === 'contestant' && cell?.charge < CELL_CHARGE_TICKS && s.map.chargers.some(st => distance(p, st) < 55 && lineClear(s.map, p, st))) return { x: 0, y: 0, interact: true };
  const allyInLine = p.role === 'contestant' && nearest && s.players.some(other => {
    if (other.id === p.id || other.id === nearest.id || other.role !== 'contestant' || other.status !== 'active') return false;
    const nx = nearest.x - p.x, ny = nearest.y - p.y, projection = ((other.x - p.x) * nx + (other.y - p.y) * ny) / (nx * nx + ny * ny);
    return projection > 0 && projection < 1 && Math.hypot(other.x - p.x - projection * nx, other.y - p.y - projection * ny) < 28;
  });
  return { x: dx / length, y: dy / length, aim: nearest ? Math.atan2(nearest.y - p.y, nearest.x - p.x) : Math.atan2(dy, dx), attack: !!nearest && !allyInLine && distance(p, nearest) < (p.role === 'gladiator' ? 86 : 450) && lineClear(s.map, p, nearest), skill: !!nearest && distance(p, nearest) < (p.kit === 'specter' && p.role === 'gladiator' ? 320 : 125), interact: p.role === 'contestant' || s.map.gates.some(g => !g.open && distance(p, g) < 85) || p.x < s.hazardX + 200 };
}
