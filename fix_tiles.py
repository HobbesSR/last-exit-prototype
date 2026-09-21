import re
with open("src/tiles.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = re.sub(r'blocked\[cellAt\(col, row\)\] = false\]!\.class,\s*\)\s*\?\s*1\s*:\s*0;', 'blocked[cellAt(col, row)] = 0;', content)

with open("src/tiles.ts", "w", encoding="utf-8") as f:
    f.write(content)
