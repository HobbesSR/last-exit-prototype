import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch } from '../server/match.js';
import { packMap, packedTransfer, packRuntimeMap, unpackMap } from '../server/map-pack.js';
import { prepareRuntimeNavigation } from '../server/runtime-map.js';
import { initCore } from '../shared/core.ts';
import { packedTilesFor } from '../shared/navigation/knowledge.ts';
import { portalGraphOf } from '../shared/navigation/portal-graph.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';

const tiles = map => ['gladiator', 'contestant'].map(role => packedTilesFor(map, role));

test('matches use eager and deferred flat maps across WASM growth and disposal', async t => {
  const seed = 4217, base = defaultContent();
  const content = { ...base, roster: { contestants: ['C0'], gladiators: [{ name: 'G0', kit: 'warden' }] } };
  const { map } = arena({ cols: 10, rows: 6, corridor: { gaps: [3] }, spawns: [{ x: 300, y: 660 }],
    hunterSpawns: [{ x: 1450, y: 660 }], gates: [{ id: 'door', kind: 'door', x: 960, y: 660, w: 40, h: 96, open: true }] });
  const current = await createMatch(seed, undefined, unpackMap(packMap(map, tiles(map))), content);
  t.after(() => current.dispose());
  const variants = [];
  for (const deferContestant of [false, true]) {
    const packed = packRuntimeMap(map, { deferContestant });
    const received = structuredClone(packed, { transfer: packedTransfer(packed) });
    assert.equal(packed.runtimeNavigation.byteLength, 0);
    assert.equal(received.tiles.length, 0);
    const decoded = unpackMap(received), match = await createMatch(seed, undefined, decoded, content);
    t.after(() => match.dispose());
    assert.equal(portalGraphOf(decoded), undefined);
    const core = await initCore();
    core.memory.grow(1);
    match.start();
    variants.push({ match, decoded });
  }
  current.start();
  let routed = false;
  for (let i = 0; i < 24; i++) {
    const expected = current.advance();
    routed ||= expected.players.some(p => p.route?.length);
    for (const { match } of variants) assert.deepEqual(match.advance(), expected);
  }
  assert.ok(routed, 'the comparison covers a bot following a route');
  for (const { match, decoded } of variants) {
    match.dispose();
    assert.equal(portalGraphOf(decoded), undefined);
  }
});

test('Rust rejects malformed flat packages and accepts graphless ones', async () => {
  const { map } = arena({ cols: 3, rows: 2 });
  const bad = packRuntimeMap(map);
  const header = new DataView(bad.runtimeNavigation.buffer);
  header.setUint32(0, 0, true);
  await assert.rejects(prepareRuntimeNavigation(unpackMap(bad)), /Invalid runtime navigation \(core\)/);

  const badPoint = packRuntimeMap(map);
  const directory = new DataView(badPoint.runtimeNavigation.buffer);
  // The graphless directory's tile points are section 5, after the header and four layer sections.
  directory.setUint16(directory.getUint32(8 + 5 * 8, true), 0xffff, true);
  await assert.rejects(prepareRuntimeNavigation(unpackMap(badPoint)), /Invalid runtime navigation \(core\)/);

  const { map: corridor } = arena({ cols: 4, rows: 2, corridor: { gaps: [0] } });
  const badGraph = packRuntimeMap(corridor, { deferContestant: false });
  const graphDirectory = new DataView(badGraph.runtimeNavigation.buffer);
  graphDirectory.setInt32(graphDirectory.getUint32(8 + 3 * 8, true), -2, true);
  await assert.rejects(prepareRuntimeNavigation(unpackMap(badGraph)), /Invalid runtime navigation \(core\)/);

  for (const deferContestant of [false, true]) {
    const decoded = unpackMap(packRuntimeMap(map, { deferContestant }));
    const { pointer, release } = await prepareRuntimeNavigation(decoded);
    try {
      assert.equal(portalGraphOf(decoded), undefined);
      assert.ok(pointer);
    } finally { release(); }
  }
});
