import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace(
    'const validSet = (opt as any)[validProp] as Set<number>;',
    'const validSet = (opt as any)[validProp] as Set<number>;\n        if (!validSet) { console.error("MISSING validSet for", opt, validProp); }'
)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
