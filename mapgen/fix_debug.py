import re

with open("debug_wfc_fast.mts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace('// solveWfc(grid, 60, 30, lib.tiles, Math.random, state);', 'solveWfc(grid, 60, 30, lib.tiles, Math.random, state);\nconsole.log("Done");')

with open("debug_wfc_fast.mts", "w", encoding="utf-8") as f:
    f.write(wfc)
