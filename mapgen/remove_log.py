with open("src/wfc.ts", "r", encoding="utf-8") as f:
    c = f.read()
c = c.replace('console.log("Trying", opt.templateId, "at", cell.x, cell.y);', '')
with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(c)
