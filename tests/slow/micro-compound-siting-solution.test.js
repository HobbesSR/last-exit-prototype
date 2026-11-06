import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildCompoundGeneration, diagnoseCompoundSiting } from '../../map/micro/strategies/compound.ts';
import { flattenDelegationResult } from '../../map/micro/delegation-execute.ts';
import { createAccessMask, createRegionRouteSearch, elementShapes } from '../../map/micro/geometry.ts';
import { hunterClearance, portalStands } from '../../map/micro/portals.ts';

const load = name => JSON.parse(gunzipSync(readFileSync(new URL(`../fixtures/${name}`, import.meta.url))));
const oldBrief = load('compound-340-brief.json.gz');
const inwardBrief = load('compound-340-inward-brief.json.gz');

test('inward authored military-quarter keeps its original interface and builds a traversable compound', () => {
  const original = structuredClone(inwardBrief);
  // The corrected source changes only the margins caused by internal joins.
  for (const key of ['id', 'seed', 'cells', 'portals', 'zones', 'hints'])
    assert.deepEqual(inwardBrief[key], oldBrief[key], `${key} is unchanged`);
  assert.equal(oldBrief.internalGuaranteed.length, 586);
  assert.equal(oldBrief.fillCells.length, 6240);
  assert.equal(inwardBrief.internalGuaranteed.length, 0);
  assert.equal(inwardBrief.fillCells.length, 10856);

  const diagnosis = diagnoseCompoundSiting(inwardBrief);
  assert.deepEqual(diagnosis.site && (({ x, y, w, h }) => ({ x, y, w, h }))(diagnosis.site),
    { x: 402, y: 366, w: 24, h: 24 });
  assert.equal(diagnosis.probes.at(-1)?.reason, 'accepted');

  const traces = [];
  const node = buildCompoundGeneration(inwardBrief, { observe: trace => traces.push(trace) });
  const result = flattenDelegationResult(node);
  assert.equal(node.actualBuilder, 'compound');
  assert.equal(node.retained.manifest.rooms, 22);
  assert.equal(node.retained.manifest.compoundGates, 2);
  assert.deepEqual(traces.map(trace => trace.label), ['compound', 'compound-keep', 'compound-outbuilding']);
  const [trace] = traces;
  assert.equal(trace.label, 'compound');
  assert.deepEqual(trace.realization.issues, []);
  assert.deepEqual(trace.realization.misses, []);

  const shapes = result.elements.flatMap(element => elementShapes(element));
  const access = createAccessMask(inwardBrief), hunter = hunterClearance(inwardBrief.cellSize);
  // Portal reach joins the starts; each target routes from its closest, and targets sharing a
  // start share one search (the same routes as separate searches, #822).
  const starts = portalStands(inwardBrief).flatMap(portal => portal.points), targets = [];
  const route = (to, label) => targets.push({ to, label,
    from: [...starts].sort((a, b) => Math.hypot(a.x - to.x, a.y - to.y) - Math.hypot(b.x - to.x, b.y - to.y))[0] });
  const rooms = node.retained.elements.filter(element => element.label.startsWith('compound-room'));
  assert.equal(rooms.length, 22);
  for (const room of rooms) route({ x: room.x + room.template.w / 2, y: room.y + room.template.h / 2 }, room.label);
  const site = diagnosis.site;
  route({ x: (site.x + site.w / 2) * inwardBrief.cellSize,
    y: (site.y + site.h / 2) * inwardBrief.cellSize }, 'court center');

  const outerGates = trace.realization.openings.filter(opening => /^gate-[NSEW]$/.test(opening.connectionId));
  assert.equal(outerGates.length, 2);
  for (const gate of outerGates) {
    const side = trace.design.connections.find(connection => connection.id === gate.connectionId)?.side;
    assert.ok(side);
    const along = (gate.run.axis === 'h' ? gate.run.x : gate.run.y) + gate.center - 1;
    for (const offset of new Set([Math.floor(along), Math.ceil(along)])) {
      const x = side === 'W' ? site.x - 2 : side === 'E' ? site.x + site.w : site.x + offset;
      const y = side === 'N' ? site.y - 2 : side === 'S' ? site.y + site.h : site.y + offset;
      route({ x: (x + 1) * inwardBrief.cellSize, y: (y + 1) * inwardBrief.cellSize }, `${gate.connectionId} yard stand`);
    }
  }
  const searches = new Map();
  for (const { from, to, label } of targets) {
    const key = `${from.x},${from.y}`;
    if (!searches.has(key)) searches.set(key, createRegionRouteSearch(access, shapes, from, hunter));
    assert.ok(searches.get(key)(to), `hunter reaches ${label}`);
  }

  // The portal promise over all 76 portals is not checked per run: its 75 routes cost about 35 s of
  // this file's 46 s (#822), where the ring stands on 576 of 11,232 cells, and no 36 × 18 region's
  // promise is checked per run since #821. On real chain briefs, compound's promise runs on
  // map-library's library-4 (fast, 34 portals) and library-0 (slow diagnosis, 24 portals), and on
  // the sweep masks. To check this quarter's on purpose:
  //   node tools/compound-siting-solution-audit.mjs --after-brief=tests/fixtures/compound-340-inward-brief.json.gz
  // (#340 evidence, not maintained tooling; without --after-brief it regenerates the map, which has
  // moved since, and fails its first assertion).
  assert.deepEqual(inwardBrief, original, 'diagnosis and production preserve caller input');
});
