import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = re.sub(r'const wfcGrid: WfcGrid = cells\.map\(\(c, i\) => \{.*?(const tiles: TileOption\[\] = library\.tiles\.flatMap.*?;\n)', r'\1\n      const wfcGrid: WfcGrid = cells.map((c, i) => {', core, flags=re.DOTALL)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
