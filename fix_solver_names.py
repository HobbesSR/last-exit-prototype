import re

with open("src/solver.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace("WfcCell", "CellDomain")
content = content.replace("WfcGrid", "ConstraintGrid")

with open("src/solver.ts", "w", encoding="utf-8") as f:
    f.write(content)
