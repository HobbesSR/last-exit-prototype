import re
with open("src/wfc.ts", "r", encoding="utf-8") as f:
    c = f.read()
c = c.replace('import { TileDesign, Side, Orientation }', 'import type { TileDesign, Side, Orientation }')
with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(c)
