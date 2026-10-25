// One thrown-object profile, exercised in bounded synthetic scenes. No game imports.
import { PROFILE, createThrow, stepThrow, displayThrow } from './ballistics.mjs';

export const scene = (obstacles = [], extra = {}) => ({ groundPlaneId: 'lab-ground',
  bounds: { x: 0, y: 0, w: 200, h: 100 }, holes: [], obstacles, ...extra });
const box = (id, zMin, zMax, x = 60, w = 8) => ({ id, x, y: 40, w, h: 20, zMin, zMax });

export function witnessSetups() {
  const window = [box('sill', 0, 12), box('lintel', 40, 80)];
  return [
    { name: 'low-cover', scene: scene([box('low', 0, 20)]), initial: {} },
    { name: 'tall-cover', scene: scene([box('tall', 0, 80)]), initial: {} },
    // Planar overlap starts before z reaches the slab; both tick endpoints miss it.
    { name: 'height-crossing-in-tick', scene: scene([box('slab', 10, 11, 25, 2)]),
      initial: { x: 20, z: 20, vx: 400, vz: -400 } },
    { name: 'landing', scene: scene(), initial: { z: 1, vz: -15, bounces: 1 } },
    { name: 'bounce-then-land', scene: scene(), initial: { z: 1, vz: -15 } },
    { name: 'fuse-ground-tie', scene: scene(), initial: { z: 1, vz: -15, fuse: 0.05 } },
    { name: 'impact-fuse-ground-tie', scene: scene([box('wall', 0, 80, 27)]),
      initial: { z: 1, vz: -15, fuse: 0.05 } },
    // Roof artwork is deliberately distinct from explicit physical boxes.
    { name: 'decorative-roof', scene: scene([], { decorativeRoofs: [{ x: 40, y: 30, w: 60, h: 40 }] }), initial: {} },
    { name: 'explicit-ceiling', scene: scene([box('ceiling', 31, 35, 10, 90)]), initial: {} },
    { name: 'window-opening', scene: scene(window), initial: { z: 20, vz: 40 } },
    { name: 'window-sill', scene: scene(window), initial: { z: 5, vz: 40 } },
    { name: 'window-lintel', scene: scene(window), initial: { z: 38, vz: 40 } },
    { name: 'mask-hole', scene: scene([], { holes: [{ id: 'void', x: 40, y: 40, w: 10, h: 20 }] }),
      initial: { vx: 1000, z: 100, vz: 0 } },
    { name: 'mask-outer', scene: scene(), initial: { x: 190, vx: 1000, z: 100, vz: 0 } },
  ];
}

export function runWitness(setup) {
  let state = createThrow(setup.initial);
  const frames = [{ tick: 0, state, display: displayThrow(state), events: [] }];
  for (let tick = 1; tick <= PROFILE.maxTicks && state.status === 'flying'; tick++) {
    state = stepThrow(state, setup.scene);
    frames.push({ tick, state, display: displayThrow(state), events: state.events });
  }
  if (state.status === 'flying') throw new Error(`${setup.name}: witness exceeded tick budget`);
  return { ...structuredClone(setup), frames };
}

export function captureWitnesses() {
  return { schema: 'ballistic-lab-recording-1', profile: PROFILE,
    limitations: ['Synthetic stationary axis-aligned boxes, one thrown cube and one flat ground plane.',
      'No live activation, damage, inventory, networking, moving targets or arbitrary map geometry.',
      'Numbers and height/roof/window semantics require review before promotion.'],
    witnesses: witnessSetups().map(runWitness) };
}
