import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace(
    'export function solveWfc(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], random: () => number, state = { iterations: 0, maxIterations: 10000 }): WfcGrid | null {',
    'export function solveWfc(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], random: () => number, state = { iterations: 0, maxIterations: 10000 }, startQueue?: number): WfcGrid | null {'
)

wfc = wfc.replace(
    'if (!propagate(grid, columns, rows, libraryTiles)) return null;',
    'if (!propagate(grid, columns, rows, libraryTiles, startQueue)) return null;'
)

wfc = wfc.replace(
    'const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random, state);',
    'const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random, state, bestCellIndex);'
)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
