with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

wfc = wfc.replace('_matchEdge(', 'matchEdge(')

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
