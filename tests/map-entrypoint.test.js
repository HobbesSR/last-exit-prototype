import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARIES, CHAIN_LIBRARY, bundledLibrary, generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { CHAIN_LIBRARY as TOOL_LIBRARY, generate as toolGenerate } from '../map/tools/core.ts';
import { GAME_ENGINES as TOOL_ENGINES } from '../map/tools/engines.ts';

test('map entry point and tools share one library, engines and generation behavior', () => {
  assert.strictEqual(CHAIN_LIBRARY, TOOL_LIBRARY);
  assert.strictEqual(GAME_ENGINES, TOOL_ENGINES);
  const params = { mode: 'playground', zoneWidth: 2, zoneHeight: 1 };
  assert.deepEqual(generate('entrypoint', params), toolGenerate('entrypoint', params));
});

test('each authored zone size takes its own bundled library, and game mode refuses any other', () => {
  assert.deepEqual(CHAIN_LIBRARIES.map(library => [library.name, library.zoneWidth, library.zoneHeight]),
    [['diamond-12x6', 12, 6], ['diamond-24x12', 24, 12], ['diamond-36x18', 36, 18]]);
  assert.strictEqual(CHAIN_LIBRARIES[0], CHAIN_LIBRARY);
  assert.strictEqual(bundledLibrary(), CHAIN_LIBRARY);
  for (const library of CHAIN_LIBRARIES) assert.strictEqual(bundledLibrary(library), library);
  // Playground mode takes any size, and the default library where none is authored (51).
  assert.strictEqual(bundledLibrary({ mode: 'playground', zoneWidth: 2, zoneHeight: 1 }), CHAIN_LIBRARY);
  assert.throws(() => generate('unauthored', { zoneWidth: 18, zoneHeight: 9 }), /no bundled library is authored for 18 x 9 tile zones; game mode takes 12 x 6, 24 x 12, 36 x 18/);
});
