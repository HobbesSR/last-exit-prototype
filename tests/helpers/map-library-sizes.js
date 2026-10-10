import assert from 'node:assert/strict';
import { batch, checkMap, generate, summarizeMetrics } from '../../map/tools/core.ts';

// S6 (#171): preserve five seeds and the same coverage/supply assertions for each
// larger library. Separate files keep each slow test under the budget in 31.
export function checkLibrarySize(library, seeds) {
  const params = { zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight };
  const report = seeds ? selectedSeeds(library, params, seeds) : batch(`size-${library.zoneWidth}`, 5, params);
  assert.equal(report.valid, true, JSON.stringify([report.defective, report.failures]));
  const { setPieceShare, lootPerTile, generateMs } = report.metrics;
  console.log(`${library.name}: set piece share ${setPieceShare.min.toFixed(3)}–${setPieceShare.max.toFixed(3)}, loot per tile ${lootPerTile.mean.toFixed(2)}, generation p50 ${Math.round(generateMs.p50)} ms over ${report.generated} maps`);
  assert.ok(setPieceShare.min > 0.45 && setPieceShare.max < 0.65, JSON.stringify(setPieceShare));
  // Clear margins (20.6) left 36 x 18 at 0.69; the floor catches a collapse.
  assert.ok(lootPerTile.mean > 0.65 && lootPerTile.mean < 1.4, JSON.stringify(lootPerTile));
}

function selectedSeeds(library, params, seeds) {
  const measured = [], defective = [];
  for (const i of seeds) {
    const seed = `size-${library.zoneWidth}-${i}`, start = performance.now();
    const map = generate(seed, params, library), generateMs = performance.now() - start;
    const checked = checkMap(map), tiles = map.layout.slots.length;
    assert.equal(checked.valid, true, `${seed}: ${JSON.stringify(checked.defects)}`);
    measured.push({ generateMs, setPieceShare: map.layout.setPieces.reduce((n, piece) => n + piece.slots.length, 0) / tiles,
      lootPerTile: checked.metrics.loot / tiles });
  }
  return { generated: seeds.length, valid: true, failures: [], defective, metrics: summarizeMetrics(measured) };
}
