with open("src/core.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace("if (!placements.length) { allPlaced = false; break; }", "if (!placements.length) { console.log('failed on', setPiece.id); allPlaced = false; break; }")

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(content)
