import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace(
    'domain: c === cell ? [opt] : [...c.domain]',
    'domain: c === cell ? [opt] : c.domain'
)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
