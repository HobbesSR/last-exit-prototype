import { REGION_TYPES } from './region-types.ts';
import type { Cell, CoreElementKind, Portal, RegionBrief } from './types.ts';

/** Small, hand-authored briefs for the region explorer; never used by the map generator. */
export const REGION_SHAPES = [
  { id: 'rectangle', name: 'Rectangle' },
  { id: 'l', name: 'L shape' },
  { id: 'hole', name: 'Hole' },
  { id: 'neck', name: 'Neck' },
  { id: 'cross', name: 'Cross' },
  { id: 'stair', name: 'Stair' },
] as const;

export type RegionShape = typeof REGION_SHAPES[number]['id'];
export interface RegionExampleOptions {
  type?: string;
  seed?: number;
  shape?: RegionShape;
  width?: number;
  height?: number;
  tier?: number;
  northPortal?: boolean;
}

const third = (size: number) => Math.round(size / 3);

function keep(shape: RegionShape, x: number, y: number, width: number, height: number): boolean {
  const left = third(width), right = width - third(width);
  const top = third(height), bottom = height - third(height);
  switch (shape) {
    case 'rectangle': return true;
    case 'l': return x < right || y >= top;
    case 'hole': {
      // At 24 x 18 this is exactly microExample's x=10..13, y=3..5 hole.
      const x0 = Math.round(width * 10 / 24), x1 = Math.max(x0 + 1, Math.round(width * 14 / 24));
      const y0 = Math.round(height * 3 / 18), y1 = Math.max(y0 + 1, Math.round(height * 6 / 18));
      return x < x0 || x >= x1 || y < y0 || y >= y1;
    }
    case 'neck': return x < left || x >= right || y >= top && y < bottom;
    case 'cross': return x >= left && x < right || y >= top && y < bottom;
    case 'stair': return x < right || y >= top && (x < width - Math.max(2, Math.round(width / 6)) || y >= bottom);
  }
}

/** Choose a two-segment outside-boundary run nearest the usual example position. */
function boundaryStart(cells: Set<string>, count: number, target: number, cellAt: (n: number) => string,
  ready: (n: number) => boolean = () => true): number {
  const starts = Array.from({ length: count - 1 }, (_, n) => n)
    .filter(n => cells.has(cellAt(n)) && cells.has(cellAt(n + 1)) && ready(n) && ready(n + 1));
  if (!starts.length) throw new Error('Example shape has no two-cell boundary for a portal.');
  return starts.reduce((best, n) => Math.abs(n - target) < Math.abs(best - target) ? n : best);
}

/** Make a bounded lab brief using real registered region types. */
export function regionExample({ type = 'cover', seed = 4217, shape = 'rectangle', width = 24,
  height = 18, tier = 2, northPortal = false }: RegionExampleOptions = {}): RegionBrief {
  if (typeof type !== 'string' || type.startsWith('example-') || !Object.hasOwn(REGION_TYPES, type))
    throw new RangeError(`Unknown explorer region type ${String(type)}.`);
  if (!REGION_SHAPES.some(entry => entry.id === shape)) throw new RangeError(`Unknown explorer shape ${String(shape)}.`);
  for (const [name, value] of [['width', width], ['height', height]] as const)
    if (!Number.isInteger(value) || value < 8 || value > 48) throw new RangeError(`${name} must be an integer from 8 to 48.`);
  if (!Number.isSafeInteger(seed)) throw new RangeError('seed must be a safe integer.');
  if (!Number.isInteger(tier) || tier < 1 || tier > 5) throw new RangeError('tier must be an integer from 1 to 5.');
  if (typeof northPortal !== 'boolean') throw new TypeError('northPortal must be a boolean.');

  const cells: Cell[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    if (keep(shape, x, y, width, height)) cells.push({ x, y });
  const owned = new Set(cells.map(({ x, y }) => `${x},${y}`));
  const sideY = Math.floor(height / 2) - 1;
  const westY = boundaryStart(owned, height, sideY, y => `0,${y}`);
  const eastY = boundaryStart(owned, height, sideY, y => `${width - 1},${y}`);
  const portals: Portal[] = [
    { id: 'hunter-west', axis: 'v', x: 0, y: westY, length: 2 },
    { id: 'hunter-east', axis: 'v', x: width, y: eastY, length: 2 },
  ];
  if (northPortal) {
    // A two-row approach lets the smallest holed mask's north entrance turn around its hole.
    const northX = boundaryStart(owned, width, Math.round(width * 10 / 24),
      x => `${x},0`, x => owned.has(`${x},1`));
    portals.push({ id: 'contestant-north', axis: 'h', x: northX, y: 0, length: 2 });
  }
  // Type/site pairings follow map/macro/content/common-primitives@4.json cellClasses.
  // Live arrival/departure counts resolve contestantCount/exitCount/hunterCount there;
  // 8/3/3 here are small lab presets (docs 20.5), not the live roster or recipe.
  // Keep new core-bearing types in sync without importing macro into micro.
  const core: Partial<Record<CoreElementKind, number>> = type === 'arrival' ? { spawn: 8 }
    : type === 'departure' ? { exit: 3, 'hunter-spawn': 3 }
      : type === 'charging' ? { charger: 1 }
        : type === 'transit' ? { warp: 1 } : {};
  return { id: 'micro-lab', seed, type, cellSize: 40, cells,
    zones: [{ tier, bonus: 0, lootChance: 0.04, cells: [...cells] }],
    portals, ...(Object.keys(core).length ? { coreElements: core } : {}) };
}
