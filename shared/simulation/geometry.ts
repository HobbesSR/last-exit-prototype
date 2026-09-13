import { TILE } from '../movement.ts';
import type { TileIndex, TilePoint, Vec2 } from '../types.ts';

export { distance } from '../vector.ts';
/** World point to the navigation tile containing it. */
export const tile = (p: Vec2): TilePoint => ({ x: Math.floor(p.x / TILE) as TileIndex, y: Math.floor(p.y / TILE) as TileIndex });
/** Navigation tile to the world point at its centre. */
export const center = (x: TileIndex, y: TileIndex): Vec2 => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });
