import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = core.replace('const wfcGrid: WfcGrid = cells.map((c, i) => {', """const tiles: import("./wfc.ts").TileOption[] = library.tiles.flatMap(t => 
      (t.orientations || [0]).map(o => ({
        templateId: t.id,
        orientation: o as any,
        difficulty: getDifficulty(t),
        weight: t.weight || 1,
        id: undefined as any
      }))
    );
    const wfcGrid: WfcGrid = cells.map((c, i) => {""")

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
