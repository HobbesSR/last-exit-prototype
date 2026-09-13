// Compatibility facade: generation and runtime routing have independent ownership.
export { WORLD_WIDTH, WORLD_HEIGHT, BLOCK_SIZE } from './map/world.ts';
export { blockAt, blockRoute } from './map/graph.ts';
export { generateMap } from './map/generate.ts';
export { navigationGrid } from './map/navigation.ts';
