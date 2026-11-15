import type { Player } from '../types.ts';

export { distance } from '../vector.ts';
/** Make a bot plan afresh: its remaining route goes. */
export function clearRoute(p: Pick<Player, 'route'>): void { if (p.route) p.route = []; }
