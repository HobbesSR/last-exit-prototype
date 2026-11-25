import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch } from '../server/match.js';
import { packMap, packedTransfer, packRuntimeMap, unpackMap } from '../server/map-pack.js';
import { prepareRuntimeNavigation } from '../server/runtime-map.js';
import { initCore } from '../shared/core.ts';
import { packedTilesFor } from '../shared/navigation/knowledge.ts';
import { portalGraphOf } from '../shared/navigation/portal-graph.ts';
import { createRuntimeNavigation } from '../shared/navigation/runtime-map.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';

const tiles = map => ['gladiator', 'contestant'].map(role => packedTilesFor(map, role));

// Read the flat sections independently to check the archive against the package the planner receives.
function archivedGraphSections(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionCount = view.getUint32(4, true);
  const sections = [];
  for (let section = 1; section <= 5; section++) {
    assert.ok(section < sectionCount, `runtime package contains section ${section}`);
    const offset = view.getUint32(8 + section * 8, true);
    const size = view.getUint32(12 + section * 8, true);
    sections.push(Buffer.from(bytes.subarray(offset, offset + size)).toString('base64'));
  }
  return { encoding: 'flat-graph-1', sections };
}

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
    const expectedGraph = archivedGraphSections(packed.runtimeNavigation);
    const received = structuredClone(packed, { transfer: packedTransfer(packed) });
    assert.equal(packed.runtimeNavigation.byteLength, 0);
    assert.equal(received.tiles.length, 0);
    const decoded = unpackMap(received), match = await createMatch(seed, undefined, decoded, content);
    t.after(() => match.dispose());
    assert.equal(portalGraphOf(decoded), undefined);
    const core = await initCore();
    core.memory.grow(1);
    match.start();
    assert.deepEqual(match.recordingSetup().portalGraph, expectedGraph, 'setup archives the raw flat graph sections');
    variants.push({ match, decoded, expectedGraph });
  }
  current.start();
  assert.deepEqual(current.recordingSetup().portalGraph, variants[0].expectedGraph,
    'plain graph-backed matches archive the same flat sections');
  let routed = false;
  for (let i = 0; i < 24; i++) {
    const expected = current.advance();
    assert.ok(expected.players.every(p => !Object.hasOwn(p, 'route')), 'the ordinary frame omits private routes');
    const snapshot = current.snapshot();
    routed ||= snapshot.players.some(p => p.route?.length);
    for (const { match } of variants) {
      assert.deepEqual(match.advance(), expected);
      assert.deepEqual(match.snapshot(), snapshot);
    }
  }
  assert.ok(routed, 'the comparison covers a bot following a route');
  for (const { match, decoded, expectedGraph } of variants) {
    const snapshot = match.snapshot();
    match.dispose();
    assert.deepEqual(match.recordingSetup().portalGraph, expectedGraph, 'setup survives simulation and disposal');
    assert.deepEqual(match.snapshot(), snapshot, 'disposal retains the last private snapshot');
    assert.equal(portalGraphOf(decoded), undefined);
  }
});

test('Rust rejects malformed flat packages and accepts graphless ones', async () => {
  const { map } = arena({ cols: 3, rows: 2 });
  const bad = packRuntimeMap(map);
  const header = new DataView(bad.runtimeNavigation.buffer);
  header.setUint32(0, 0, true);
  await assert.rejects(createMatch(9, undefined, unpackMap(bad)), /Invalid runtime navigation \(core\)/);

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
    const { pointer, release, portalGraph } = await prepareRuntimeNavigation(decoded);
    try {
      assert.equal(portalGraphOf(decoded), undefined);
      assert.equal(portalGraph, null, 'the graphless package records an explicit null');
      assert.ok(pointer);
    } finally { release(); }
  }

  const { map: fractional } = arena({ cols: 3, rows: 2, cellSize: 192.125 });
  const direct = createRuntimeNavigation(await initCore(), fractional);
  try { assert.ok(direct.pointer, 'fractional bounds can still use the eager upload'); }
  finally { direct.release(); }
});
