import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { validatePortalReach } from '../../map/micro/portals.ts';
import { createRegionMask, elementShapes } from '../../map/micro/geometry.ts';
import { portalMargin } from '../../map/micro/hints.ts';
import { bounds } from '../../shared/shape.ts';
import { SIZE, brief, MASKS, blockers, kind } from './plant-fixtures.js';

/**
 * A plant keeps the portal promise on every mask of `plant-fixtures.js` at each of `seeds`, under
 * each parameter set. The fast tier runs two seeds and `tests/slow/micro-plant-promise.test.js`
 * all eight, which took 4.9 of the file's 10.4 s (31, #543).
 */
export function assertPlantPromise(seeds) {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of seeds)
    for (const parameters of [undefined, { density: 1, shed: 0 }, { density: 1, shed: 1 }, { density: 0.3 }]) {
      const result = buildRegion(brief(name, seed, cells, portals, parameters));
      if (name !== 'yard' && parameters?.density === 1) assert.ok(result.elements.length > 0, `${name} seed ${seed} stood machines or a shed`);
      // Plant places on a live cord up to 32 portals (#759), so its proof is the thorough search's (20.10).
      const check = validatePortalReach({ ...result.brief, blockers: blockers(result) }, { search: 'thorough' });
      assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
    }
}

const cellBox = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });
const gapBetween = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

/**
 * Machines and the shed keep an aisle from each other and respect portal margins, and pipes keep
 * clear of all but what they join, on every mask at each of `seeds`. The fast tier runs two seeds
 * and `tests/slow/micro-plant-promise.test.js` all eight (31, #759).
 */
export function assertPlantSpacing(seeds) {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of seeds)
    for (const parameters of [{ density: 1, shed: 0 }, { density: 1, shed: 1 }]) {
      const input = brief(name, seed, cells, portals, parameters);
      const result = buildRegion(input), mask = createRegionMask(input);
      const reserved = new Set(portalMargin(input, 1).map(c => `${c.x},${c.y}`));
      const solid = result.elements.filter(e => !kind('pipe')(e)).map(e => ({ label: e.label, box: cellBox(e) }));
      for (const [i, { label, box }] of solid.entries()) {
        for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++)
          assert.ok(mask.has(x, y) && !reserved.has(`${x},${y}`), `${name} ${seed}: ${label} footprint`);
        for (const other of solid.slice(i + 1)) assert.ok(gapBetween(box, other.box) >= 2, `${name} ${seed}: ${label} and ${other.label}`);
      }
      const cellsOfShape = shape => { const b = bounds(shape); return { x: b.x / SIZE, y: b.y / SIZE, w: b.w / SIZE, h: b.h / SIZE }; };
      const pipes = result.elements.filter(kind('pipe')).map(pipe => {
        const stubs = elementShapes(pipe).map(cellsOfShape);
        // A run's box reaches into the two machines it joins, though a gap against one leaves it no stub there.
        return { pipe, stubs, joins: solid.filter(({ box }) => gapBetween(cellBox(pipe), box) < 0) };
      });
      for (const { pipe, stubs, joins } of pipes) {
        // Each run joins exactly two machines, and keeps clear of every other piece, and of every run that shares neither.
        assert.equal(joins.length, 2, `${name} ${seed}: ${pipe.label} joins two machines`);
        assert.ok(joins.every(j => j.label.startsWith('plant-machine')));
        const others = [...solid.filter(s => !joins.includes(s)).map(s => s.box),
          ...pipes.filter(p => p.pipe !== pipe && !p.joins.some(j => joins.includes(j))).flatMap(p => p.stubs)];
        for (const s of stubs) for (const other of others)
          assert.ok(gapBetween(s, other) >= 2, `${name} ${seed}: ${pipe.label} keeps clear`);
      }
    }
}
