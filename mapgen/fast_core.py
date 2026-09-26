import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

old_core = """
        return { x: c.x, y: c.y, domain };
      }
    });

    const solvedGrid = solveWfc(wfcGrid, p.columns, p.rows, library.tiles, random);
"""

new_core = """
        return { x: c.x, y: c.y, domain };
      }
    });

    const cellMap = new Map<string, number>();
    wfcGrid.forEach((c, i) => cellMap.set(`${c.x},${c.y}`, i));
    for (const c of wfcGrid) {
      c.n = cellMap.get(`${c.x},${c.y - 1}`);
      c.s = cellMap.get(`${c.x},${c.y + 1}`);
      c.e = cellMap.get(`${c.x + 1},${c.y}`);
      c.w = cellMap.get(`${c.x - 1},${c.y}`);
      c.tl = cellMap.get(`${c.x - 1},${c.y - 1}`);
      c.tr = cellMap.get(`${c.x},${c.y - 1}`);
      c.bl = cellMap.get(`${c.x - 1},${c.y}`);
    }

    const solvedGrid = solveWfc(wfcGrid, p.columns, p.rows, library.tiles, random);
"""

core = core.replace(old_core.strip(), new_core.strip())
with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
