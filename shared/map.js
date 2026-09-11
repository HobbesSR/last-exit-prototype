// Compatibility facade: generation and runtime routing have independent ownership.
export { WORLD_WIDTH, WORLD_HEIGHT, BLOCK_SIZE } from './map/world.js';
export { blockAt, blockRoute } from './map/graph.js';
export { generateMap } from './map/generate.js';
export { navigationGrid } from './map/navigation.js';
