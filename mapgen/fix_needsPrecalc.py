import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

old_precalc = """
    let nextId = 0;
    for (const opt of allOptions) {
      if (opt.id === undefined) {
        opt.id = nextId++;
        needsPrecalc = true;
      } else {
        if (opt.id >= nextId) nextId = opt.id + 1;
      }
    }
"""

new_precalc = """
    let nextId = 0;
    for (const opt of allOptions) {
      if (opt.id === undefined) {
        opt.id = nextId++;
      } else {
        if (opt.id >= nextId) nextId = opt.id + 1;
      }
    }

    for (const opt of allOptions) {
      if (!(opt as any).validN) {
        needsPrecalc = true;
        break;
      }
    }
"""

wfc = wfc.replace(old_precalc.strip(), new_precalc.strip())

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
