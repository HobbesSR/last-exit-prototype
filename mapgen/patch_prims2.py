import re

with open("src/primitives.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace('out[i] = value[i] ?? "any";', 'out[i] = (value[i] ?? "any") as SegmentDeclaration;')

with open("src/primitives.ts", "w", encoding="utf-8") as f:
    f.write(content)
