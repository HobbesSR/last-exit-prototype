import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace(
    'export function propagate(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[]): boolean {',
    'export function propagate(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], startQueue?: number): boolean {'
)

wfc = wfc.replace(
    'for (let i = 0; i < grid.length; i++) queue.add(i);',
    'if (startQueue === undefined) { for (let i = 0; i < grid.length; i++) queue.add(i); } else { queue.add(startQueue); }'
)

wfc = wfc.replace(
    'if (!propagate(grid, columns, rows, libraryTiles)) return null;',
    'if (!propagate(grid, columns, rows, libraryTiles, state.iterations === 1 ? undefined : undefined /* wait, bestCellIndex is not known here */)) return null;'
)
# Ah wait! solveWfc does propagate at the BEGINNING.
# But wait, solveWfc(clonedGrid, ...) is where the propagate happens!
# I can just call propagate BEFORE solveWfc!
# But actually, solveWfc propagates immediately. 
# We can pass bestCellIndex to solveWfc!
