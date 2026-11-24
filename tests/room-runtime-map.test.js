import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch } from '../server/match.js';
import { packMap, packedTransfer, packRuntimeMap, unpackMap } from '../server/map-pack.js';
import { prepareRuntimeNavigation } from '../server/runtime-map.js';
import { initCore } from '../shared/core.ts';
import { createKnowledgePlanner, freeTilesFor, packedTilesFor } from '../shared/navigation/knowledge.ts';
import { portalGraphOf } from '../shared/navigation/portal-graph.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';

const tiles = map => ['gladiator', 'contestant'].map(role => packedTilesFor(map, role));

test('a match borrows a transferred flat map across WASM growth and releases it at disposal', async t => {
  const seed = 4217, base = defaultContent();
  const content = { ...base, roster: { contestants: ['C0'], gladiators: [{ name: 'G0', kit: 'warden' }] } };
  const { map } = arena({ cols: 10, rows: 6, corridor: { gaps: [3] }, spawns: [{ x: 300, y: 660 }],
    hunterSpawns: [{ x: 1450, y: 660 }], gates: [{ id: 'door', kind: 'door', x: 960, y: 660, w: 40, h: 96, open: true }] });
  const current = await createMatch(seed, undefined, unpackMap(packMap(map, tiles(map))), content);
  t.after(() => current.dispose());
  const packed = packRuntimeMap(map);
  const received = structuredClone(packed, { transfer: packedTransfer(packed) });
  assert.equal(packed.runtimeNavigation.byteLength, 0);
  assert.equal(received.tiles.length, 0);
  const decoded = unpackMap(received), match = await createMatch(seed, undefined, decoded, content);
  t.after(() => match.dispose());
  const graph = portalGraphOf(decoded);
  assert.deepEqual(graph, portalGraphOf(map));
  const known = { known: () => true, door: () => undefined, keys: 0, revision: 0 };
  for (const role of ['gladiator', 'contestant']) {
    assert.deepEqual(freeTilesFor(decoded, role), freeTilesFor(current.diagnosticState.map, role));
  }
  const planner = createKnowledgePlanner(decoded, 'contestant');
  const tile = planner.tile(known, 35), expectedPoints = tile.points.slice(), previous = tile.triangles.buffer;
  const core = await initCore();
  core.memory.grow(1);
  assert.notEqual(tile.triangles.buffer, previous);
  assert.deepEqual(tile.points, expectedPoints);
  assert.deepEqual(graph.owner, portalGraphOf(map).owner);

  current.start(); match.start();
  for (let i = 0; i < 3; i++) assert.deepEqual(match.advance(), current.advance());
  match.dispose();
  assert.equal(portalGraphOf(decoded), undefined);
  assert.throws(() => tile.points, /released/);
});

test('invalid flat headers and tile offsets are rejected and graphless packages still load', async () => {
  const { map } = arena({ cols: 3, rows: 2 });
  const bad = packRuntimeMap(map);
  const header = new DataView(bad.runtimeNavigation.buffer);
  header.setUint32(0, 0, true);
  await assert.rejects(prepareRuntimeNavigation(unpackMap(bad)), /Invalid runtime navigation/);

  const badPoint = packRuntimeMap(map);
  const directory = new DataView(badPoint.runtimeNavigation.buffer);
  // The graphless directory's tile points are section 5, after the header and four layer sections.
  directory.setUint16(directory.getUint32(8 + 5 * 8, true), 0xffff, true);
  await assert.rejects(prepareRuntimeNavigation(unpackMap(badPoint)), /Invalid runtime navigation/);

  for (const deferContestant of [false, true]) {
    const decoded = unpackMap(packRuntimeMap(map, { deferContestant }));
    const release = await prepareRuntimeNavigation(decoded);
    try {
      assert.equal(portalGraphOf(decoded), undefined);
      assert.ok(createKnowledgePlanner(decoded, 'gladiator').tile({ known: () => true }, 0));
    } finally { release(); }
  }
});
