import type { BuilderId, RegionSpec } from './types.ts';

/** Hand-authored macro inputs for the preview/CLI, not a substitute macro generator. */
export function microExample(builder: BuilderId = 'depot', seed = 4217, shape: 'rectangle' | 'l' | 'hole' = 'rectangle'): RegionSpec {
  if (!['rectangle', 'l', 'hole'].includes(shape)) throw new Error('Unknown example region shape.');
  const cells = [];
  for (let y = 0; y < 18; y++) for (let x = 0; x < 24; x++) {
    if (shape === 'l' && x >= 16 && y < 6 || shape === 'hole' && x >= 10 && x <= 13 && y >= 3 && y <= 5) continue;
    cells.push({ x, y });
  }
  return { id: 'micro-lab', seed, builder, cellSize: 40, cells,
    ports: [
      { id: 'hunter-west', side: 'W', start: { x: 0, y: 8 }, length: 2, required: 'hunter', allowed: 'hunter' },
      { id: 'hunter-east', side: 'E', start: { x: 23, y: 8 }, length: 2, required: 'hunter', allowed: 'hunter' },
    ], parameters: { density: 0.55, roomCells: 6, decay: 0.35 }, loot: { budget: builder === 'entry' ? 0 : 8, tier: 1 }, ...(builder === 'entry' ? { entry: { count: 24 } } : {}) };
}
