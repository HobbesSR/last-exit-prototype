import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace(
    '// console.log("Trying", opt.templateId, "at", cell.x, cell.y);',
    'console.log("Trying", opt.templateId, "at", cell.x, cell.y);'
)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(content)
