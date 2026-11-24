import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch } from '../server/match.js';
import { packMap, packedTransfer, unpackMap } from '../server/map-pack.js';
import { prepareRuntimeNavigation } from '../server/runtime-map.js';
import { initCore } from '../shared/core.ts';
import { createKnowledgePlanner, packedTilesFor } from '../shared/navigation/knowledge.ts';
import { portalGraphOf } from '../shared/navigation/portal-graph.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';

const tiles = map => ['gladiator', 'contestant'].map(role => packedTilesFor(map, role));
const flat = map => packMap(map, tiles(map), { runtimeMap: true });

test('a match borrows a transferred flat map across WASM growth and releases it at disposal', async t => {
  const seed = 4217, base = defaultContent();
  const content = { ...base, roster: { contestants: ['C0'], gladiators: [{ name: 'G0', kit: 'warden' }] } };
  const { map } = arena({ cols: 10, rows: 6, corridor: { gaps: [3] }, spawns: [{ x: 300, y: 660 }],
    hunterSpawns: [{ x: 1450, y: 660 }], gates: [{ id: 'door', kind: 'door', x: 960, y: 660, w: 40, h: 96, open: true }] });
  const current = await createMatch(seed, undefined, unpackMap(packMap(map, tiles(map))), content);
  t.after(() => current.dispose());
  const packed = flat(map);
  const received = structuredClone(packed, { transfer: packedTransfer(packed) });
  assert.equal(packed.runtimeNavigation.byteLength, 0);
  assert.equal(received.tiles.length, 0);
  const decoded = unpackMap(received), match = await createMatch(seed, undefined, decoded, content);
  t.after(() => match.dispose());
  const graph = portalGraphOf(decoded);
  assert.deepEqual(graph, portalGraphOf(map));
  const known = { known: () => true, door: () => undefined, keys: 0, revision: 0 };
  const planner = createKnowledgePlanner(decoded, 'contestant');
  const tile = planner.tile(known, 35), expectedPoints = tile.points.slice(), previous = tile.points.buffer;
  const core = await initCore();
  core.memory.grow(1);
  assert.notEqual(tile.points.buffer, previous);
  assert.deepEqual(tile.points, expectedPoints);
  assert.deepEqual(graph.owner, portalGraphOf(map).owner);

  current.start(); match.start();
  for (let i = 0; i < 3; i++) assert.deepEqual(match.advance(), current.advance());
  match.dispose();
  assert.equal(portalGraphOf(decoded), undefined);
  assert.throws(() => tile.points, /released/);
});

test('a bad flat package is rejected and a graphless package can still be loaded', async () => {
  const { map } = arena({ cols: 3, rows: 2 });
  const bad = flat(map);
  const header = new DataView(bad.runtimeNavigation.buffer);
  header.setUint32(0, 0, true);
  await assert.rejects(prepareRuntimeNavigation(unpackMap(bad)), /Invalid runtime navigation/);
  const decoded = unpackMap(flat(map));
  const release = await prepareRuntimeNavigation(decoded);
  try {
    assert.equal(portalGraphOf(decoded), undefined);
    assert.ok(createKnowledgePlanner(decoded, 'gladiator').tile({ known: () => true }, 0));
  } finally { release(); }
});
