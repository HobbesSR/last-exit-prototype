import { buildRegion } from '../../map/micro/region-types.ts';
import { elementShapes } from '../../map/micro/geometry.ts';
import { cellsOf } from './cells.js';
import { briefOf, SIZE } from './region-masks.js';

/** The compound fixtures that micro-compound's tests and the slow sweeps share. */
export { SIZE };
export const brief = briefOf('compound');

/** A yard just big enough, a wide field, an L, and a ring around a hole, with portals on several sides. */
export const MASKS = {
  yard: [cellsOf(17, 16), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 17, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 6, y: 16, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 7, length: 2 }]],
  field: [cellsOf(40, 34), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(40, 40, (x, y) => y < 20 || x < 20), [{ id: 'east', axis: 'v', x: 40, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 40, length: 4 },
    { id: 'corner', axis: 'h', x: 24, y: 20, length: 6 }]],
  ring: [cellsOf(46, 46, (x, y) => x < 17 || x >= 29 || y < 17 || y >= 29), [{ id: 'north', axis: 'h', x: 20, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 29, y: 20, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 34, length: 3 }]],
};
export const SEEDS = [1, 2, 3, 4];
export const PARAMETERS = [undefined, { gates: 1 }, { gates: 3 }, { gates: 4 }];

// Builds are shared across a process's sweeps, made once with the observer on: the portal, roofed,
// observer and access checks read the same build of each input. Observing changes nothing, which
// `assertObservedRing` checks against an unobserved build on the fast cases (#822).
const built = new Map();
export const observed = input => {
  const key = JSON.stringify(input);
  if (!built.has(key)) {
    const traces = [];
    built.set(key, { result: buildRegion(input, undefined, trace => traces.push(trace)), traces });
  }
  return built.get(key);
};
export const build = input => observed(input).result;
export const blockers = result => result.elements.flatMap(element => elementShapes(element));
export const ringElements = result => result.elements.filter(element => /^compound-(room|gate)/.test(element.label));
/** An element's box in cells. */
export const cellBox = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });
/** The compound's ring box in cells; delegated exterior pieces do not change it. */
export const compoundBox = result => {
  const boxes = ringElements(result).map(cellBox);
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
};
