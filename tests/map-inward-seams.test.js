import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CHAIN_LIBRARY } from '../map/chain.ts';
import { libraryFingerprint } from '../map/macro/src/coding.ts';
import { declaredGrid, layoutViolations } from '../map/macro/src/chain/declared-grid.ts';
import { resolution } from '../map/macro/src/chain/resolution.ts';
import { regions, portalViolations } from '../map/macro/src/chain/regions.ts';
import { briefs, chainZones } from '../map/macro/src/chain/briefs.ts';

const KINDS = ['market', 'plant', 'hall', 'park', 'ruins', 'checkpoint'];
const PARAMS = { mode: 'playground', zoneWidth: 1, zoneHeight: 1,
  exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0, lootTierStep: 0 };

function composedGround(kind, inward) {
  const slots = [];
  for (let row = 1; row <= 3; row++) for (let col = 1; col <= 3; col++) {
    const mask = `${row > 1 ? 'n' : ''}${col < 3 ? 'e' : ''}${row < 3 ? 's' : ''}${col > 1 ? 'w' : ''}`;
    slots.push({ col, row, design: inward ? `${kind}-ground-inward-${mask}` : `${kind}-ground`, orientation: 0 });
  }
  const layout = { seed: `inward-${kind}`, params: PARAMS, library: libraryFingerprint(CHAIN_LIBRARY), slots, setPieces: [] };
  assert.deepEqual(layoutViolations(declaredGrid(layout, CHAIN_LIBRARY)), [], `${kind} adjacency`);
  const resolved = resolution(layout, CHAIN_LIBRARY);
  const found = regions(resolved, layout.seed);
  assert.deepEqual(portalViolations(found), [], `${kind} portal widths`);
  const region = briefs(layout, resolved, found, chainZones(PARAMS), CHAIN_LIBRARY, 40)
    .find(brief => brief.type === kind && brief.cells.length === 9 * 36);
  assert.ok(region, `${kind} forms one 18x18-cell region`);
  return { resolved, region };
}

test('new inward ground families remove resolved internal guarantees and expand usable fill', () => {
  for (const kind of KINDS) {
    const old = composedGround(kind, false);
    const inward = composedGround(kind, true);
    assert.ok(old.region.internalGuaranteed.length > 0, `${kind} original has guaranteed seams`);
    assert.deepEqual(inward.region.internalGuaranteed, [], `${kind} inward joins have no guaranteed seams`);
    assert.ok(inward.region.fillCells.length > old.region.fillCells.length,
      `${kind} fill grows from ${old.region.fillCells.length} to ${inward.region.fillCells.length}`);
    assert.deepEqual(inward.region.portals, old.region.portals, `${kind} external portal prescriptions remain`);
    let exposed = 0;
    for (const key of Object.keys(old.resolved.segments)) {
      const match = /^([hv]):(\d+),(\d+)$/.exec(key);
      if (!match) continue;
      const [, axis, xText, yText] = match;
      const x = Number(xText), y = Number(yText);
      const onOuter = axis === 'v' ? (x === 6 || x === 24) && y >= 6 && y < 24
        : (y === 6 || y === 24) && x >= 6 && x < 24;
      if (onOuter) {
        exposed++;
        assert.deepEqual(inward.resolved.segments[key], old.resolved.segments[key], `${kind} exposed ${key}`);
      }
    }
    assert.equal(exposed, 72, `${kind} retains all four exposed 18-cell sides`);
  }
});

// New revisions must not retune existing fill options or alter prior authored tiles.
test('the new primitives preserve every previous tile and tile set', () => {
  const previous = JSON.parse(readFileSync(new URL('../map/macro/content/common-primitives@4.json', import.meta.url), 'utf8'));
  for (const tile of previous.tiles)
    assert.deepEqual(CHAIN_LIBRARY.tiles.find(current => current.id === tile.id), tile, tile.id);
  for (const set of previous.tileSets)
    assert.deepEqual(CHAIN_LIBRARY.tileSets.find(current => current.id === set.id), set, set.id);
  for (const kind of KINDS) {
    const variants = CHAIN_LIBRARY.tiles.filter(tile => tile.id.startsWith(`${kind}-ground-inward-`));
    assert.ok(variants.length, `${kind} has inward variants`);
    assert.ok(variants.every(tile => tile.weight === 0), `${kind} variants never enter random fill`);
  }
});
