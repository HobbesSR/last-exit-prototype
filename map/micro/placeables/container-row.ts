import type { ElementTemplate } from '../../../shared/map/element.ts';
import { oriented } from './frame.ts';
import type { Placeable } from './placeable.ts';

/*
 * `container-row`: shipping containers end to end, each 2 cells long and a cell across. `depot`
 * packs its lanes with them.
 */

/** A container's length in cells. */
const CONTAINER = 2;

export interface ContainerRowParams {
  /** The row's length in cells, a whole number of containers. */
  length: number;
  /** Whether the row runs along x rather than y. */
  alongX: boolean;
}

export const CONTAINER_ROW = Object.freeze<Placeable<ContainerRowParams>>({
  id: 'container-row',
  version: 'container-row-1',
  summary: 'Containers end to end, each a little inside its 2 by 1 cells.',
  params: [
    { name: 'length', summary: 'Length in cells, 2 a container.', kind: 'int', min: CONTAINER, max: 32 },
    { name: 'alongX', summary: 'Runs along x rather than y.', kind: 'boolean' },
  ],
  check: ({ length }: ContainerRowParams) => length % CONTAINER ? [`container-row length must be a multiple of ${CONTAINER}.`] : [],
  examples: [{ length: 4, alongX: true }, { length: 6, alongX: false }],
  build({ length, alongX }: ContainerRowParams, cellSize: number) {
    const box = oriented(cellSize, alongX), parts: ElementTemplate['parts'] = [];
    for (let u = 0; u < length; u += CONTAINER)
      parts.push({ part: 'obstacle', shape: box(u + 0.05, 0.05, CONTAINER - 0.1, 0.9), kind: 'container' });
    const body = alongX ? { w: length, h: 1 } : { w: 1, h: length };
    return { elements: [{ x: 0, y: 0, template: { w: body.w * cellSize, h: body.h * cellSize, parts } }], demand: { body, clear: [] }, details: undefined };
  },
});
