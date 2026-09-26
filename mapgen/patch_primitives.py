import re
with open("src/primitives.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = re.sub(r'isSolidClass\(cells\[cellAt\(col, row\)\]!\.class\);', 'false;', content)

with open("src/primitives.ts", "w", encoding="utf-8") as f:
    f.write(content)
