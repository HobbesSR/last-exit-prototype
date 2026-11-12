import type { Player } from '../types.ts';

export { distance } from '../vector.ts';
/** Make a bot plan afresh: its remaining route goes, in whichever form its content plans. */
export function clearRoute(p: Pick<Player, 'path' | 'route'>): void { p.path = []; if (p.route) p.route = []; }
