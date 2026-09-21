import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace('// console.log("Vertex rejected"', 'console.log("Vertex rejected"')

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
