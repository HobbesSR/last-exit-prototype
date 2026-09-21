import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

trace_logic = """    if (required.size > 1) {
      // console.log("Vertex rejected:", Array.from(required), options.map(o => o ? o.templateId : "null"));
      return false;
    }
    return true;"""

wfc = wfc.replace("return required.size <= 1;", trace_logic)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
