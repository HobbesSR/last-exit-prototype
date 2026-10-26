// Read-only inventory of the bundled libraries' possible block-class sources.
// Run: node tools/block-library-audit.mjs > block-library-audit.json
import { CHAIN_LIBRARIES } from '../map/chain.ts';
import { CHAIN_TILE_SIZE, validateLibrary } from '../map/macro/src/chain/library.ts';
import { orientDesign } from '../map/macro/src/chain/declared-grid.ts';
import { REGION_SPAN_LIMIT } from '../map/micro/decomposition/analysis.ts';

const reports = [];

for (const library of CHAIN_LIBRARIES) {
  const name = `${library.zoneWidth}x${library.zoneHeight}`;
  const validation = validateLibrary(library, new Set(Object.values(library.cellClasses).map(rule => rule.regionType)));
  if (!validation.valid) throw new Error(`${name}: invalid library: ${validation.errors.join('; ')}`);
  const failures = [];
  const blockClasses = Object.entries(library.cellClasses).filter(([, rule]) => rule.regionType === 'block').map(([id]) => id);
  if (blockClasses.length !== 1 || blockClasses[0] !== 'block') failures.push('Expected block to be the only class selecting the block strategy.');
  const isBlock = cls => blockClasses.includes(cls);
  const tiles = library.tiles.map(tile => {
    const cells = orientDesign(tile, 0).cells;
    const legend = Object.entries(tile.legend ?? {}).filter(([, cls]) => isBlock(cls));
    const adjacency = Object.entries(tile.segments ?? {}).filter(([, p]) => isBlock(p.adjacency)).map(([segment, p]) => ({ segment, class: p.adjacency }));
    const blockCells = cells.filter(isBlock).length;
    return { id: tile.id, defaultClass: tile.defaultCellClass, fillWeight: tile.weight ?? 1,
      blockCells, explicitBlockLegend: legend, blockAdjacency: adjacency };
  });
  const byId = new Map(tiles.map(tile => [tile.id, tile]));
  const sources = tiles.filter(tile => tile.blockCells || isBlock(tile.defaultClass) || tile.explicitBlockLegend.length || tile.blockAdjacency.length);
  if (tiles.some(tile => tile.blockAdjacency.length)) failures.push('A segment asks an any cell for a block class.');
  if (sources.some(tile => tile.explicitBlockLegend.length)) failures.push('A legend explicitly maps a mark to a block class.');
  if (tiles.some(tile => tile.blockCells > 0 && tile.blockCells < CHAIN_TILE_SIZE ** 2)) failures.push('A tile contains a partial block footprint.');
  if (tiles.some(tile => tile.blockCells > 0 && tile.fillWeight !== 0)) failures.push('A block tile is eligible for ordinary fill.');
  const sets = library.tileSets.map(set => ({ id: set.id, members: set.members,
    blockMembers: set.members.filter(id => byId.get(id)?.blockCells > 0),
    allBlock: set.members.length > 0 && set.members.every(id => byId.get(id)?.blockCells === CHAIN_TILE_SIZE ** 2) }));
  const blockSets = sets.filter(set => set.blockMembers.length);
  if (blockSets.some(set => !set.allBlock)) failures.push('A tile set mixes block and non-block or partial-block designs.');
  const setById = new Map(sets.map(set => [set.id, set]));
  const referenced = new Set();
  const pieces = library.setPieces.flatMap(piece => {
    const slots = piece.tiles.filter(slot => setById.get(slot.tileSetId)?.blockMembers.length);
    if (!slots.length) return [];
    slots.forEach(slot => referenced.add(slot.tileSetId));
    const xs = slots.map(slot => slot.dx), ys = slots.map(slot => slot.dy);
    const minX = Math.min(...xs), minY = Math.min(...ys), width = Math.max(...xs) - minX + 1, height = Math.max(...ys) - minY + 1;
    const coordinates = new Set(slots.map(slot => `${slot.dx},${slot.dy}`));
    const rectangle = coordinates.size === slots.length && coordinates.size === width * height;
    const allBlock = slots.every(slot => setById.get(slot.tileSetId)?.allBlock);
    const cellWidth = width * CHAIN_TILE_SIZE, cellHeight = height * CHAIN_TILE_SIZE;
    if (!rectangle || !allBlock || Math.max(cellWidth, cellHeight) <= REGION_SPAN_LIMIT)
      failures.push(`${piece.id}: block slots are not an exclusively block rectangle exceeding the span limit.`);
    return [{ id: piece.id, slotCount: slots.length, tileSets: [...new Set(slots.map(slot => slot.tileSetId))],
      origin: { x: minX, y: minY }, tileWidth: width, tileHeight: height, cellWidth, cellHeight, rectangle, allBlock }];
  });
  reports.push({ name, blockClasses, tileSources: sources, blockTileSets: blockSets,
    unusedBlockTileSets: blockSets.filter(set => !referenced.has(set.id)).map(set => set.id), setPieces: pieces, failures });
}

const result = { tileSize: CHAIN_TILE_SIZE, fallbackSpanLimit: REGION_SPAN_LIMIT,
  scope: 'Authored library inventory only; placement, clipping, and region merging are not independently verified.', libraries: reports };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (reports.some(report => report.failures.length)) process.exitCode = 1;
