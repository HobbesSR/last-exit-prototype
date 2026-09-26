import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace(
    'const nCell = grid[nIndex]!;',
    'const nCell = grid[nIndex]!;\n        if (!nCell) return;'
)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
