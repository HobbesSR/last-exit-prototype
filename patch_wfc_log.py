import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace(
    'const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random);',
    '// console.log("Trying", opt.templateId, "at", cell.x, cell.y);\n    const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random);'
)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(content)
