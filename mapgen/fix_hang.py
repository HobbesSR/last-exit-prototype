import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# Update solveWfc signature
wfc = wfc.replace(
    'export function solveWfc(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], random: () => number, depth: number = 0): WfcGrid | null {',
    'export function solveWfc(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], random: () => number, state: { iterations: number, maxIterations: number } = { iterations: 0, maxIterations: 10000 }): WfcGrid | null {'
)

# Add iteration check
wfc = wfc.replace(
    '  if (!propagate(grid, columns, rows, libraryTiles)) return null;',
    '  if (state.iterations++ > state.maxIterations) return null;\n  if (!propagate(grid, columns, rows, libraryTiles)) return null;'
)

# Fix recursive call
wfc = wfc.replace(
    'const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random, depth + 1);',
    'const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random, state);'
)

# Fix other signature mismatch if it was there (the depth parameter)
wfc = wfc.replace('random, depth + 1', 'random, state')

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
