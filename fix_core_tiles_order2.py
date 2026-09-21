import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

# I need to pull `const tiles: TileOption[] = ...` up BEFORE `cells.map`
# First, let's find it.
match = re.search(r'(const tiles: TileOption\[\] = library\.tiles\.flatMap.*?;\n)', core, flags=re.DOTALL)
if match:
    tiles_decl = match.group(1)
    core = core.replace(tiles_decl, '') # remove it from where it is
    core = core.replace('const wfcGrid: WfcGrid = cells.map((c, i) => {', tiles_decl + '\n      const wfcGrid: WfcGrid = cells.map((c, i) => {')

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
