import { polygon, rect } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `plant-machine`: a solid or chamfered industrial block. `plant` sites these on its lattice.
 */

const INSET = 0.05, CHAMFER = 0.5;
export interface PlantMachineParams { w: number; h: number; chamfered: boolean }

export const PLANT_MACHINE = Object.freeze<Placeable<PlantMachineParams>>({
  id: 'plant-machine', version: 'plant-machine-1', summary: 'A solid or chamfered industrial machine.',
  params: [
    { name: 'w', summary: 'Width in cells.', kind: 'int', min: 2, max: 4 },
    { name: 'h', summary: 'Height in cells.', kind: 'int', min: 2, max: 4 },
    { name: 'chamfered', summary: 'Cut its corners.', kind: 'boolean' },
  ],
  examples: [{ w: 2, h: 3, chamfered: false }, { w: 4, h: 4, chamfered: true }],
  build({ w, h, chamfered }, cellSize) {
    const x0 = INSET * cellSize, y0 = INSET * cellSize, x1 = (w - INSET) * cellSize, y1 = (h - INSET) * cellSize;
    const c = CHAMFER * cellSize;
    const shape = chamfered ? polygon(0, 0, [{ x: x0 + c, y: y0 }, { x: x1 - c, y: y0 }, { x: x1, y: y0 + c }, { x: x1, y: y1 - c },
      { x: x1 - c, y: y1 }, { x: x0 + c, y: y1 }, { x: x0, y: y1 - c }, { x: x0, y: y0 + c }]) : rect(x0, y0, x1 - x0, y1 - y0);
    return { elements: [{ x: 0, y: 0, template: { w: w * cellSize, h: h * cellSize,
      parts: [{ part: 'obstacle' as const, shape, kind: 'container' as const }] } }],
      demand: { body: { w, h }, clear: [] }, details: undefined };
  },
});
