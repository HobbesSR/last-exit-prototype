import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = core.replace('const tiles: import("./wfc.ts").TileOption[] = library.tiles.flatMap(', 'const tileOptions: import("./wfc.ts").TileOption[] = library.tiles.flatMap(')
core = core.replace('for (const tOpt of tiles) {', 'for (const tOpt of tileOptions) {')
core = core.replace('const match = tiles.find(t => t.templateId === a.templateId && t.orientation === a.orientation);', 'const match = tileOptions.find(t => t.templateId === a.templateId && t.orientation === a.orientation);')

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
