import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildCompoundGeneration, diagnoseCompoundSiting } from '../../map/micro/strategies/compound.ts';
import { flattenDelegationResult } from '../../map/micro/delegation-execute.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../../map/micro/portals.ts';

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
  // Portal reach joins the starts; choose the closest to avoid repeated long searches.
  const starts = portalStands(inwardBrief).flatMap(portal => portal.points);
  const route = (to, label) => {
    const from = [...starts].sort((a, b) => Math.hypot(a.x - to.x, a.y - to.y) - Math.hypot(b.x - to.x, b.y - to.y))[0];
    assert.ok(findRegionRoute(access, shapes, from, to, hunter), `hunter reaches ${label}`);
  };
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

  const reach = validatePortalReach({ ...inwardBrief, blockers: shapes });
  assert.deepEqual(reach.errors, []);
  assert.equal(reach.routes.length, inwardBrief.portals.length - 1);
  assert.deepEqual(inwardBrief, original, 'diagnosis and production preserve caller input');
});
