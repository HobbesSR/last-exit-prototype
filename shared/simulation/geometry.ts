import { TILE } from '../movement.ts';
import type { TileIndex, TilePoint, Vec2, World } from '../types.ts';

export const distance = (a: Vec2, b: Vec2): World => Math.hypot(a.x - b.x, a.y - b.y);
/** World point to the navigation tile containing it. */
export const tile = (p: Vec2): TilePoint => ({ x: Math.floor(p.x / TILE) as TileIndex, y: Math.floor(p.y / TILE) as TileIndex });
/** Navigation tile to the world point at its centre. */
export const center = (x: TileIndex, y: TileIndex): Vec2 => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });
