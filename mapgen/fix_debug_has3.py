import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace(
    'if (!validSet) { console.error("MISSING validSet for", opt, validProp, "needsPrecalc:", needsPrecalc, "id:", opt.id); }',
    'if (!validSet) { console.error("MISSING validSet for", opt, validProp, "id:", opt.id); }'
)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
