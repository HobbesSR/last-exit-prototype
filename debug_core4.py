with open("src/core.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace("if (!allPlaced) continue;", "if (!allPlaced) { console.log('not all placed', attempt); continue; }")

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(content)
