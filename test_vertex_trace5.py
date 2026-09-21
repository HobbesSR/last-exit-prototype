import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace('return required.size <= 1;', """if (required.size > 1) {
    // console.log("Vertex rejected:", Array.from(required), options.map(o => o ? o.templateId : "null"));
    return false;
  }
  return true;""")

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
