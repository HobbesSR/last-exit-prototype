import { TILE } from '../movement.js';
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const tile = p => ({ x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) });
export const center = (x, y) => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });
