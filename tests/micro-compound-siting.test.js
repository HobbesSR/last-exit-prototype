import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { clearFootprint } from '../map/kernel/margins.ts';
import { createFillMask, createRegionMask } from '../map/micro/geometry.ts';
import { largestRectangle } from '../map/micro/strategies/hall.ts';
import { buildCompoundGeneration, diagnoseCompoundSiting } from '../map/micro/strategies/compound.ts';

const fixture = () => JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/compound-340-brief.json.gz', import.meta.url))));

function rectangleBrief(w, h) {
  const cells = Array.from({ length: w * h }, (_, i) => ({ x: i % w, y: Math.floor(i / w) }));
  return { id: `compound-${w}x${h}`, seed: 1, type: 'compound', cellSize: 40, cells,
    zones: [{ tier: 3, bonus: 0, lootChance: 0, cells }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
      { id: 'east', axis: 'v', x: w, y: 8, length: 2 }] };
}

function emittedRingBox(node, cellSize) {
  const pieces = node.retained.elements.filter(element => /^compound-(room|gate)/.test(element.label));
  assert.ok(pieces.length > 0, 'production emitted a compound ring');
  const boxes = pieces.map(element => ({ x: element.x / cellSize, y: element.y / cellSize,
    w: element.template.w / cellSize, h: element.template.h / cellSize }));
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, w: Math.max(...boxes.map(box => box.x + box.w)) - x,
    h: Math.max(...boxes.map(box => box.y + box.h)) - y };
}

test('captured 36x18 compound has no contained ring box and takes terminal empty', () => {
  // Focused brief from generate('issue330-before-36x18', { mode: 'game', zoneWidth: 36, zoneHeight: 18 }),
  // region compound@336,342. Do not regenerate the macro map in this fast test.
  const brief = fixture(), original = structuredClone(brief);
  assert.equal(createHash('sha256').update(JSON.stringify(brief)).digest('hex'),
    'ea08497ff53070560aed9c5d50f25d270d95cbee30f879fddbd5ea3e66d513b2');
  assert.equal(brief.id, 'compound@336,342');
  assert.equal(brief.cells.length, 11232);
  assert.equal(brief.fillCells.length, 6240);
  assert.equal(brief.portals.length, 76);
  assert.equal(brief.internalGuaranteed.length, 586);
  const fill = createFillMask(brief);
  assert.equal(largestRectangle(fill, 10), undefined);
  assert.equal(largestRectangle(fill, 5), undefined);
  assert.deepEqual(largestRectangle(fill, 4), { x: 337, y: 343, w: 4, h: 4 });
  const internalClear = new Set(clearFootprint(brief.internalGuaranteed, brief.cells).map(c => `${c.x},${c.y}`));
  assert.equal(internalClear.size, 4688);
  const internalOnlyFill = createRegionMask({ ...brief, cells: brief.cells.filter(c => !internalClear.has(`${c.x},${c.y}`)) });
  assert.equal(largestRectangle(internalOnlyFill, 10), undefined, 'internal guarantees alone prevent every minimum box');

  const diagnosis = diagnoseCompoundSiting(brief);
  assert.equal(diagnosis.space, null);
  assert.deepEqual(diagnosis.probes, []);
  assert.equal(diagnosis.site, null);

  const production = buildCompoundGeneration(brief);
  assert.equal(production.actualBuilder, 'empty');
  assert.equal(production.fallbackKind, 'builder-empty');
  assert.equal(production.fallbackReason, 'compound has no usable ring box');
  assert.equal(production.retained.brief.cells.length, original.cells.length);
  assert.deepEqual(production.retained.brief.cells, original.cells);
  assert.deepEqual(production.retained.elements, []);
  assert.deepEqual(production.retained.coreElements, []);
  assert.deepEqual(production.retained.loot, []);
  assert.deepEqual(brief, original, 'diagnosis and production preserve caller input');
});

test('accepted small and large sites match the rings production emits', () => {
  for (const [w, h] of [[17, 16], [40, 34]]) {
    const brief = rectangleBrief(w, h), original = structuredClone(brief);
    const diagnosis = diagnoseCompoundSiting(brief);
    assert.ok(diagnosis.space, `${w}x${h} has a usable space`);
    assert.ok(diagnosis.site, `${w}x${h} has an accepted site`);
    const accepted = diagnosis.probes.filter(probe => probe.reason === 'accepted');
    assert.equal(accepted.length, 1, `${w}x${h} accepts exactly one probe`);
    const { gated, ...box } = diagnosis.site;
    assert.deepEqual(accepted[0].box, box);
    assert.deepEqual(accepted[0].gateSides.slice(0, diagnosis.gates), gated);

    const production = buildCompoundGeneration(brief);
    assert.equal(production.actualBuilder, 'compound');
    assert.deepEqual(emittedRingBox(production, brief.cellSize), box);
    assert.deepEqual(brief, original, `${w}x${h} caller input is unchanged`);
  }
});
