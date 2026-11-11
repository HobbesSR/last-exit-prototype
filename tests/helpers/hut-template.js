import { rect } from '../../shared/shape.ts';

const WALL = 18;

/**
 * One room, two north windows and a south door: the street generator's starting shelter, kept as a
 * fixture for `placeElement` when #920 retired that generator and its catalogue. Part order is what
 * the tests' id expectations read (`shared/map/element.ts`).
 */
export const HUT = {
  w: 250,
  h: 250,
  encloses: true,
  parts: [
    { part: 'obstacle', shape: rect(0, 0, 65, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(65, 0, 60, WALL), kind: 'window' },
    { part: 'obstacle', shape: rect(125, 0, 60, WALL), kind: 'window' },
    { part: 'obstacle', shape: rect(185, 0, 65, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(0, WALL, WALL, 214), kind: 'building' },
    { part: 'obstacle', shape: rect(232, WALL, WALL, 214), kind: 'building' },
    { part: 'obstacle', shape: rect(0, 232, 75, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(175, 232, 75, WALL), kind: 'building' },
    { part: 'gate', x: 125, y: 241, w: 100, h: WALL },
    { part: 'spot', x: 125, y: 125 },
    { part: 'reserve', x: -30, y: -30, w: 310, h: 350 },
  ],
};
