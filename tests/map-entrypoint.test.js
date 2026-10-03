import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARY, generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { CHAIN_LIBRARY as TOOL_LIBRARY, generate as toolGenerate } from '../map/tools/core.ts';
import { GAME_ENGINES as TOOL_ENGINES } from '../map/tools/engines.ts';

test('map entry point and tools share one library, engines and generation behavior', () => {
  assert.strictEqual(CHAIN_LIBRARY, TOOL_LIBRARY);
  assert.strictEqual(GAME_ENGINES, TOOL_ENGINES);
  const params = { mode: 'playground', zoneWidth: 2, zoneHeight: 1 };
  assert.deepEqual(generate('entrypoint', params), toolGenerate('entrypoint', params));
});
