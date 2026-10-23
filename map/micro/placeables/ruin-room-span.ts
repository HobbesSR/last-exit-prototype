import { rect } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `ruin-room-span`: one surviving wall cell of a roofless room. `ruins` chooses each room,
 * doorway, decay roll, and the cells it can safely occupy.
 */
export interface RuinRoomSpanParams { side: 'north' | 'east' | 'south' | 'west' }
const WALL = 0.25;

export const RUIN_ROOM_SPAN = Object.freeze<Placeable<RuinRoomSpanParams>>({
  id: 'ruin-room-span', version: 'ruin-room-span-1',
  summary: 'One surviving wall cell of a roofless room.',
  params: [{ name: 'side', summary: 'Room side carrying the wall.', kind: 'enum', values: ['north', 'east', 'south', 'west'] }],
  examples: [{ side: 'north' }, { side: 'east' }, { side: 'south' }, { side: 'west' }],
  build({ side }, cellSize) {
    const t = WALL * cellSize;
    const shape = side === 'north' ? rect(0, 0, cellSize, t)
      : side === 'south' ? rect(0, cellSize - t, cellSize, t)
      : side === 'west' ? rect(0, 0, t, cellSize) : rect(cellSize - t, 0, t, cellSize);
    return { elements: [{ x: 0, y: 0, template: { w: cellSize, h: cellSize,
      parts: [{ part: 'obstacle' as const, kind: 'ruin-wall' as const, shape }] } }],
      demand: { body: { w: 1, h: 1 }, clear: [] }, details: undefined };
  },
});
