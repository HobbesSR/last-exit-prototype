import { rect } from '../../../shared/shape.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type { Placeable } from './placeable.ts';

/*
 * `example-room-shell`: a roofed room with one south door, a north window and optional
 * shelves. The SDK example builders `open`, `depot`, and `courtyard` choose its site.
 */
const WALL = 18;
export interface ExampleRoomShellParams { w: number; h: number; shelves: boolean; door: number }

export const EXAMPLE_ROOM_SHELL = Object.freeze<Placeable<ExampleRoomShellParams>>({
  id: 'example-room-shell', version: 'example-room-shell-1',
  summary: 'A roofed example room with a south doorway and optional shelves.',
  params: [
    { name: 'w', summary: 'Room width in world units.', kind: 'int', min: 200, max: 1000 },
    { name: 'h', summary: 'Room height in world units.', kind: 'int', min: 180, max: 1000 },
    { name: 'shelves', summary: 'Add two shelf islands.', kind: 'boolean' },
    { name: 'door', summary: 'South doorway width in world units.', kind: 'number', min: 1, max: 500 },
  ],
  check: ({ w, door }) => door > w ? ['The doorway must fit across the room.'] : [],
  examples: [
    { w: 280, h: 220, shelves: false, door: 80 },
    { w: 360, h: 280, shelves: true, door: 80 },
  ],
  build({ w, h, shelves, door }, cellSize) {
    const DOOR = door;
    const doorX = Math.round(w / 2);
    const left = Math.round((w - DOOR) / 2);
    const parts: ElementTemplate['parts'] = [
      { part: 'obstacle', shape: rect(0, 0, Math.round(w * .28), WALL), kind: 'building' },
      { part: 'obstacle', shape: rect(Math.round(w * .28), 0, Math.round(w * .3), WALL), kind: 'window' },
      { part: 'obstacle', shape: rect(Math.round(w * .58), 0, w - Math.round(w * .58), WALL), kind: 'building' },
      { part: 'obstacle', shape: rect(0, WALL, WALL, h - WALL), kind: 'building' },
      { part: 'obstacle', shape: rect(w - WALL, WALL, WALL, h - WALL), kind: 'building' },
      { part: 'obstacle', shape: rect(0, h - WALL, left, WALL), kind: 'building' },
      { part: 'obstacle', shape: rect(left + DOOR, h - WALL, w - left - DOOR, WALL), kind: 'building' },
      { part: 'gate', x: doorX, y: h - WALL / 2, w: DOOR, h: WALL },
      { part: 'spot', x: Math.round(w * .28), y: Math.round(h * .35) },
      { part: 'spot', x: Math.round(w * .72), y: Math.round(h * .58) },
    ];
    if (shelves) {
      const leftShelfH = Math.max(36, h - 176), rightShelfH = Math.max(36, h - 206);
      parts.splice(7, 0,
        { part: 'obstacle', shape: rect(58, 82, 46, leftShelfH), kind: 'container' },
        { part: 'obstacle', shape: rect(w - 104, 112, 46, rightShelfH), kind: 'container' });
    }
    return { elements: [{ x: 0, y: 0, template: { w, h, encloses: true, parts } }],
      demand: { body: { w: w / cellSize, h: h / cellSize }, clear: [] }, details: undefined };
  },
});
