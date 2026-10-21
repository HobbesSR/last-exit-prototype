/**
 * The tools' import of the game's strategies, beside `core.ts`: the CLI, MCP, Map Lab (which
 * loads it from the game server) and their tests reach the map-level assembly through here
 * (22.2). `tests/map-entrypoint.test.js` holds both paths to one object.
 */
export { DEFAULT_CELL_SIZE, GAME_ENGINES, GAME_REGION_TYPES } from '../engines.ts';
